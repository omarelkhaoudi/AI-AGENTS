import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { createMemoryTeamBook } from "../src/agent/team-book.js";
import { createMemoryWhatsAppInbox } from "../src/agent/whatsapp-inbox.js";
import { createMemoryWorkshopStore, createWorkshop } from "../src/agent/workshop-book.js";
import { createFileFollowUpBook, createMemoryFollowUpBook, dueReminders, quotePipeline, salesReport } from "../src/agent/sales-book.js";
import { loadWhatsAppCloudConfig } from "../src/integrations/whatsapp-cloud.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// CDC V1.1, section 13, scenario 4: the Commercial director produces a report
// in figures anyone can check against the documents, and tells of a late
// follow-up or a late delivery. Invented clients, people and figures only.

const NOW = new Date("2026-11-20T10:00:00Z");
const clock = () => NOW;
const ENV = Object.freeze({
  WHATSAPP_ACCESS_TOKEN: "test-access",
  WHATSAPP_PHONE_NUMBER_ID: "1234567890",
  WHATSAPP_VERIFY_TOKEN: "test-verify",
  WHATSAPP_APP_SECRET: "test-secret",
  WHATSAPP_OWNER_NUMBERS: "06 61 00 00 01"
});
const OWNER = "212661000001";
const SALES = "212670000005";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "hkids-follow-ups-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const line = (amountHt) => [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: amountHt, amountHt }];
const quote = (number, date, name, amountHt) => ({
  documentType: "quote", documentNumber: number, date, object: "Chambre enfant", client: { name, address: "Marrakech" },
  items: line(amountHt), totals: { totalHt: amountHt, tva: amountHt * 0.2, totalTtc: amountHt * 1.2 },
  payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
});
const order = (number, date, from) => ({ ...from, documentType: "purchase_order", documentNumber: number, date, payment: { termsRule: "hkids-po-50-50" }, specifications: ["Bois clair"], quoteReference: from.documentNumber });

// 170 ordered by BC 175; 171 silent 9 days; 172 silent 15 days; 173 fresh;
// 174 recent (turned down in the report test); 169 issued last month and ordered this month.
const Q169 = quote("169", "28/10/2026", "Client Octobre", 2500);
const Q170 = quote("170", "02/11/2026", "Client Alpha", 3750);
const Q171 = quote("171", "11/11/2026", "Client Beta", 5000);
const Q172 = quote("172", "05/11/2026", "Client Gamma", 10000);
const Q173 = quote("173", "18/11/2026", "Client Delta", 2000);
const Q174 = quote("174", "17/11/2026", "Client Epsilon", 4000);

async function documentsWith(t) {
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: await tempDir(t) });
  for (const input of [Q169, Q170, Q171, Q172, Q173, Q174, order("175", "09/11/2026", Q170), order("176", "03/11/2026", Q169)]) {
    const preview = await documents.preview(input);
    await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true });
  }
  return documents;
}

test("the report counts only what the documents say, and names every document it counts", async (t) => {
  const documents = await documentsWith(t);
  const followUps = createMemoryFollowUpBook({ clock });
  await followUps.record("174", { channel: "telephone", day: "18/11/2026", lost: true, reason: "Trop cher", by: "hiba" });
  await followUps.record("172", { channel: "whatsapp", day: "06/11/2026", note: "Elle réfléchit", by: "hiba" });
  await assert.rejects(followUps.record("171", { lost: true }), { code: "FOLLOW_UP_REASON_MISSING" });
  await assert.rejects(followUps.record("171", { channel: "pigeon" }), { code: "FOLLOW_UP_CHANNEL_UNKNOWN" });

  const report = salesReport(await documents.listIssued(), await followUps.state(), { from: "2026-11-01", to: "2026-11-30", today: NOW });

  assert.deepEqual(report.issued, { count: 5, totalTtc: 29700, numbers: ["174", "173", "172", "171", "170"] });
  assert.deepEqual(report.signed, { count: 2, totalTtc: 7500, pairs: ["devis 170 → BC 175", "devis 169 → BC 176"] }, "a sale is dated by its order");
  assert.equal(report.conversion, 20, "1 of the 5 quotes of the month is ordered");
  assert.deepEqual(report.lost, { count: 1, totalTtc: 4800, quotes: [{ number: "174", reason: "Trop cher" }] });
  assert.deepEqual(report.open, { count: 3, totalTtc: 20400, numbers: ["173", "172", "171"] });
  assert.deepEqual(report.toFollowUp.map((entry) => [entry.number, entry.daysSilent, entry.level]), [["172", 14, 2], ["171", 9, 1]], "the last follow-up resets the silence");
});

test("a reminder is due once per quote, level and last contact", async (t) => {
  const documents = await documentsWith(t);
  const followUps = createMemoryFollowUpBook({ clock });
  const pipeline = quotePipeline(await documents.listIssued(), await followUps.state(), { today: NOW });
  const first = await followUps.claimReminders(dueReminders(pipeline));
  assert.deepEqual(first.map((reminder) => reminder.key), ["devis:172:2:2026-11-05", "devis:171:1:2026-11-11"]);
  assert.deepEqual(await followUps.claimReminders(dueReminders(pipeline)), [], "never twice");

  await followUps.record("171", { channel: "telephone", day: "19/11/2026" });
  const after = quotePipeline(await documents.listIssued(), await followUps.state(), { today: NOW });
  assert.equal(after.find((entry) => entry.number === "171").level, 0, "followed up yesterday: nothing due");
});

test("the follow-ups survive a restart", async (t) => {
  const path = join(await tempDir(t), "relances.json");
  await createFileFollowUpBook({ path, clock }).record("171", { channel: "visite", note: "Showroom" });
  const state = await createFileFollowUpBook({ path, clock }).state();
  assert.equal(state.quotes["171"].followUps[0].note, "Showroom");
});

async function api(t, { linkCommercial = true, at = NOW } = {}) {
  const documents = await documentsWith(t);
  const teamBook = createMemoryTeamBook({ clock: () => at, agents: SPECIALIST_IDS });
  if (linkCommercial) {
    await teamBook.link("commercial", { name: "Nadia", role: "commerciale", phone: "06 70 00 00 05" });
  }
  const sent = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ to: body.to, text: body.text.body });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.out.${sent.length}` }] }) };
  };
  const workshopStore = createMemoryWorkshopStore({ clock: () => at });
  const { app, inject } = await buildAuthenticatedApi({
    repository: new InMemoryRepository(),
    documentService: documents,
    workshopStore,
    teamBook,
    directorAgent: { isConfigured: () => true, chat: async () => ({ conversationId: "c1", reply: "ok", messages: [], documents: [], agentRuns: [] }) },
    whatsAppConfig: loadWhatsAppCloudConfig(ENV),
    whatsAppStore: createMemoryWhatsAppInbox({ clock: () => at }),
    whatsAppFetch: fetchImpl,
    whatsAppTranscriber: null,
    clock: () => at
  });
  t.after(() => app.close());
  return { app, inject, sent, teamBook, documents, workshop: createWorkshop({ store: workshopStore, documentService: documents, clock: () => at }) };
}

test("the Commercial's person is reminded of the quotes to follow up, the direction of the late ones, once", async (t) => {
  const { app, sent, teamBook } = await api(t);

  await app.sweepFollowUps();
  assert.deepEqual(sent.map((message) => message.to), [SALES, OWNER]);
  assert.equal(sent[0].text, [
    "Bonjour Nadia, devis à relancer :",
    "- Devis n° 172, Client Gamma, 12 000 DH : 15 jours sans nouvelles",
    "- Devis n° 171, Client Beta, 6 000 DH : 9 jours sans nouvelles",
    "Une fois la relance faite, répondez ici, par exemple « relance du devis 172 faite, le client réfléchit »."
  ].join("\n"));
  assert.equal(sent[1].text, "Relances en retard (sans nouvelles depuis 10 jours ou plus ; Nadia a été prévenu(e)) :\n- Devis n° 172, Client Gamma, 12 000 DH : 15 jours sans nouvelles");

  await app.sweepFollowUps();
  assert.equal(sent.length, 2, "the same reminder is never sent twice");

  // Nadia answers: the follow-up is recorded, and 171 is no longer due.
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { contacts: [{ wa_id: SALES, profile: { name: "" } }], messages: [{ from: SALES, id: "wamid.n1", timestamp: "1763632800", type: "text", text: { body: "Relance du devis 171 faite, il signe lundi" } }] } }] }] });
  await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: raw, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", ENV.WHATSAPP_APP_SECRET).update(raw).digest("hex")}` } });
  await app.whatsApp.idle();
  assert.match(sent.at(-1).text, /Relance du devis n° 171 enregistrée\./);
  assert.ok((await teamBook.activity({ agent: "commercial" })).some((entry) => entry.text === "Relance du devis n° 171 (Client Beta) par autre : Relance du devis 171 faite, il signe lundi."));
});

test("with nobody behind the Commercial, the direction gets every quote to follow up; at night, nothing is sent", async (t) => {
  const night = await api(t, { linkCommercial: false, at: new Date("2026-11-20T22:30:00Z") });
  assert.deepEqual(await night.app.sweepFollowUps(), []);
  assert.equal(night.sent.length, 0);

  const day = await api(t, { linkCommercial: false });
  await day.app.sweepFollowUps();
  assert.deepEqual(day.sent.map((message) => message.to), [OWNER]);
  assert.match(day.sent[0].text, /^Devis à relancer \(sans nouvelles depuis 5 jours ou plus ; aucun responsable commercial relié\) :\n- Devis n° 172.*\n- Devis n° 171/);
});

test("a late delivery is told to the Commercial's person, to warn the client", async (t) => {
  const { inject, sent, workshop } = await api(t);
  await workshop.advance("175", "livraison_installation", { plannedDate: "18/11/2026" });
  await inject({ method: "GET", url: "/api/workshop" });
  assert.deepEqual(sent.map((message) => [message.to, message.text]), [[SALES, "Bonjour Nadia, la livraison du BC n° 175 (Client Alpha) est en retard : Livraison et installation prévue le 18/11/2026, pas terminée. Prévenez le client et convenez d'une nouvelle date avec lui."]]);
});

test("the cockpit reads the report and records a follow-up", async (t) => {
  const { inject } = await api(t);
  const read = await inject({ method: "GET", url: "/api/commercial?from=01/11/2026&to=30/11/2026" });
  assert.equal(read.statusCode, 200);
  const { report, quotes } = JSON.parse(read.body);
  assert.equal(report.signed.count, 2);
  assert.equal(quotes.length, 6);

  const recorded = await inject({ method: "POST", url: "/api/commercial/quotes/172/follow-ups", payload: { channel: "telephone", note: "Rappeler vendredi" } });
  assert.equal(recorded.statusCode, 200);
  assert.equal((await inject({ method: "POST", url: "/api/commercial/quotes/999/follow-ups", payload: { channel: "telephone" } })).statusCode, 404);
  assert.equal((await inject({ method: "POST", url: "/api/commercial/quotes/170/follow-ups", payload: { channel: "telephone" } })).statusCode, 400, "an ordered quote needs no follow-up");
  assert.equal((await inject({ method: "POST", url: "/api/commercial/quotes/172/follow-ups", payload: { lost: true } })).statusCode, 400, "a lost quote says why");
});

// The agents, with the model's answers written in advance.
test("asked for the report, the Director reads it from the documents; told of a follow-up, it records it", async (t) => {
  const documents = await documentsWith(t);
  const calls = [];
  const scripts = {
    "Tu es le Director IA": [
      { output: [{ type: "function_call", name: "bilan_commercial", call_id: "b1", arguments: JSON.stringify({ du: "", au: "" }) }] },
      { output: [{ type: "function_call", name: "enregistrer_relance", call_id: "r1", arguments: JSON.stringify({ devis: "171", canal: "telephone", date: "", note: "Il signe lundi", perdu: false, motif: "" }) }] },
      { output_text: "Bilan fait.", output: [] }
    ]
  };
  const followUpBook = createMemoryFollowUpBook({ clock });
  const agent = createDirectorAgent({
    client: { responses: { create: async (payload) => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      return scripts[Object.keys(scripts).find((key) => payload.instructions.includes(key))].shift();
    } } },
    documentService: documents,
    followUpBook,
    toolRegistry: { list: () => [] },
    executeTool: async () => ({ ok: true, donnees: null }),
    clock
  });

  await agent.chat({ message: "Fais-moi le bilan commercial du mois. Au fait, j'ai relancé le client du devis 171 au téléphone, il signe lundi." });

  assert.ok(calls[0].instructions.includes("Devis à relancer (sans nouvelles depuis 5 jours ou plus) : n° 172 (Client Gamma, 15 j), n° 171 (Client Beta, 9 j)"), "the Director knows before it is asked");
  const report = JSON.parse(calls[1].input.at(-1).output);
  assert.equal(report.periode, "du 01/11/2026 au 30/11/2026");
  assert.deepEqual(report.ventes_signees.documents, ["devis 170 → BC 175", "devis 169 → BC 176"]);
  assert.deepEqual(report.a_relancer.map((entry) => [entry.devis, entry.urgence]), [["172", "en retard : la direction est prévenue"], ["171", "à relancer"]]);
  assert.equal(JSON.parse(calls[2].input.at(-1).output).ok, true);
  assert.equal((await followUpBook.state()).quotes["171"].followUps[0].note, "Il signe lundi");
});
