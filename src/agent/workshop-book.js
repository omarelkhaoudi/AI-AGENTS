import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HKIDS_DOCUMENT_TYPES } from "../documents/document-schema.js";
import { dossierOf, latestIssued } from "../documents/document-ledger.js";
import { validateAndPrepareDocument } from "../documents/document-validation.js";
import { HKIDS_FIXED_IDENTITY } from "../documents/hkids-template.js";
import { parseReferenceImage } from "../documents/purchase-order.js";
import { normalizeWhatsAppNumber } from "./whatsapp.js";

// The workshop book: every purchase order validated in the cockpit follows the
// manufacturing route of the specification (section 5), from the technical
// study to delivery and installation. Each step has a status, a person in
// charge, a planned date, an actual date and a note; a journal says who moved
// what, and when.
//
// The progress of an order is the share of steps actually finished, never an
// estimate. An order is flagged when a step is blocked or past its planned date,
// and once installed while part of the sale is still to invoice.
//
// The orders themselves are the purchase orders issued by the cockpit; only
// what happened in the workshop is stored here, as one JSON file under data/
// (ignored by git), like the Director's plans. The photos published for the
// client sit beside it, one file each.
//
// The client follows the order through a link of its own (section 5, client
// access): an unguessable token the direction creates and can switch off. What
// the client sees is built by clientView and nothing else: progress, finished
// steps, the planned delivery, the payment schedule, the published photos and
// the documents of the sale. Never a note, a person in charge or a blocking
// reason: those stay inside the company.
//
// The design office (Hiba's request of 09/11/2026): each order has a chef de
// charge who answers for it, the client's architect when there is one and the
// member of the team who deals with them, and the draughtsman who turns the
// technical sheet into the files of the CNC machine. Those files (G-code, DXF)
// are kept with the order and only reach the machine once the direction has
// validated them: the CNC cut cannot start before. None of this is shown to
// the client.

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DEFAULT_WORKSHOP_PATH = join(PROJECT_ROOT, "data", "atelier.json");

export const WORKSHOP_STEPS = Object.freeze([
  Object.freeze({ id: "etude_technique", label: "Étude technique", detail: "plans et fiche de fabrication" }),
  Object.freeze({ id: "dessin_cnc", label: "Dessin CNC", detail: "G-code du dessinateur, validé avant découpe" }),
  Object.freeze({ id: "approvisionnement", label: "Approvisionnement", detail: "vérification des matières" }),
  Object.freeze({ id: "decoupe_cnc", label: "Découpe CNC", detail: "découpe des panneaux" }),
  Object.freeze({ id: "assemblage", label: "Assemblage", detail: "montage en atelier" }),
  Object.freeze({ id: "finition", label: "Peinture et finition", detail: "contrôle des finitions" }),
  Object.freeze({ id: "controle_qualite", label: "Contrôle qualité", detail: "validation avant expédition" }),
  Object.freeze({ id: "livraison_installation", label: "Livraison et installation", detail: "confirmation client" })
]);
export const WORKSHOP_STEP_IDS = Object.freeze(WORKSHOP_STEPS.map((step) => step.id));
export const WORKSHOP_STATUSES = Object.freeze(["a_faire", "en_cours", "bloquee", "terminee"]);
export const WORKSHOP_STATUS_LABELS = Object.freeze({ a_faire: "à faire", en_cours: "en cours", bloquee: "bloquée", terminee: "terminée" });

// Who answers for an order, beside the person in charge of each step.
export const ORDER_ROLES = Object.freeze([
  Object.freeze({ id: "lead", label: "Chef de charge" }),
  Object.freeze({ id: "architect", label: "Architecte" }),
  Object.freeze({ id: "architectPhone", label: "Téléphone de l'architecte" }),
  Object.freeze({ id: "liaison", label: "Lien avec l'architecte" }),
  Object.freeze({ id: "drafter", label: "Dessinateur" })
]);
export const ORDER_ROLE_IDS = Object.freeze(ORDER_ROLES.map((role) => role.id));

// The machine files of an order, by extension.
export const CNC_FORMATS = Object.freeze({
  gcode: Object.freeze(["nc", "gcode", "ngc", "tap", "cnc", "gc", "iso"]),
  dxf: Object.freeze(["dxf"])
});
export const MAX_CNC_FILE_BYTES = 8 * 1024 * 1024;
export const CNC_FILE_STATUSES = Object.freeze(["a_valider", "valide", "refuse"]);
export const CNC_FILE_STATUS_LABELS = Object.freeze({ a_valider: "à valider", valide: "validé", refuse: "refusé" });

export class WorkshopError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WorkshopError";
    this.code = code;
  }
}

export function createMemoryWorkshopStore({ clock = () => new Date() } = {}) {
  let orders = {};
  return createWorkshopStore({
    clock,
    load: async () => orders,
    save: async (next) => {
      orders = next;
    },
    photoFiles: memoryFolder(),
    cncFiles: memoryFolder()
  });
}

export function createFileWorkshopStore({ path = DEFAULT_WORKSHOP_PATH, photosDir = join(dirname(path), "atelier-photos"), cncDir = join(dirname(path), "atelier-cnc"), clock = () => new Date() } = {}) {
  return createWorkshopStore({
    clock,
    photoFiles: diskFolder(photosDir),
    cncFiles: diskFolder(cncDir),
    load: async () => {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") {
          return {};
        }
        throw error;
      }
    },
    // Written to a temporary file and renamed, so a crash never leaves half a file.
    save: async (orders) => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(orders, null, 2));
      await rename(temporary, path);
    }
  });
}

// Where the files of the orders are kept: photos and machine files, one each.
function memoryFolder() {
  const files = new Map();
  return {
    write: async (name, bytes) => {
      files.set(name, bytes);
    },
    read: async (name) => files.get(name) ?? null,
    remove: async (name) => {
      files.delete(name);
    }
  };
}

function diskFolder(dir) {
  return {
    write: async (name, bytes) => {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), bytes);
    },
    read: async (name) => {
      try {
        return await readFile(join(dir, name));
      } catch (error) {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    remove: async (name) => {
      await unlink(join(dir, name)).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }
  };
}

function createWorkshopStore({ load, save, clock, photoFiles, cncFiles }) {
  // Changes are applied one at a time, so two requests never overwrite each other.
  let queue = Promise.resolve();
  const exclusive = (work) => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };
  // One order's record, changed and saved with a journal line.
  const mutate = (number, change) => exclusive(async () => {
    const orders = await load();
    const key = String(number);
    const order = orders[key] ?? { steps: {}, journal: [] };
    const at = clock().toISOString();
    const outcome = await change(order, at);
    orders[key] = order;
    await save(orders);
    return outcome;
  });

  return Object.freeze({
    async all() {
      return load();
    },

    // The link of the order's client: the active one, or a new token. A link
    // switched off is never switched back on: a new one is made instead.
    async openPortal(number, { by = "direction" } = {}) {
      return mutate(number, (order, at) => {
        if (!order.portal?.active) {
          order.portal = { token: randomBytes(24).toString("base64url"), active: true, createdAt: at, createdBy: by };
          order.journal.push({ at, by, text: "Lien de suivi client créé." });
        }
        return order.portal.token;
      });
    },

    async closePortal(number, { by = "direction" } = {}) {
      return mutate(number, (order, at) => {
        if (order.portal?.active) {
          order.portal = { ...order.portal, active: false, closedAt: at, closedBy: by };
          order.journal.push({ at, by, text: "Lien de suivi client désactivé." });
        }
      });
    },

    // The order an active link belongs to, or null. Compared in constant time.
    async numberForToken(token) {
      const presented = Buffer.from(String(token ?? ""));
      for (const [number, order] of Object.entries(await load())) {
        const known = Buffer.from(order.portal?.active ? order.portal.token : "");
        if (known.length > 0 && known.length === presented.length && timingSafeEqual(known, presented)) {
          return number;
        }
      }
      return null;
    },

    async addPhoto(number, { bytes, format, caption = "", by = "direction" }) {
      const id = randomUUID();
      const file = `${String(number).replace(/[^0-9A-Za-z_-]/g, "_")}_${id}.${format === "png" ? "png" : "jpg"}`;
      await photoFiles.write(file, bytes);
      return mutate(number, (order, at) => {
        order.photos = [...(order.photos ?? []), { id, file, format: format === "png" ? "png" : "jpeg", caption: text(caption), publishedAt: at, by }];
        order.journal.push({ at, by, text: `Photo publiée pour le client${text(caption) ? ` : ${text(caption)}` : ""}.` });
        return id;
      });
    },

    async removePhoto(number, id, { by = "direction" } = {}) {
      const removed = await mutate(number, (order, at) => {
        const photo = (order.photos ?? []).find((entry) => entry.id === id);
        if (photo) {
          order.photos = order.photos.filter((entry) => entry !== photo);
          order.journal.push({ at, by, text: `Photo retirée du suivi client${photo.caption ? ` : ${photo.caption}` : ""}.` });
        }
        return photo ?? null;
      });
      if (removed) {
        await photoFiles.remove(removed.file);
      }
      return Boolean(removed);
    },

    async readPhoto(number, id) {
      const photo = ((await load())[String(number)]?.photos ?? []).find((entry) => entry.id === id);
      const bytes = photo ? await photoFiles.read(photo.file) : null;
      return bytes ? { bytes, format: photo.format } : null;
    },

    // Who answers for the order. Only the roles given change; an empty name
    // removes one.
    async setTeam(number, roles = {}, { by = "direction" } = {}) {
      const next = {};
      for (const role of ORDER_ROLES) {
        if (typeof roles[role.id] !== "string") {
          continue;
        }
        let value = text(roles[role.id]);
        if (role.id === "architectPhone" && value) {
          value = normalizeWhatsAppNumber(value);
          if (value === null) {
            throw new WorkshopError("Numéro de l'architecte illisible : écrire par exemple 06 12 34 56 78 ou +212 6 12 34 56 78.", "WORKSHOP_PHONE_INVALID");
          }
        }
        next[role.id] = value;
      }
      return mutate(number, (order, at) => {
        const team = { ...order.team };
        const changes = [];
        for (const role of ORDER_ROLES) {
          if (!(role.id in next) || next[role.id] === (team[role.id] ?? "")) {
            continue;
          }
          if (next[role.id]) {
            team[role.id] = next[role.id];
            changes.push(`${role.label.toLowerCase()} : ${next[role.id]}`);
          } else {
            delete team[role.id];
            changes.push(`${role.label.toLowerCase()} retiré(e)`);
          }
        }
        if (changes.length === 0) {
          return false;
        }
        order.team = team;
        order.journal.push({ at, by, text: `Équipe de la commande : ${changes.join(" ; ")}.` });
        return true;
      });
    },

    // A machine file from the draughtsman, once the technical sheet is done.
    // It waits for the direction's validation; the drawing step is under way
    // until then.
    async addCncFile(number, { bytes, name, format, note = "", by = "direction" }) {
      return mutate(number, async (order, at) => {
        if (order.steps.etude_technique?.status !== "terminee") {
          throw new WorkshopError("La fiche technique vient d'abord : terminez l'étude technique avant de déposer le dessin CNC.", "WORKSHOP_STUDY_NOT_DONE");
        }
        const id = randomUUID();
        const file = `${String(number).replace(/[^0-9A-Za-z_-]/g, "_")}_${id}.${extensionOf(name)}`;
        await cncFiles.write(file, bytes);
        order.cnc = [...(order.cnc ?? []), { id, file, name, format, size: bytes.length, note: text(note), status: "a_valider", depositedAt: at, by }];
        const drawing = { status: "a_faire", responsible: "", plannedDate: null, startedDate: null, doneDate: null, note: "", ...order.steps.dessin_cnc };
        if (drawing.status !== "en_cours") {
          drawing.status = "en_cours";
          drawing.startedDate ??= at.slice(0, 10);
          drawing.doneDate = null;
        }
        drawing.responsible ||= order.team?.drafter ?? "";
        drawing.updatedAt = at;
        order.steps.dessin_cnc = drawing;
        order.journal.push({ at, by, text: `Dessin CNC : fichier « ${name} » déposé, à valider par la direction${text(note) ? ` (${text(note)})` : ""}.` });
        return id;
      });
    },

    // The direction's word on a machine file. Once every file is decided and
    // one is valid, the drawing is finished; a refused file says why.
    async decideCncFile(number, id, { approve, reason = "", by = "direction" }) {
      if (!approve && !text(reason)) {
        throw new WorkshopError("Un fichier CNC refusé doit dire pourquoi, pour que le dessinateur le corrige.", "WORKSHOP_CNC_REASON_MISSING");
      }
      return mutate(number, (order, at) => {
        const entry = (order.cnc ?? []).find((candidate) => candidate.id === id);
        if (!entry) {
          throw new WorkshopError("Fichier CNC introuvable.", "WORKSHOP_CNC_NOT_FOUND");
        }
        if (entry.status !== "a_valider") {
          throw new WorkshopError(`Ce fichier est déjà ${CNC_FILE_STATUS_LABELS[entry.status]}.`, "WORKSHOP_CNC_ALREADY_DECIDED");
        }
        Object.assign(entry, { status: approve ? "valide" : "refuse", decidedAt: at, decidedBy: by, ...(approve ? {} : { reason: text(reason) }) });
        order.journal.push({ at, by, text: approve ? `Dessin CNC : fichier « ${entry.name} » validé pour la machine.` : `Dessin CNC : fichier « ${entry.name} » refusé : ${text(reason)}.` });
        const files = order.cnc;
        if (files.some((candidate) => candidate.status === "valide") && !files.some((candidate) => candidate.status === "a_valider")) {
          const drawing = order.steps.dessin_cnc ?? { status: "a_faire", responsible: "", plannedDate: null, startedDate: null, note: "" };
          if (drawing.status !== "terminee") {
            order.steps.dessin_cnc = { ...drawing, status: "terminee", doneDate: at.slice(0, 10), updatedAt: at };
            order.journal.push({ at, by, text: "Dessin CNC : en cours → terminée." });
          }
        }
        return { ...entry };
      });
    },

    async readCncFile(number, id) {
      const entry = ((await load())[String(number)]?.cnc ?? []).find((candidate) => candidate.id === id);
      const bytes = entry ? await cncFiles.read(entry.file) : null;
      return bytes ? { bytes, name: entry.name, format: entry.format, status: entry.status } : null;
    },

    // One step of one order. Only the fields given change; dates are JJ/MM/AAAA
    // or AAAA-MM-JJ. A finished step without a date is finished today, a blocked
    // one says why.
    async updateStep(number, stepId, { status = "", responsible = "", plannedDate = "", doneDate = "", note = "", by = "direction" } = {}) {
      const step = WORKSHOP_STEPS.find((entry) => entry.id === stepId);
      if (!step) {
        throw new WorkshopError(`Étape inconnue : ${stepId}. Étapes : ${WORKSHOP_STEP_IDS.join(", ")}.`, "WORKSHOP_STEP_UNKNOWN");
      }
      if (status && !WORKSHOP_STATUSES.includes(status)) {
        throw new WorkshopError(`Statut inconnu : ${status}. Statuts : ${WORKSHOP_STATUSES.join(", ")}.`, "WORKSHOP_STATUS_UNKNOWN");
      }
      if (status === "bloquee" && !text(note)) {
        throw new WorkshopError("Une étape bloquée doit dire ce qui la bloque (note).", "WORKSHOP_BLOCK_REASON_MISSING");
      }
      const planned = plannedDate ? isoDay(plannedDate) : null;
      const done = doneDate ? isoDay(doneDate) : null;
      if ((plannedDate && !planned) || (doneDate && !done)) {
        throw new WorkshopError("Date illisible : écrire JJ/MM/AAAA.", "WORKSHOP_DATE_INVALID");
      }

      return exclusive(async () => {
        const orders = await load();
        const key = String(number);
        const order = orders[key] ?? { steps: {}, journal: [] };
        const current = { status: "a_faire", responsible: "", plannedDate: null, startedDate: null, doneDate: null, note: "", ...order.steps[stepId] };
        refuseWithoutValidatedFile(order, stepId, current.status, status);
        const at = clock().toISOString();
        const today = at.slice(0, 10);
        const changes = [];
        if (status && status !== current.status) {
          changes.push(`${WORKSHOP_STATUS_LABELS[current.status]} → ${WORKSHOP_STATUS_LABELS[status]}`);
          // What blocked the step no longer describes it once it moves on.
          if (current.status === "bloquee" && !text(note)) {
            current.note = "";
          }
          current.status = status;
          if (status === "en_cours" && !current.startedDate) {
            current.startedDate = today;
          }
          if (status === "terminee") {
            current.doneDate = done ?? today;
          } else {
            current.doneDate = null;
          }
        } else if (done && current.status === "terminee" && done !== current.doneDate) {
          current.doneDate = done;
          changes.push(`terminée le ${frenchDay(done)}`);
        }
        if (text(responsible) && text(responsible) !== current.responsible) {
          current.responsible = text(responsible);
          changes.push(`responsable : ${current.responsible}`);
        }
        if (planned && planned !== current.plannedDate) {
          current.plannedDate = planned;
          changes.push(`prévue le ${frenchDay(planned)}`);
        }
        if (text(note) && text(note) !== current.note) {
          current.note = text(note);
          changes.push(`note : ${current.note}`);
        }
        if (changes.length === 0) {
          return { order, changed: false };
        }
        current.updatedAt = at;
        order.steps[stepId] = current;
        order.journal.push({ at, by, text: `${step.label} : ${changes.join(" ; ")}.` });
        orders[key] = order;
        await save(orders);
        return { order, changed: true };
      });
    }
  });
}

// The workshop of the cockpit: the issued purchase orders, read from the
// document service, and what happened to them, read from the store. A step is
// only moved for an order that was actually issued.
export function createWorkshop({ store, documentService, clock = () => new Date(), publicBaseUrl = "" }) {
  const book = async () => buildWorkshopBook(await documentService.listIssued(), await store.all(), clock());
  const order = async (number) => (await book()).find((entry) => entry.number === String(number).trim()) ?? null;
  const issuedOrder = async (number) => {
    const found = await order(number);
    if (!found) {
      throw new WorkshopError(`Aucun bon de commande n° ${number} n'a été généré par le cockpit.`, "WORKSHOP_ORDER_NOT_FOUND");
    }
    return found;
  };
  // A link that does not exist and a link switched off get the same answer, so
  // nothing can be learnt by trying links.
  const clientOrder = async (token) => {
    const number = await store.numberForToken(token);
    return number ? order(number) : null;
  };

  async function clientView(token) {
    const current = await clientOrder(token);
    if (!current) {
      return null;
    }
    const issued = await documentService.listIssued();
    const dossier = dossierOf(issued, { type: HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER, number: current.number });
    const delivery = current.steps.at(-1);
    const record = (await store.all())[current.number];
    return Object.freeze({
      company: Object.freeze({ name: HKIDS_FIXED_IDENTITY.companyName, phone: HKIDS_FIXED_IDENTITY.phone, email: HKIDS_FIXED_IDENTITY.email }),
      order: Object.freeze({ number: current.number, date: current.date, object: current.object, client: current.client }),
      progress: current.progress,
      finished: current.finished,
      // A blocked step is a step under way for the client: why it is blocked
      // stays inside the company.
      steps: Object.freeze(current.steps.map((step) => Object.freeze({
        label: step.label,
        state: step.status === "terminee" ? "terminee" : step.status === "a_faire" ? "a_venir" : "en_cours",
        doneDate: step.status === "terminee" ? step.doneDate : null
      }))),
      plannedDelivery: delivery.status === "terminee" ? null : delivery.plannedDate,
      schedule: await paymentSchedule(current.number),
      photos: Object.freeze((record?.photos ?? []).map((photo) => Object.freeze({ id: photo.id, caption: photo.caption, publishedAt: photo.publishedAt }))),
      documents: Object.freeze(clientDocuments(dossier, current.number))
    });
  }

  // The instalments printed on the order, when its content was kept.
  async function paymentSchedule(number) {
    const issued = await documentService.readIssued(HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER, number);
    if (issued?.source !== "content") {
      return Object.freeze([]);
    }
    try {
      const prepared = validateAndPrepareDocument(issued.input);
      return Object.freeze((prepared.payment?.instalments ?? []).map((part) => Object.freeze({ percent: part.percent, due: part.due, amount: part.amount })));
    } catch {
      return Object.freeze([]);
    }
  }

  return Object.freeze({
    book,
    order,
    async advance(number, stepId, fields) {
      await issuedOrder(number);
      const { changed } = await store.updateStep(String(number).trim(), stepId, fields);
      return { changed, order: await order(number) };
    },

    // The address of the client's link: absolute when the site's address is
    // known (PUBLIC_BASE_URL), a path otherwise.
    async openPortal(number, { by = "direction" } = {}) {
      await issuedOrder(number);
      return portalLink(await store.openPortal(String(number).trim(), { by }), publicBaseUrl);
    },

    async closePortal(number, { by = "direction" } = {}) {
      await issuedOrder(number);
      await store.closePortal(String(number).trim(), { by });
      return order(number);
    },

    async publishPhoto(number, dataUrl, { caption = "", by = "direction" } = {}) {
      await issuedOrder(number);
      const { image, error } = parseReferenceImage(dataUrl);
      if (!image) {
        throw new WorkshopError(error === "REFERENCE_IMAGE_TOO_LARGE" ? "La photo dépasse 3 Mo." : "La photo n'a pas pu être lue (JPEG ou PNG attendu).", "WORKSHOP_PHOTO_INVALID");
      }
      return store.addPhoto(String(number).trim(), { bytes: image.bytes, format: image.format, caption, by });
    },

    async removePhoto(number, id, { by = "direction" } = {}) {
      await issuedOrder(number);
      return store.removePhoto(String(number).trim(), id, { by });
    },

    async setTeam(number, roles, { by = "direction" } = {}) {
      await issuedOrder(number);
      const changed = await store.setTeam(String(number).trim(), roles, { by });
      return { changed, order: await order(number) };
    },

    // content: the file as base64 (or bytes), name: its name with extension.
    async depositCncFile(number, { content, name, note = "", by = "direction" }) {
      await issuedOrder(number);
      const upload = readCncUpload(content, name);
      return store.addCncFile(String(number).trim(), { ...upload, note, by });
    },

    async decideCncFile(number, id, { approve, reason = "", by = "direction" }) {
      await issuedOrder(number);
      return store.decideCncFile(String(number).trim(), id, { approve, reason, by });
    },

    async readCncFile(number, id) {
      await issuedOrder(number);
      return store.readCncFile(String(number).trim(), id);
    },

    clientView,

    async clientPhoto(token, id) {
      const current = await clientOrder(token);
      return current ? store.readPhoto(current.number, id) : null;
    },

    // A document of the client's sale, and no other: what the view lists is
    // all the link opens.
    async clientDocument(token, type, number) {
      const view = await clientView(token);
      const listed = view?.documents.find((entry) => entry.type === type && entry.number === String(number));
      return listed ? documentService.readIssuedPdf(type, listed.number) : null;
    }
  });
}

export function portalLink(token, publicBaseUrl = "") {
  const path = `/suivi/${token}`;
  const base = text(publicBaseUrl).replace(/\/+$/, "");
  return Object.freeze({ path, url: base ? `${base}${path}` : null });
}

const CLIENT_DOCUMENT_LABELS = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.QUOTE]: "Devis",
  [HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER]: "Bon de commande",
  [HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE]: "Bon de livraison",
  [HKIDS_DOCUMENT_TYPES.INVOICE]: "Facture"
});

// The documents of the client's own sale: its quote, this order, its delivery
// notes and its invoices, once each.
function clientDocuments(dossier, orderNumber) {
  const entries = [
    ...(dossier?.quote ? [dossier.quote] : []),
    { type: HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER, number: orderNumber },
    ...(dossier?.deliveryNotes ?? []),
    ...(dossier?.invoices ?? [])
  ];
  const seen = new Set();
  return entries
    .filter((entry) => {
      const key = `${entry.type}:${entry.number}`;
      return seen.has(key) ? false : seen.add(key);
    })
    .map((entry) => Object.freeze({ type: entry.type, number: String(entry.number), label: `${CLIENT_DOCUMENT_LABELS[entry.type]} n° ${entry.number}` }));
}

// The book as the cockpit and the agents read it: one entry per purchase order
// issued, with its route, its progress, the documents of its sale and its alerts.
export function buildWorkshopBook(issued, records, today = new Date()) {
  const day = today.toISOString().slice(0, 10);
  return latestIssued(issued, HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER)
    .map((order) => workshopOrder(order, records[order.number], issued, day))
    .sort((a, b) => (a.finished === b.finished ? Number(b.number) - Number(a.number) : a.finished ? 1 : -1));
}

function workshopOrder(order, record = { steps: {}, journal: [] }, issued, day) {
  const steps = WORKSHOP_STEPS.map((step) => {
    const state = { status: "a_faire", responsible: "", plannedDate: null, startedDate: null, doneDate: null, note: "", ...record.steps?.[step.id] };
    return Object.freeze({
      id: step.id,
      label: step.label,
      detail: step.detail,
      ...state,
      late: Boolean(state.plannedDate && state.status !== "terminee" && state.plannedDate < day)
    });
  });
  const done = steps.filter((step) => step.status === "terminee").length;
  const current = steps.find((step) => step.status !== "terminee") ?? null;
  const dossier = dossierOf(issued, { type: HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER, number: order.number });
  const finished = done === steps.length;

  const alerts = [];
  for (const step of steps) {
    if (step.status === "bloquee") {
      alerts.push(`${step.label} bloquée : ${step.note}`);
    }
    if (step.late) {
      alerts.push(`${step.label} prévue le ${frenchDay(step.plannedDate)}, pas terminée`);
    }
  }
  const cnc = (record.cnc ?? []).map((entry) => Object.freeze({
    id: entry.id,
    name: entry.name,
    format: entry.format,
    size: entry.size,
    note: entry.note ?? "",
    status: entry.status,
    depositedAt: entry.depositedAt,
    by: entry.by,
    decidedAt: entry.decidedAt ?? null,
    decidedBy: entry.decidedBy ?? null,
    reason: entry.reason ?? ""
  }));
  for (const entry of cnc.filter((candidate) => candidate.status === "a_valider")) {
    alerts.push(`Fichier CNC « ${entry.name} » à valider par la direction avant la découpe`);
  }
  // Only an order made from a quote can tell: invoices name their quote, never
  // the order.
  if (finished && dossier?.quoteNumber && dossier.remaining > 0) {
    alerts.push(`Installée, reste à facturer ${dossier.remaining} DH`);
  }

  return Object.freeze({
    number: order.number,
    date: order.date,
    client: order.client,
    object: order.object ?? "",
    totalTtc: order.totalTtc,
    quoteNumber: dossier?.quoteNumber ?? null,
    deliveryNotes: (dossier?.deliveryNotes ?? []).map((entry) => entry.number),
    invoices: (dossier?.invoices ?? []).map((entry) => entry.number),
    invoiced: dossier?.invoiced ?? 0,
    remaining: dossier?.remaining ?? null,
    steps: Object.freeze(steps),
    progress: Object.freeze({ done, total: steps.length, percent: Math.round((done / steps.length) * 100) }),
    currentStep: current ? current.label : null,
    status: finished ? "livrée et installée"
      : steps.some((step) => step.status === "bloquee") ? "bloquée"
        : steps.some((step) => step.late) ? "en retard"
          : steps.some((step) => step.status !== "a_faire") ? "en cours"
            : "à lancer",
    finished,
    alerts: Object.freeze(alerts),
    team: Object.freeze(Object.fromEntries(ORDER_ROLE_IDS.map((id) => [id, record.team?.[id] ?? ""]))),
    cnc: Object.freeze(cnc),
    portal: record.portal?.active ? Object.freeze({ path: portalLink(record.portal.token).path, createdAt: record.portal.createdAt }) : null,
    photos: Object.freeze((record.photos ?? []).map((photo) => Object.freeze({ id: photo.id, caption: photo.caption, publishedAt: photo.publishedAt }))),
    journal: Object.freeze([...(record.journal ?? [])])
  });
}

// The CNC cut, and the end of the drawing, wait for a machine file the
// direction validated. A cut already under way before this rule may finish.
function refuseWithoutValidatedFile(order, stepId, from, to) {
  const files = order.cnc ?? [];
  if (stepId === "decoupe_cnc" && ["en_cours", "terminee"].includes(to) && !["en_cours", "terminee"].includes(from) && !files.some((entry) => entry.status === "valide")) {
    throw new WorkshopError("Aucun fichier CNC validé pour cette commande : le G-code du dessinateur doit être validé par la direction avant la découpe.", "WORKSHOP_CNC_NOT_VALIDATED");
  }
  if (stepId === "dessin_cnc" && to === "terminee" && from !== "terminee" && (!files.some((entry) => entry.status === "valide") || files.some((entry) => entry.status === "a_valider"))) {
    throw new WorkshopError("Le dessin CNC se termine quand la direction a validé son fichier (G-code ou DXF) dans le cockpit.", "WORKSHOP_CNC_NOT_VALIDATED");
  }
}

// A machine file as sent: its format told by its extension, and its content
// checked to be what the extension says, so a photo or a document renamed .nc
// never reaches the machine.
export function readCncUpload(content, name) {
  const fileName = String(name ?? "").split(/[\\/]/).pop().replace(/[^\p{L}\p{N} ._()-]/gu, "_").trim().slice(-120);
  const extension = extensionOf(fileName);
  const format = Object.entries(CNC_FORMATS).find(([, extensions]) => extensions.includes(extension))?.[0];
  if (!fileName || !format) {
    throw new WorkshopError(`Fichier CNC attendu : G-code (.${CNC_FORMATS.gcode.join(", .")}) ou DXF (.dxf).`, "WORKSHOP_CNC_FORMAT");
  }
  const bytes = Buffer.isBuffer(content) ? content : typeof content === "string" ? Buffer.from(content.replace(/^data:[^,]*,/, ""), "base64") : null;
  if (!bytes || bytes.length === 0) {
    throw new WorkshopError("Le fichier CNC est vide.", "WORKSHOP_CNC_EMPTY");
  }
  if (bytes.length > MAX_CNC_FILE_BYTES) {
    throw new WorkshopError("Le fichier CNC dépasse 8 Mo.", "WORKSHOP_CNC_TOO_LARGE");
  }
  const head = bytes.subarray(0, 64 * 1024);
  const readable = !head.includes(0);
  const looksRight = format === "gcode"
    ? readable && /(^|[\s%(])[GM]\s?\d/im.test(head.toString("latin1"))
    : head.subarray(0, 18).toString("latin1") === "AutoCAD Binary DXF" || (readable && /^\s*0\s*[\r\n]+\s*SECTION/m.test(head.toString("latin1")));
  if (!looksRight) {
    throw new WorkshopError(`« ${fileName} » ne ressemble pas à un fichier ${format === "gcode" ? "G-code" : "DXF"} : vérifiez le fichier du dessinateur.`, "WORKSHOP_CNC_CONTENT");
  }
  return { bytes, name: fileName, format };
}

function extensionOf(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name ?? ""));
  return match ? match[1].toLowerCase() : "";
}

function isoDay(value) {
  const french = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value).trim());
  const iso = french ? `${french[3]}-${french[2]}-${french[1]}` : String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return null;
  }
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

export function frenchDay(iso) {
  const [year, month, day] = String(iso ?? "").split("-");
  return day ? `${day}/${month}/${year}` : "";
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
