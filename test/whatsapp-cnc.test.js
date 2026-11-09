import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { createMemoryTeamBook } from "../src/agent/team-book.js";
import { createMemoryWhatsAppInbox } from "../src/agent/whatsapp-inbox.js";
import { createMemoryWorkshopStore, createWorkshop } from "../src/agent/workshop-book.js";
import { loadWhatsAppCloudConfig } from "../src/integrations/whatsapp-cloud.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// The draughtsman sends the G-code of an order to the company's WhatsApp
// number; it goes on the order and waits for the direction's validation, which
// is told at once. Invented people, numbers and figures only.

const clock = () => new Date("2026-11-09T10:00:00Z");
const ENV = Object.freeze({
  WHATSAPP_ACCESS_TOKEN: "test-access",
  WHATSAPP_PHONE_NUMBER_ID: "1234567890",
  WHATSAPP_VERIFY_TOKEN: "test-verify",
  WHATSAPP_APP_SECRET: "test-secret",
  WHATSAPP_OWNER_NUMBERS: "06 61 00 00 01, 06 61 00 00 02"
});
const OWNER = "212661000001";
const OTHER_OWNER = "212661000002";
const DRAFTER = "212670000003";
const GCODE = Buffer.from("%\nG21 G90\nG0 X0 Y0\nG1 X600 F1200\nM30\n%\n");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "hkids-whatsapp-cnc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const client = { name: "Client Exemple", address: "Marrakech" };
const quote = {
  documentType: "quote", documentNumber: "170", date: "02/11/2026", object: "Lit cabane", client,
  items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: 3750, amountHt: 3750 }],
  totals: { totalHt: 3750, tva: 750, totalTtc: 4500 },
  payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
};
const order = (number) => ({ ...quote, documentType: "purchase_order", documentNumber: number, date: "03/11/2026", payment: { termsRule: "hkids-po-50-50" }, specifications: ["Bois clair"], quoteReference: "170" });

async function documentsWith(t, ...numbers) {
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: await tempDir(t) });
  for (const input of [quote, ...numbers.map(order)]) {
    const preview = await documents.preview(input);
    await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true });
  }
  return documents;
}

function inbound(from, message, id) {
  return { object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { contacts: [{ wa_id: from, profile: { name: "" } }], messages: [{ from, id, timestamp: "1762682400", ...message }] } }] }] };
}
const fileMessage = (mediaId, filename, caption = "") => ({ type: "document", document: { id: mediaId, mime_type: "application/octet-stream", filename, ...(caption ? { caption } : {}) } });
const textMessage = (body) => ({ type: "text", text: { body } });

function signed(body) {
  const raw = JSON.stringify(body);
  return { payload: raw, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", ENV.WHATSAPP_APP_SECRET).update(raw).digest("hex")}` } };
}

// Meta's Graph API, as far as these tests need it.
function fakeMeta(media) {
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    if (!init.body) {
      const file = /^https:\/\/lookaside\.example\/(.+)$/.exec(url)?.[1];
      const id = file ? null : /\/(media-[\w-]+)$/.exec(url)?.[1];
      if (file && media[file]) {
        return { ok: true, status: 200, arrayBuffer: async () => media[file] };
      }
      if (id && media[id]) {
        return { ok: true, status: 200, json: async () => ({ url: `https://lookaside.example/${id}`, mime_type: "application/octet-stream", file_size: media[id].length }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: { code: 100 } }) };
    }
    const body = JSON.parse(init.body);
    sent.push({ to: body.to, text: body.text.body });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.out.${sent.length}` }] }) };
  };
  return { sent, fetchImpl };
}

async function setUp(t, { numbers = ["171"], studyDone = true, drafterOf = ["171"] } = {}) {
  const documents = await documentsWith(t, ...numbers);
  const workshopStore = createMemoryWorkshopStore({ clock });
  const workshop = createWorkshop({ store: workshopStore, documentService: documents, clock });
  for (const number of drafterOf) {
    await workshop.setTeam(number, { drafter: "Karim", drafterPhone: "06 70 00 00 03" });
  }
  if (studyDone) {
    for (const number of numbers) {
      await workshop.advance(number, "etude_technique", { status: "terminee" });
    }
  }
  const meta = fakeMeta({ "media-g1": GCODE, "media-g2": GCODE, "media-photo": JPEG });
  const chats = [];
  const teamBook = createMemoryTeamBook({ clock, agents: SPECIALIST_IDS });
  const { app } = await buildAuthenticatedApi({
    repository: new InMemoryRepository(),
    documentService: documents,
    workshopStore,
    teamBook,
    directorAgent: { isConfigured: () => true, chat: async (request) => (chats.push(request), { conversationId: "c1", reply: "ok", messages: [], documents: [], agentRuns: [] }) },
    whatsAppConfig: loadWhatsAppCloudConfig(ENV),
    whatsAppStore: createMemoryWhatsAppInbox({ clock }),
    whatsAppFetch: meta.fetchImpl,
    whatsAppTranscriber: null,
    clock
  });
  t.after(() => app.close());
  const deliver = async (from, message, id) => {
    assert.equal((await app.inject({ method: "POST", url: "/webhooks/whatsapp", ...signed(inbound(from, message, id)) })).statusCode, 200);
    await app.whatsApp.idle();
  };
  return { app, workshop, meta, chats, teamBook, deliver };
}

test("the draughtsman's G-code sent on WhatsApp goes on their order, and the direction is told to validate it", async (t) => {
  const { workshop, meta, chats, teamBook, deliver } = await setUp(t);

  await deliver(DRAFTER, fileMessage("media-g1", "panneaux-lit.nc", "MDF 18 mm"), "wamid.1");

  const current = await workshop.order("171");
  assert.deepEqual(current.cnc.map((file) => [file.name, file.status, file.by, file.note]), [["panneaux-lit.nc", "a_valider", "Karim", "MDF 18 mm"]]);
  assert.equal(current.steps.find((step) => step.id === "dessin_cnc").status, "en_cours");
  assert.equal(chats.length, 0, "a machine file is not a message for the Director");
  assert.deepEqual(meta.sent.map((message) => message.to), [DRAFTER, OWNER, OTHER_OWNER]);
  assert.equal(meta.sent[0].text, "Bien reçu, Karim. « panneaux-lit.nc » est enregistré sur le BC n° 171 (Client Exemple). Il attend la validation de la direction ; la découpe commencera après.");
  assert.equal(meta.sent[1].text, "Karim a envoyé le fichier CNC « panneaux-lit.nc » pour le BC n° 171 (Client Exemple) : à valider dans le cockpit, vue Atelier, avant la découpe.");
  assert.ok((await teamBook.activity({ agent: "production" })).some((entry) => entry.text.includes("fichier CNC « panneaux-lit.nc » reçu de Karim par WhatsApp")));

  // Words from the draughtsman are a report to Production.
  await deliver(DRAFTER, textMessage("Le G-code du tiroir arrive demain"), "wamid.2");
  const report = (await teamBook.activity({ agent: "production" })).find((entry) => entry.kind === "compte_rendu");
  assert.equal(report.text, "Compte rendu de Karim par WhatsApp : Le G-code du tiroir arrive demain");
});

test("a draughtsman of several orders names one, and reaches only their own", async (t) => {
  const { workshop, meta, deliver } = await setUp(t, { numbers: ["171", "172", "173"], drafterOf: ["171", "172"] });

  await deliver(DRAFTER, fileMessage("media-g1", "panneaux.nc"), "wamid.1");
  assert.equal(meta.sent.at(-1).text, "Pour quel bon de commande ? Vous dessinez les BC n° 172, 171. Renvoyez le fichier avec « BC 172 » en légende.");

  await deliver(DRAFTER, fileMessage("media-g1", "panneaux.nc", "BC 173"), "wamid.2");
  assert.equal(meta.sent.at(-1).text, "Vous n'êtes pas enregistré comme dessinateur du BC n° 173. Vos commandes en cours : BC n° 172, 171.");
  assert.deepEqual((await workshop.order("173")).cnc, []);

  await deliver(DRAFTER, fileMessage("media-g2", "BC171_tiroirs.nc"), "wamid.3");
  assert.deepEqual((await workshop.order("171")).cnc.map((file) => file.name), ["BC171_tiroirs.nc"], "the order can be named in the file's name");
  assert.deepEqual((await workshop.order("172")).cnc, []);
});

test("a file that cannot go on the order says why, and nothing is recorded", async (t) => {
  const { workshop, meta, deliver } = await setUp(t, { studyDone: false });

  await deliver(DRAFTER, fileMessage("media-g1", "panneaux.nc"), "wamid.1");
  assert.equal(meta.sent.at(-1).text, "Fichier non enregistré : La fiche technique vient d'abord : terminez l'étude technique avant de déposer le dessin CNC.");

  await workshop.advance("171", "etude_technique", { status: "terminee" });
  await deliver(DRAFTER, fileMessage("media-photo", "photo.nc"), "wamid.2");
  assert.equal(meta.sent.at(-1).text, "Fichier non enregistré : « photo.nc » ne ressemble pas à un fichier G-code : vérifiez le fichier du dessinateur.");
  assert.deepEqual((await workshop.order("171")).cnc, []);
  assert.equal(meta.sent.filter((message) => message.to === OWNER).length, 0, "the direction is told only of a file to validate");
});

test("the direction can send a G-code too; a stranger's is only kept for the cockpit", async (t) => {
  const { workshop, meta, chats, deliver } = await setUp(t, { drafterOf: [] });

  await deliver("212699999999", fileMessage("media-g1", "panneaux.nc", "BC 171"), "wamid.1");
  assert.deepEqual((await workshop.order("171")).cnc, []);
  assert.equal(meta.sent.length, 0, "nobody answers a stranger automatically");

  await deliver(OWNER, fileMessage("media-g1", "panneaux.nc", "bon de commande n° 171"), "wamid.2");
  assert.deepEqual((await workshop.order("171")).cnc.map((file) => [file.name, file.by]), [["panneaux.nc", "La direction"]]);
  assert.deepEqual(meta.sent.map((message) => message.to), [OWNER, OTHER_OWNER], "the other owner is told, not the sender");
  assert.equal(chats.length, 0);
});
