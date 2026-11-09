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

// Each step of an order that gets blocked or late is told on WhatsApp to the
// order's chef de charge, once, and their answer reaches Production as a
// report. Invented people, numbers and figures only.

const clock = () => new Date("2026-11-09T10:00:00Z");
const ENV = Object.freeze({
  WHATSAPP_ACCESS_TOKEN: "test-access",
  WHATSAPP_PHONE_NUMBER_ID: "1234567890",
  WHATSAPP_VERIFY_TOKEN: "test-verify",
  WHATSAPP_APP_SECRET: "test-secret",
  WHATSAPP_OWNER_NUMBERS: "06 61 00 00 01"
});
const LEAD = "212670000004";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "hkids-lead-alerts-"));
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

function fakeMeta({ refuse = null } = {}) {
  const sent = [];
  const fetchImpl = async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    sent.push({ to: body.to, text: body.text.body });
    if (refuse && body.to === refuse) {
      return { ok: false, status: 400, json: async () => ({ error: { code: 131047, message: "Re-engagement message" } }) };
    }
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.out.${sent.length}` }] }) };
  };
  return { sent, fetchImpl };
}

async function setUp(t, { meta = fakeMeta() } = {}) {
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: await tempDir(t) });
  for (const input of [quote, order("171"), order("172")]) {
    const preview = await documents.preview(input);
    await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true });
  }
  const workshopStore = createMemoryWorkshopStore({ clock });
  const workshop = createWorkshop({ store: workshopStore, documentService: documents, clock });
  await workshop.setTeam("171", { lead: "Samir", leadPhone: "06 70 00 00 04" });
  await workshop.setTeam("172", { lead: "Youssef" });
  const teamBook = createMemoryTeamBook({ clock, agents: SPECIALIST_IDS });
  const { app, inject } = await buildAuthenticatedApi({
    repository: new InMemoryRepository(),
    documentService: documents,
    workshopStore,
    teamBook,
    directorAgent: { isConfigured: () => true, chat: async () => ({ conversationId: "c1", reply: "ok", messages: [], documents: [], agentRuns: [] }) },
    whatsAppConfig: loadWhatsAppCloudConfig(ENV),
    whatsAppStore: createMemoryWhatsAppInbox({ clock }),
    whatsAppFetch: meta.fetchImpl,
    whatsAppTranscriber: null,
    clock
  });
  t.after(() => app.close());
  return { app, inject, workshop, meta, teamBook };
}

test("a step blocked or late is told once to the order's chef de charge, and their answer reaches Production", async (t) => {
  const { app, inject, workshop, meta, teamBook } = await setUp(t);
  await workshop.advance("171", "assemblage", { status: "bloquee", note: "Charnières en rupture" });
  await workshop.advance("172", "assemblage", { status: "bloquee", note: "Vis manquantes" });

  // The cockpit reads the book: the anomaly is found, and told.
  assert.equal((await inject({ method: "GET", url: "/api/workshop" })).statusCode, 200);
  // A blocking is also grave: the direction is told of it (see anomaly-tasks);
  // here, only what the chef de charge is sent.
  const alerts = () => meta.sent.filter((message) => !message.text.startsWith("Anomalie grave"));
  assert.deepEqual(alerts(), [{
    to: LEAD,
    text: "Bonjour Samir, alerte sur le BC n° 171 (Client Exemple) dont vous êtes chef de charge : Assemblage bloquée : Charnières en rupture. Répondez ici avec la cause et la nouvelle date : la direction et l'agent Production seront informés."
  }], "the chef de charge without a number is not written to");
  assert.ok((await teamBook.activity({ agent: "production" })).some((entry) => entry.text === "Alerte envoyée par WhatsApp à Samir (chef de charge) : BC 171 (Client Exemple) : Assemblage bloquée : Charnières en rupture"));

  // Read again, by the cockpit or the timer: nothing more is sent.
  await inject({ method: "GET", url: "/api/workshop" });
  await app.sweepAnomalies();
  assert.equal(alerts().length, 1);

  // A step whose day passed, found by the timer.
  await workshop.advance("171", "finition", { plannedDate: "05/11/2026" });
  await app.sweepAnomalies();
  assert.equal(alerts().length, 2);
  assert.match(alerts()[1].text, /Peinture et finition prévue le 05\/11\/2026, pas terminée\./);

  // The chef de charge answers on WhatsApp: a report to Production.
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { contacts: [{ wa_id: LEAD, profile: { name: "" } }], messages: [{ from: LEAD, id: "wamid.r1", timestamp: "1762682400", type: "text", text: { body: "Charnières livrées jeudi, assemblage fini samedi" } }] } }] }] });
  await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: raw, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", ENV.WHATSAPP_APP_SECRET).update(raw).digest("hex")}` } });
  await app.whatsApp.idle();
  const report = (await teamBook.activity({ agent: "production" })).find((entry) => entry.kind === "compte_rendu");
  assert.equal(report.text, "Compte rendu de Samir par WhatsApp : Charnières livrées jeudi, assemblage fini samedi");
  assert.match(meta.sent.at(-1).text, /^Bien reçu, Samir\./);
});

test("an alert Meta refuses is written to the team feed and the book is still read", async (t) => {
  const { inject, workshop, teamBook } = await setUp(t, { meta: fakeMeta({ refuse: LEAD }) });
  await workshop.advance("171", "assemblage", { status: "bloquee", note: "Charnières en rupture" });

  const read = await inject({ method: "GET", url: "/api/workshop" });
  assert.equal(read.statusCode, 200);
  const failed = (await teamBook.activity({ agent: "production" })).find((entry) => entry.text.startsWith("Alerte non envoyée à Samir (chef de charge) : "));
  assert.ok(failed, "the direction sees in the team feed that the chef de charge was not reached");
});
