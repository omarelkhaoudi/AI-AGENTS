import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryRepository, buildApi } from "../src/index.js";
import { createSecurityConfig } from "../src/security/security-config.js";
import { hashPassword } from "../src/security/password.js";
import { HkidsDocumentService } from "../src/documents/document-service.js";
import { createMemorySubscriptionBook } from "../src/agent/subscription-book.js";
import { validateAndPrepareDocument } from "../src/documents/document-validation.js";

// The SaaS subscriptions: H-KIDS bills each client company monthly, through
// its own invoice chain; nothing is issued, paid or suspended by itself.
// Invented companies, accounts and passwords only.
const CHOSEN = "jardin-exemple-2026";

async function setup(t, { day = "2026-12-01", saasOperator, suspended = false } = {}) {
  let now = new Date(`${day}T09:00:00Z`);
  const clock = () => now;
  const dir = await mkdtemp(join(tmpdir(), "abonnements-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The series already holds invoice 165, issued earlier.
  await writeFile(join(dir, "facture_HKIDS_165_2026-09-10.json"), JSON.stringify({ documentType: "invoice", documentNumber: "165", date: "10/09/2026", client: { name: "Client Exemple", address: "Marrakech" }, totals: { totalTtc: 1200 } }));
  const repository = new InMemoryRepository();
  for (const [id, role] of [["sara", "leader"], ["karim", "operator"]]) {
    repository.upsertUser({ id, name: id, email: `${id}@exemple.ma`, role });
    repository.setUserPassword(id, await hashPassword(CHOSEN));
  }
  const subscriptionBook = createMemorySubscriptionBook({ clock });
  const app = buildApi({
    repository, clock, subscriptionBook, saasOperator, suspended,
    documentService: new HkidsDocumentService({ repository, outputDir: dir }),
    security: createSecurityConfig({ NODE_ENV: "production", RATE_LIMIT_LOGIN_MAX: "100" })
  });
  t.after(() => app.close());
  const tokenOf = async (id) => JSON.parse((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: `${id}@exemple.ma`, password: CHOSEN } })).body).token;
  const as = (token) => (method, url, payload) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });
  return { app, dir, subscriptionBook, tokenOf, as, setDay: (next) => { now = new Date(`${next}T09:00:00Z`); } };
}

const CLIENT = { slug: "atelier-exemple", name: "ATELIER EXEMPLE SARL", address: "12 rue Exemple, Fès", plan: "business", since: "15/11/2026" };

test("a subscription invoice names its contract, not a sale, and carries the contract's terms", () => {
  const base = {
    documentType: "invoice", documentNumber: "900", date: "01/12/2026", object: "Abonnement au cockpit Director IA", client: { name: "X", address: "Y" },
    items: [{ designation: "Abonnement", unit: "Mois", quantity: 1, unitPriceHt: 1499, amountHt: 1499 }],
    totals: { totalHt: 1499, tva: 299.8, totalTtc: 1798.8 },
    payment: { method: "virement bancaire", terms: "Abonnement mensuel, payable à réception." }
  };
  assert.equal(validateAndPrepareDocument({ ...base, subscriptionReference: "ABO-atelier-exemple" }).subscriptionReference, "ABO-atelier-exemple");
  assert.throws(() => validateAndPrepareDocument(base), (error) => error.errors.some((entry) => entry.code === "UPSTREAM_REFERENCE_MISSING"), "an invoice still needs a reference");
  assert.throws(() => validateAndPrepareDocument({ ...base, subscriptionReference: "ABO-x", quoteReference: "170" }), (error) => error.errors.some((entry) => entry.code === "REFERENCE_NOT_ALLOWED"));
  assert.throws(() => validateAndPrepareDocument({ ...base, documentType: "quote", subscriptionReference: "ABO-atelier-exemple" }), (error) => error.errors.some((entry) => entry.code === "REFERENCE_NOT_ALLOWED"));
});

test("the month's invoice is prepared, issued under the next H-KIDS number, then paid", async (t) => {
  const { as, tokenOf, dir, app } = await setup(t);
  const sara = as(await tokenOf("sara"));
  assert.equal((await sara("POST", "/api/saas/clients", CLIENT)).statusCode, 201);
  assert.equal((await sara("POST", "/api/saas/clients", CLIENT)).statusCode, 409, "one subscription per company");

  const prepared = JSON.parse((await sara("POST", "/api/saas/prepare")).body).prepared;
  assert.equal(prepared.length, 1);
  assert.deepEqual([prepared[0].totalHt, prepared[0].tva, prepared[0].totalTtc], [1499, 299.8, 1798.8]);
  assert.equal(JSON.parse((await sara("POST", "/api/saas/prepare")).body).prepared.length, 0, "never twice for a month");

  const preview = JSON.parse((await sara("POST", "/api/saas/invoices/atelier-exemple/2026-12/preview")).body);
  assert.equal(preview.number, "166", "the next number of H-KIDS' own series");
  assert.equal(preview.document.subscriptionReference, "ABO-atelier-exemple");
  assert.match(preview.document.items[0].designation, /offre Business, décembre 2026/);
  assert.match(preview.document.payment.terms, /au plus tard le 31\/12\/2026/);

  const stale = await sara("POST", "/api/saas/invoices/atelier-exemple/2026-12/issue", { number: String(Number(preview.number) + 1) });
  assert.equal(stale.statusCode, 409, "only the number the direction saw");
  const issued = await sara("POST", "/api/saas/invoices/atelier-exemple/2026-12/issue", { number: String(preview.number) });
  assert.equal(issued.statusCode, 201);
  assert.ok((await readdir(dir)).some((name) => name.startsWith(`facture_HKIDS_${preview.number}_`)), "a real H-KIDS invoice");
  assert.equal((await sara("POST", "/api/saas/invoices/atelier-exemple/2026-12/issue", { number: String(Number(preview.number) + 1) })).statusCode, 409, "never issued twice");

  let overview = JSON.parse((await sara("GET", "/api/saas")).body).overview;
  assert.equal(overview.monthlyHt, 1499);
  assert.equal(overview.byPlan.business, 1);
  assert.equal(overview.unpaid.length, 1);
  assert.equal(overview.unpaid[0].daysLate, 0);

  assert.equal((await sara("POST", "/api/saas/invoices/atelier-exemple/2026-12/paid", { paidOn: "05/12/2026" })).statusCode, 400, "not paid in the future");
  assert.equal((await sara("POST", "/api/saas/invoices/atelier-exemple/2026-12/paid", { paidOn: "01/12/2026", note: "virement reçu" })).statusCode, 200);
  overview = JSON.parse((await sara("GET", "/api/saas")).body).overview;
  assert.equal(overview.unpaid.length, 0);
  assert.equal(overview.paidRecently.length, 1);
  assert.equal(app.hasDecorator("sweepSubscriptions"), true);
});

test("an unpaid invoice is reminded at J+7 and J+15, then the suspension is proposed", async (t) => {
  const { as, tokenOf, setDay } = await setup(t);
  const sara = as(await tokenOf("sara"));
  await sara("POST", "/api/saas/clients", { ...CLIENT, plan: "starter" });
  await sara("POST", "/api/saas/prepare");
  const { number } = JSON.parse((await sara("POST", "/api/saas/invoices/atelier-exemple/2026-12/preview")).body);
  await sara("POST", "/api/saas/invoices/atelier-exemple/2026-12/issue", { number: String(number) });

  setDay("2027-01-08");
  let overview = JSON.parse((await sara("GET", "/api/saas")).body).overview;
  assert.equal(overview.unpaid[0].daysLate, 8);
  assert.equal(overview.unpaid[0].reminderDue, 7);
  assert.match(overview.unpaid[0].reminderText, /reste impayée depuis le 31\/12\/2026/);
  await sara("POST", "/api/saas/invoices/atelier-exemple/2026-12/reminder", { step: 7 });
  overview = JSON.parse((await sara("GET", "/api/saas")).body).overview;
  assert.equal(overview.unpaid[0].reminderDue, null, "reminded once");
  assert.equal(overview.toSuspend.length, 0);

  setDay("2027-02-01");
  overview = JSON.parse((await sara("GET", "/api/saas")).body).overview;
  assert.deepEqual(overview.toSuspend.map((entry) => entry.command), ["sh scripts/tenant.sh suspend atelier-exemple"]);
  assert.equal(overview.lateTtc, 598.8);
});

test("the subscriptions are the direction's, and only on the cockpit that sells them", async (t) => {
  const { as, tokenOf } = await setup(t);
  const karim = as(await tokenOf("karim"));
  assert.equal((await karim("GET", "/api/saas")).statusCode, 403);
  assert.equal(JSON.parse((await karim("GET", "/api/company")).body).saas, false, "no view for who cannot open it");
  assert.equal(JSON.parse((await as(await tokenOf("sara"))("GET", "/api/company")).body).saas, true);
  const client = await setup(t, { saasOperator: false });
  assert.equal((await client.as(await client.tokenOf("sara"))("GET", "/api/saas")).statusCode, 404);
});

test("a suspended company reads its cockpit but changes nothing", async (t) => {
  const { as, tokenOf, app } = await setup(t, { saasOperator: false, suspended: true });
  const sara = as(await tokenOf("sara"));
  assert.equal((await sara("GET", "/api/hr")).statusCode, 200);
  const refused = await sara("POST", "/api/hr/leaves/1/decision", { decision: "approuve" });
  assert.equal(refused.statusCode, 403);
  assert.equal(JSON.parse(refused.body).details.code, "SUBSCRIPTION_SUSPENDED");
  assert.equal(JSON.parse((await sara("GET", "/api/company")).body).suspended, true);
  assert.equal((await sara("POST", "/api/auth/logout")).statusCode < 300, true, "signing out still works");
  void app;
});
