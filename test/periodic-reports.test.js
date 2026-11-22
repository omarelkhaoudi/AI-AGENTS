import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createMemoryCashBook } from "../src/agent/cash-book.js";
import { createMemoryReportBook, composeReport, reportDue, reportPeriod } from "../src/agent/periodic-reports.js";
import { createMemoryWhatsAppInbox } from "../src/agent/whatsapp-inbox.js";
import { loadWhatsAppCloudConfig } from "../src/integrations/whatsapp-cloud.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

// The direction's scheduled reports (CDC V2 sections 5 and 6), composed from
// the books only. Invented clients, people and amounts. 23/11/2026 is a
// Monday; 21/11 a Saturday, 22/11 a Sunday.

const MONDAY = new Date("2026-11-23T09:00:00Z");
const ENV = Object.freeze({
  WHATSAPP_ACCESS_TOKEN: "test-access",
  WHATSAPP_PHONE_NUMBER_ID: "1234567890",
  WHATSAPP_VERIFY_TOKEN: "test-verify",
  WHATSAPP_APP_SECRET: "test-secret",
  WHATSAPP_OWNER_NUMBERS: "06 61 00 00 01"
});

test("each report covers its last closed period and goes out on its day", () => {
  assert.deepEqual(reportPeriod("jour", MONDAY), { from: "2026-11-21", to: "2026-11-22" }, "a Monday covers Saturday and Sunday");
  assert.deepEqual(reportPeriod("jour", new Date("2026-11-25T09:00:00Z")), { from: "2026-11-24", to: "2026-11-24" });
  assert.deepEqual(reportPeriod("semaine", MONDAY), { from: "2026-11-16", to: "2026-11-22" });
  assert.deepEqual(reportPeriod("mois", new Date("2026-12-01T09:00:00Z")), { from: "2026-11-01", to: "2026-11-30" });

  assert.equal(reportDue("jour", MONDAY), true);
  assert.equal(reportDue("jour", new Date("2026-11-22T09:00:00Z")), false, "nothing on a Sunday");
  assert.equal(reportDue("semaine", MONDAY), true);
  assert.equal(reportDue("semaine", new Date("2026-11-24T09:00:00Z")), false);
  assert.equal(reportDue("mois", new Date("2026-12-01T09:00:00Z")), true);
  assert.equal(reportDue("mois", MONDAY), false);
  // 1er janvier is a public holiday: the month's report goes out the 2nd.
  assert.equal(reportDue("mois", new Date("2027-01-01T09:00:00Z")), false);
  assert.equal(reportDue("mois", new Date("2027-01-02T09:00:00Z")), true);
  // A Monday off: the week's report goes out on the Tuesday.
  const holidays = [{ day: "2026-11-23", label: "Exemple" }];
  assert.equal(reportDue("semaine", MONDAY, holidays), false);
  assert.equal(reportDue("semaine", new Date("2026-11-24T09:00:00Z"), holidays), true);
});

test("the week's report: CA commandé, facturé and encaissé apart, the cash book, the workshop and what is left to do", () => {
  const issued = [
    { type: "quote", number: "170", date: "17/11/2026", client: "Client A", totalTtc: 12000 },
    { type: "quote", number: "171", date: "18/11/2026", client: "Client B", totalTtc: 6000 },
    { type: "purchase_order", number: "166", date: "19/11/2026", client: "Client A", totalTtc: 12000, quoteReference: "170" },
    { type: "invoice", number: "79", date: "10/11/2026", client: "Client C", totalTtc: 5000 },
    { type: "invoice", number: "80", date: "20/11/2026", client: "Client A", totalTtc: 7200 },
    { type: "credit_note", number: "5", date: "21/11/2026", client: "Client A", totalTtc: 1200 }
  ];
  const entries = [
    { kind: "entree", category: "solde_depart", amount: 10000, day: "2026-11-01" },
    { kind: "entree", category: "apport", amount: 1000, day: "2026-11-17" },
    { kind: "sortie", category: "achat_matiere", amount: 3000, day: "2026-11-18" },
    { kind: "sortie", category: "salaire", amount: 4000, day: "2026-11-19" },
    { kind: "entree", category: "acompte_client", amount: 999, day: "2026-11-19", cancelled: true },
    { kind: "entree", category: "acompte_client", amount: 7200, day: "2026-11-20" },
    { kind: "entree", category: "vente_comptant", amount: 500, day: "2026-11-21" }
  ];
  const orders = [
    { number: "166", client: "Client A", finished: false, steps: [{ id: "assemblage", status: "bloquee" }, { id: "livraison_installation", status: "a_faire", plannedDate: "2026-11-20", late: true }] },
    { number: "160", client: "Client C", finished: true, steps: [{ id: "livraison_installation", status: "terminee", doneDate: "2026-11-18" }] }
  ];
  const anomalies = [
    { number: 1, status: "a_analyser", severity: "haute" },
    { number: 2, status: "a_analyser", severity: "moyenne", source: "budget", task: { status: "ouverte", dueDate: "2026-11-20", person: "Karim" } }
  ];
  const report = composeReport("semaine", { from: "2026-11-16", to: "2026-11-22" }, {
    issued, followUps: { quotes: {} }, followUpDays: 5, entries, orders,
    schedule: { configured: true, orders: [{ number: "166", verdict: "intenable", promised: "2026-11-20", end: "2026-11-27" }] },
    anomalies, stockAlerts: [{ name: "Panneau exemple" }], pending: { missingReceipt: [{}], awaitingApproval: [] }
  }, { today: MONDAY });

  assert.equal(report.key, "semaine:2026-11-16:2026-11-22");
  assert.equal(report.title, "Rapport de la semaine — du 16/11/2026 au 22/11/2026");
  const [sales, cash, workshop, todo] = report.sections.map((section) => section.lines.join("\n"));
  assert.match(sales, /Devis émis : 2 \(18.000 DH TTC\)/);
  assert.match(sales, /CA commandé : 12.000 DH TTC, 1 bon\(s\) de commande signé\(s\)/);
  assert.match(sales, /CA facturé : 6.000 DH TTC, 1 facture\(s\) moins 1 avoir\(s\) de 1.200 DH/, "the invoice of the 10th is another week");
  assert.match(sales, /CA encaissé : 7.700 DH/, "a contribution or a cancelled line is not a sale paid");
  assert.match(sales, /Taux de transformation des devis de la période : 50 %/);
  assert.match(sales, /Devis à relancer : n° 171 \(Client B, 5 j sans nouvelles\)/);
  assert.match(cash, /Entrées : 8.700 DH ; sorties : 7.000 DH ; net : 1.700 DH/);
  assert.match(cash, /Solde au 22\/11\/2026 : 11.700 DH/);
  assert.doesNotMatch(report.text, /[Ss]alaire/, "a salary is counted, never named");
  assert.match(workshop, /Commandes en cours : 1 ; livrées et installées sur la période : BC n° 160 \(Client C\)/);
  assert.match(workshop, /En retard sur une date prévue : BC n° 166 \(Client A\)/);
  assert.match(workshop, /Bloquées : BC n° 166/);
  assert.match(workshop, /Date promise intenable d'après la charge de l'atelier : BC n° 166 \(promis le 20\/11\/2026, fin estimée le 27\/11\/2026\)/);
  assert.match(todo, /Anomalies ouvertes : 2, dont 1 de gravité haute et 1 sans responsable/);
  assert.match(todo, /Tâches en retard : n° 2 \(Karim\)/);
  assert.match(todo, /Stock sous le minimum : Panneau exemple/);
  assert.match(todo, /Alertes budgétaires : 1/);
  assert.match(todo, /1 dépense\(s\) sans justificatif/, "the state of today, not of the period");
  assert.match(report.text, /^\*Rapport de la semaine — du 16\/11\/2026 au 22\/11\/2026\*\n\n\*Ventes\*\n• Devis émis/);
});

test("with empty books the report says so, and invents nothing", () => {
  const report = composeReport("jour", { from: "2026-11-21", to: "2026-11-22" }, {}, { today: MONDAY });
  const text = report.text;
  assert.match(text, /Devis émis : 0\n/);
  assert.match(text, /Taux de transformation : pas de devis émis sur la période/);
  assert.match(text, /Journal de caisse vide : aucun solde/);
  assert.match(text, /Aucune anomalie ouverte/);
});

test("the settings are the direction's, and a report is kept once per period", async () => {
  const book = createMemoryReportBook({ clock: () => MONDAY });
  assert.deepEqual((await book.state()).settings, { jour: true, semaine: true, mois: true });
  await assert.rejects(book.setSettings({ annee: true }), { code: "REPORT_KIND_UNKNOWN" });
  await assert.rejects(book.setSettings({ jour: "oui" }), { code: "REPORT_SETTING_INVALID" });
  assert.deepEqual((await book.setSettings({ mois: false })).settings, { jour: true, semaine: true, mois: false });
  const report = composeReport("jour", reportPeriod("jour", MONDAY), {}, { today: MONDAY });
  assert.ok(await book.keep(report));
  assert.equal(await book.keep(report), null);
});

async function api(t, { at = MONDAY, whatsApp = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rapports-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clock = () => at;
  const repository = new InMemoryRepository();
  const cashBook = createMemoryCashBook({ clock, expenseThreshold: 1_000_000 });
  await cashBook.record({ kind: "entree", category: "acompte_client", amount: 3000, day: "2026-11-21", party: "Client Exemple" });
  const sent = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ to: body.to, text: body.text.body });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.out.${sent.length}` }] }) };
  };
  const { app, inject } = await buildAuthenticatedApi({
    repository, clock, cashBook,
    documentService: new HkidsDocumentService({ repository, outputDir: dir }),
    ...(whatsApp ? { whatsAppConfig: loadWhatsAppCloudConfig(ENV), whatsAppStore: createMemoryWhatsAppInbox({ clock }), whatsAppFetch: fetchImpl, whatsAppTranscriber: null } : {})
  });
  t.after(() => app.close());
  return { app, inject, sent, repository };
}

test("on Monday morning the day's and the week's reports go to the direction on WhatsApp, once, and stay in the cockpit", async (t) => {
  const { app, inject, sent, repository } = await api(t);
  assert.deepEqual(await app.sweepReports(), ["jour:2026-11-21:2026-11-22", "semaine:2026-11-16:2026-11-22"]);
  assert.deepEqual(sent.map((message) => message.to), ["212661000001", "212661000001"]);
  assert.match(sent[0].text, /^\*Rapport du jour — du 21\/11\/2026 au 22\/11\/2026\*/);
  assert.match(sent[0].text, /CA encaissé : 3.000 DH/);
  assert.deepEqual(await app.sweepReports(), [], "never twice");
  assert.equal(sent.length, 2);

  const listed = JSON.parse((await inject({ method: "GET", url: "/api/reports" })).body);
  assert.deepEqual(listed.reports.map((report) => [report.kind, report.sentBy]), [["semaine", "whatsapp"], ["jour", "whatsapp"]]);
  assert.equal(listed.whatsApp, true);

  const operator = await createAuthenticatedUser(repository, { id: "karim", role: "operator" });
  assert.equal((await app.inject({ method: "GET", url: "/api/reports", headers: operator.headers })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/reports/preview", payload: { kind: "jour" }, headers: operator.headers })).statusCode, 403);

  const preview = await inject({ method: "POST", url: "/api/reports/preview", payload: { kind: "mois" } });
  assert.equal(JSON.parse(preview.body).report.title, "Rapport du mois — du 01/10/2026 au 31/10/2026");
  assert.equal((await inject({ method: "POST", url: "/api/reports/preview", payload: { kind: "annee" } })).statusCode, 400);
  assert.equal(sent.length, 2, "a preview is never sent");
});

test("a report turned off is not sent; without WhatsApp it is kept for the cockpit; at night nothing goes out", async (t) => {
  const night = await api(t, { at: new Date("2026-11-23T04:00:00Z") });
  assert.deepEqual(await night.app.sweepReports(), []);

  const { app, inject } = await api(t, { whatsApp: false });
  const off = await inject({ method: "PUT", url: "/api/reports", payload: { settings: { semaine: false } } });
  assert.equal(off.statusCode, 200);
  assert.equal((await inject({ method: "PUT", url: "/api/reports", payload: { settings: { jour: "oui" } } })).statusCode, 400);
  assert.deepEqual(await app.sweepReports(), ["jour:2026-11-21:2026-11-22"]);
  const listed = JSON.parse((await inject({ method: "GET", url: "/api/reports" })).body);
  assert.deepEqual(listed.reports.map((report) => [report.kind, report.sentBy]), [["jour", "cockpit"]]);
  assert.deepEqual(listed.settings, { jour: true, semaine: false, mois: true });
});
