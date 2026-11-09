import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { assignTask, directorBriefing } from "../src/agent/company-tools.js";
import { createMemoryImprovementBook, taskBoard } from "../src/agent/improvement-book.js";
import { createMemoryTeamBook } from "../src/agent/team-book.js";
import { createMemoryWhatsAppInbox } from "../src/agent/whatsapp-inbox.js";
import { createMemoryWorkshopStore, createWorkshop } from "../src/agent/workshop-book.js";
import { loadWhatsAppCloudConfig } from "../src/integrations/whatsapp-cloud.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// CDC recette scenario 5: the direction receives a summary of the anomalies,
// gives each one as a task (a trade, a person, a deadline), and confirms its
// closure. Invented people, numbers and figures only.

const ENV = Object.freeze({
  WHATSAPP_ACCESS_TOKEN: "test-access",
  WHATSAPP_PHONE_NUMBER_ID: "1234567890",
  WHATSAPP_VERIFY_TOKEN: "test-verify",
  WHATSAPP_APP_SECRET: "test-secret",
  WHATSAPP_OWNER_NUMBERS: "06 61 00 00 01"
});
const OWNER = "212661000001";
const SAMIR = "212670000004";

const client = { name: "Client Exemple", address: "Marrakech" };
const quote = {
  documentType: "quote", documentNumber: "170", date: "02/11/2026", object: "Lit cabane", client,
  items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: 3750, amountHt: 3750 }],
  totals: { totalHt: 3750, tva: 750, totalTtc: 4500 },
  payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
};
const order = { ...quote, documentType: "purchase_order", documentNumber: "171", date: "03/11/2026", payment: { termsRule: "hkids-po-50-50" }, specifications: ["Bois clair"], quoteReference: "170" };

function fakeMeta() {
  const sent = [];
  const fetchImpl = async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    sent.push({ to: body.to, text: body.text.body });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.out.${sent.length}` }] }) };
  };
  return { sent, fetchImpl };
}

async function setUp(t, { role = "leader" } = {}) {
  const at = { now: new Date("2026-11-09T10:00:00Z") };
  const clock = () => at.now;
  const dir = await mkdtemp(join(tmpdir(), "hkids-tasks-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: dir });
  for (const input of [quote, order]) {
    const preview = await documents.preview(input);
    await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true });
  }
  const workshopStore = createMemoryWorkshopStore({ clock });
  const workshop = createWorkshop({ store: workshopStore, documentService: documents, clock });
  const teamBook = createMemoryTeamBook({ clock, agents: SPECIALIST_IDS });
  const meta = fakeMeta();
  const { app, inject } = await buildAuthenticatedApi({
    repository: new InMemoryRepository(),
    documentService: documents,
    workshopStore,
    teamBook,
    directorAgent: { isConfigured: () => true, chat: async () => ({ conversationId: "c1", reply: "Le Director répond.", messages: [], documents: [], agentRuns: [] }) },
    whatsAppConfig: loadWhatsAppCloudConfig(ENV),
    whatsAppStore: createMemoryWhatsAppInbox({ clock }),
    whatsAppFetch: meta.fetchImpl,
    whatsAppTranscriber: null,
    role,
    clock
  });
  t.after(() => app.close());
  return { app, inject, workshop, meta, teamBook, at };
}

async function whatsAppFrom(app, from, body, id) {
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { contacts: [{ wa_id: from, profile: { name: "" } }], messages: [{ from, id, timestamp: "1762682400", type: "text", text: { body } }] } }] }] });
  await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: raw, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", ENV.WHATSAPP_APP_SECRET).update(raw).digest("hex")}` } });
  await app.whatsApp.idle();
}

test("the task board tells open, grave, unassigned, late and to-confirm apart", async () => {
  const clock = () => new Date("2026-11-09T10:00:00Z");
  const book = createMemoryImprovementBook({ clock });
  const grave = await book.report({ fact: "Le client se plaint d'une rayure", area: "livraison", agent: "production", severity: "haute", by: "director" });
  const late = await book.report({ fact: "Facture non relancée", area: "finance", agent: "finance", by: "director" });
  const done = await book.report({ fact: "Stock de vis épuisé", area: "achats", agent: "production", by: "director" });
  await book.assign(late.number, { agent: "finance", person: "Nadia", dueDate: "05/11/2026" });
  await book.assign(done.number, { agent: "production", dueDate: "20/11/2026" });
  await book.updateTask(done.number, "resolue", { note: "Vis commandées et reçues", by: "Samir" });

  const board = taskBoard((await book.state()).anomalies, clock());
  assert.deepEqual(board.open.map((anomaly) => anomaly.number), [grave.number, late.number, done.number]);
  assert.deepEqual(board.severe.map((anomaly) => anomaly.number), [grave.number]);
  assert.deepEqual(board.unassigned.map((anomaly) => anomaly.number), [grave.number]);
  assert.deepEqual(board.late.map((anomaly) => anomaly.number), [late.number]);
  assert.deepEqual(board.toConfirm.map((anomaly) => anomaly.number), [done.number]);

  // Only the direction closes; a closed task leaves the board, its anomaly lifted.
  await assert.rejects(book.updateTask(late.number, "cloturer", { by: "direction" }), /prise en charge|ouverte/);
  const closed = await book.updateTask(done.number, "cloturer", { by: "direction" });
  assert.equal(closed.task.status, "cloturee");
  assert.equal(closed.status, "levee");
  assert.equal(taskBoard((await book.state()).anomalies, clock()).open.length, 2);
  await assert.rejects(book.updateTask(late.number, "resolue", { note: "", by: "Nadia" }), /Dire comment/);
});

test("a task given to a trade goes to the person linked to it, and the Director reads the board", async () => {
  const clock = () => new Date("2026-11-09T10:00:00Z");
  const improvement = createMemoryImprovementBook({ clock });
  const team = createMemoryTeamBook({ clock, agents: SPECIALIST_IDS });
  await team.link("finance", { name: "Nadia", role: "Comptable", phone: "06 70 00 00 09" });
  const anomaly = await improvement.report({ fact: "Facture non relancée", area: "finance", agent: "finance", by: "director" });

  const result = await assignTask({ anomalie: String(anomaly.number), agent: "finance", personne: "", telephone: "", echeance: "12/11/2026", gravite: "", consigne: "Relancer le client" }, { books: { improvement, team } }, "direction");
  assert.equal(result.ok, true);
  assert.equal(result.tache.tache.confiee_a, "Nadia");
  assert.match(result.prevenu, /Nadia est prévenu\(e\) sur WhatsApp/);
  assert.equal((await improvement.state()).anomalies[0].task.phone, "212670000009");

  const unreadable = await assignTask({ anomalie: String(anomaly.number), agent: "finance", personne: "", telephone: "abc", echeance: "12/11/2026", gravite: "", consigne: "" }, { books: { improvement, team } }, "direction");
  assert.equal(unreadable.ok, false);

  const briefing = await directorBriefing({ books: { improvement, team, cash: {} }, clock });
  assert.match(briefing.join("\n"), /Tâches d'amélioration : 1 ouverte\(s\)/);
});

test("scenario 5: a grave anomaly is told, assigned, taken, resolved, then closed by the direction on WhatsApp", async (t) => {
  const { app, inject, workshop, meta, teamBook } = await setUp(t);
  await workshop.advance("171", "assemblage", { status: "bloquee", note: "Charnières en rupture" });

  // The book is read: a blocking is grave, the direction is told at once, once.
  await inject({ method: "GET", url: "/api/workshop" });
  await app.sweepAnomalies();
  const grave = meta.sent.filter((message) => message.to === OWNER && message.text.startsWith("Anomalie grave"));
  assert.equal(grave.length, 1);
  assert.match(grave[0].text, /^Anomalie grave n° 1 : BC 171 \(Client Exemple\) : Assemblage bloquée : Charnières en rupture\. Confiez-la/);

  // The direction gives it to Samir from the cockpit: he is told on WhatsApp.
  const assigned = await inject({ method: "POST", url: "/api/improvement/anomalies/1/assign", payload: { agent: "production", person: "Samir", phone: "06 70 00 00 04", dueDate: "12/11/2026", severity: "", instruction: "Trouver des charnières chez un autre fournisseur" } });
  assert.equal(assigned.statusCode, 200, assigned.body);
  assert.match(assigned.json().notified, /Samir est prévenu/);
  assert.equal(meta.sent.at(-1).to, SAMIR);
  assert.equal(meta.sent.at(-1).text, "Bonjour Samir, la direction vous confie la tâche n° 1 (gravité haute) : BC 171 (Client Exemple) : Assemblage bloquée : Charnières en rupture — Trouver des charnières chez un autre fournisseur. À régler avant le 12/11/2026. Répondez « tâche 1 prise en charge », puis « tâche 1 résolue : ce qui a été fait ».");

  // Samir answers on WhatsApp, as a member of the team.
  await whatsAppFrom(app, SAMIR, "Tâche 1 prise en charge", "wamid.s1");
  let anomaly = (await inject({ method: "GET", url: "/api/improvement" })).json().anomalies.find((entry) => entry.number === 1);
  assert.equal(anomaly.task.status, "prise_en_charge");
  assert.match(meta.sent.at(-1).text, /Tâche n° 1 notée prise en charge\./);

  await whatsAppFrom(app, SAMIR, "tâche 1 résolue : charnières achetées chez Bricoma, assemblage repris", "wamid.s2");
  anomaly = (await inject({ method: "GET", url: "/api/improvement" })).json().anomalies.find((entry) => entry.number === 1);
  assert.equal(anomaly.task.status, "resolue");
  assert.equal(anomaly.task.resolution, "charnières achetées chez Bricoma, assemblage repris");
  const toOwner = meta.sent.filter((message) => message.to === OWNER).at(-1);
  assert.match(toOwner.text, /^Tâche n° 1 résolue par Samir : charnières achetées chez Bricoma, assemblage repris .*répondez « clôture tâche 1 »/);
  assert.ok((await teamBook.activity({ agent: "production" })).some((entry) => entry.text.startsWith("Tâche n° 1 résolue, à confirmer")));

  // The step goes on in the carnet; the direction confirms on WhatsApp,
  // without going through the Director.
  await workshop.advance("171", "assemblage", { status: "en_cours" });
  await whatsAppFrom(app, OWNER, "Clôture tâche 1", "wamid.o1");
  anomaly = (await inject({ method: "GET", url: "/api/improvement" })).json().anomalies.find((entry) => entry.number === 1);
  assert.equal(anomaly.task.status, "cloturee");
  assert.equal(meta.sent.at(-1).text, "Clôture de la tâche n° 1 confirmée.");
});

test("the direction reopens a resolved task, and only the direction may close one in the cockpit", async (t) => {
  const { inject, workshop, meta } = await setUp(t);
  await workshop.advance("171", "assemblage", { status: "bloquee", note: "Charnières en rupture" });
  await inject({ method: "GET", url: "/api/workshop" });
  await inject({ method: "POST", url: "/api/improvement/anomalies/1/assign", payload: { agent: "production", person: "Samir", phone: "06 70 00 00 04", dueDate: "12/11/2026" } });

  assert.equal((await inject({ method: "POST", url: "/api/improvement/anomalies/1/closure", payload: { decision: "confirmer" } })).statusCode, 400, "nothing to confirm before it is resolved");
  assert.equal((await inject({ method: "POST", url: "/api/improvement/anomalies/1/task", payload: { action: "resolue", note: "" } })).statusCode, 400);
  assert.equal((await inject({ method: "POST", url: "/api/improvement/anomalies/1/task", payload: { action: "resolue", note: "Charnières reçues" } })).statusCode, 200);

  const reopened = await inject({ method: "POST", url: "/api/improvement/anomalies/1/closure", payload: { decision: "rouvrir", note: "Le client voit encore un jeu dans la porte" } });
  assert.equal(reopened.statusCode, 200, reopened.body);
  assert.equal(meta.sent.at(-1).to, SAMIR);
  assert.match(meta.sent.at(-1).text, /^La direction rouvre la tâche n° 1 .*: Le client voit encore un jeu dans la porte\./);
  assert.equal((await inject({ method: "POST", url: "/api/improvement/anomalies/99/assign", payload: { agent: "production", dueDate: "12/11/2026" } })).statusCode, 404);
});

test("an operator moves a task but cannot confirm its closure", async (t) => {
  const { inject, workshop } = await setUp(t, { role: "operator" });
  await workshop.advance("171", "assemblage", { status: "bloquee", note: "Charnières en rupture" });
  await inject({ method: "GET", url: "/api/workshop" });
  assert.equal((await inject({ method: "POST", url: "/api/improvement/anomalies/1/closure", payload: { decision: "confirmer" } })).statusCode, 403);
});

test("each working morning the direction gets the summary once, and a late task is reminded once a day", async (t) => {
  const { app, inject, workshop, meta, at } = await setUp(t);
  await workshop.advance("171", "assemblage", { status: "bloquee", note: "Charnières en rupture" });
  await inject({ method: "GET", url: "/api/workshop" });
  await inject({ method: "POST", url: "/api/improvement/anomalies/1/assign", payload: { agent: "production", person: "Samir", phone: "06 70 00 00 04", dueDate: "10/11/2026" } });

  // At night, nothing.
  at.now = new Date("2026-11-09T21:30:00Z");
  assert.deepEqual(await app.sweepTasks(), { summary: false, reminded: [] });

  at.now = new Date("2026-11-09T08:30:00Z");
  const first = await app.sweepTasks();
  assert.equal(first.summary, true);
  assert.deepEqual(first.reminded, [], "the deadline has not passed yet");
  const summary = meta.sent.filter((message) => message.to === OWNER).at(-1).text;
  assert.match(summary, /^Résumé des anomalies du 09\/11\/2026 : 1 ouverte\(s\), dont 1 grave\(s\)\./);
  assert.equal((await app.sweepTasks()).summary, false, "once a day");

  at.now = new Date("2026-11-11T09:00:00Z");
  const sent = meta.sent.length;
  const late = await app.sweepTasks();
  assert.deepEqual(late, { summary: true, reminded: [1] });
  assert.ok(meta.sent.slice(sent).some((message) => message.to === SAMIR && /^Rappel : la tâche n° 1 .*devait être réglée le 10\/11\/2026/.test(message.text)));
  assert.match(meta.sent.slice(sent).find((message) => message.to === OWNER).text, /En retard sur l'échéance \(1\) :\n  · n° 1 Samir, prévue le 10\/11\/2026/);
  assert.deepEqual((await app.sweepTasks()).reminded, [], "once a day");
});
