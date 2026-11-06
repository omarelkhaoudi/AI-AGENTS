import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HKIDS_DOCUMENT_TYPES } from "../documents/document-schema.js";
import { dossierOf, latestIssued } from "../documents/document-ledger.js";

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
// (ignored by git), like the Director's plans.

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DEFAULT_WORKSHOP_PATH = join(PROJECT_ROOT, "data", "atelier.json");

export const WORKSHOP_STEPS = Object.freeze([
  Object.freeze({ id: "etude_technique", label: "Étude technique", detail: "plans et fiche de fabrication" }),
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
    }
  });
}

export function createFileWorkshopStore({ path = DEFAULT_WORKSHOP_PATH, clock = () => new Date() } = {}) {
  return createWorkshopStore({
    clock,
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

function createWorkshopStore({ load, save, clock }) {
  // Changes are applied one at a time, so two requests never overwrite each other.
  let queue = Promise.resolve();
  const exclusive = (work) => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };

  return Object.freeze({
    async all() {
      return load();
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
export function createWorkshop({ store, documentService, clock = () => new Date() }) {
  const book = async () => buildWorkshopBook(await documentService.listIssued(), await store.all(), clock());
  const order = async (number) => (await book()).find((entry) => entry.number === String(number).trim()) ?? null;
  return Object.freeze({
    book,
    order,
    async advance(number, stepId, fields) {
      if (!(await order(number))) {
        throw new WorkshopError(`Aucun bon de commande n° ${number} n'a été généré par le cockpit.`, "WORKSHOP_ORDER_NOT_FOUND");
      }
      const { changed } = await store.updateStep(String(number).trim(), stepId, fields);
      return { changed, order: await order(number) };
    }
  });
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
    journal: Object.freeze([...(record.journal ?? [])])
  });
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
