import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { budgetFacts, budgetStatus, createMemoryBudgetBook } from "../src/agent/budget-book.js";
import { runBudgetTool, budgetTools } from "../src/agent/budget-tools.js";
import { createMemoryCashBook } from "../src/agent/cash-book.js";
import { createMemoryImprovementBook } from "../src/agent/improvement-book.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

// The direction's budgets (CDC V2 section 6), read against the cash book.
// Invented amounts and parties only.
const today = new Date("2026-11-20T10:00:00Z");
const clock = () => today;

async function cashWith(lines) {
  const cash = createMemoryCashBook({ clock, expenseThreshold: 1_000_000 });
  for (const line of lines) {
    await cash.record({ confirmDuplicate: true, ...line });
  }
  return cash;
}

test("a budget is the direction's figure: unset gives nothing, cleared is gone, a wrong one is refused", async () => {
  const budgets = createMemoryBudgetBook({ clock });
  await assert.rejects(budgets.set({ monthly: { voyages: "100" } }), { code: "BUDGET_CATEGORY_UNKNOWN" });
  await assert.rejects(budgets.set({ monthly: { transport: "beaucoup" } }), { code: "BUDGET_AMOUNT_INVALID" });
  const saved = await budgets.set({ monthly: { transport: "3 000", salaire: "20000" }, orders: { "BC n° 164": "12000,50" }, cashFloor: "5000" }, { by: "sara" });
  assert.deepEqual(saved.monthly, { transport: 3000, salaire: 20000 });
  assert.deepEqual(saved.orders, { 164: 12000.5 });
  assert.equal(saved.cashFloor, 5000);
  assert.equal(saved.updatedBy, "sara");
  const cleared = await budgets.set({ monthly: { transport: "" }, cashFloor: "aucun" });
  assert.deepEqual([cleared.monthly, cleared.orders, cleared.cashFloor], [{ salaire: 20000 }, { 164: 12000.5 }, null], "only what is given changes");
});

test("overruns of the month and of an order, and cash forecast too low, become alerts for Finance", async () => {
  const cash = await cashWith([
    { kind: "entree", amount: 15000, category: "solde_depart", day: "01/11/2026" },
    { kind: "sortie", amount: 2000, category: "transport", day: "05/11/2026", party: "Transport Exemple" },
    { kind: "sortie", amount: 1500, category: "transport", day: "18/11/2026", party: "Taxi Exemple", orderNumber: "164" },
    { kind: "sortie", amount: 2500, category: "transport", day: "28/10/2026", party: "Ancien Exemple" },
    { kind: "sortie", amount: 4000, category: "achat_matiere", day: "10/11/2026", party: "Bois Exemple", orderNumber: "164" },
    { kind: "sortie", amount: 900, category: "salaire", day: "15/11/2026", party: "Salarié Exemple" }
  ]);
  const orders = [{ number: "164", client: "Client Exemple", totalTtc: 20000, finished: false, steps: [] }];
  const entries = await cash.entries();

  const none = budgetStatus({ monthly: {}, orders: {}, cashFloor: null }, entries, orders, { today });
  assert.deepEqual(budgetFacts(none), [], "no budget, and the forecast stays above zero: no alert");

  const budgets = { monthly: { transport: 3000, achat_matiere: 10000, salaire: 500 }, orders: { 164: 5000 }, cashFloor: 20000 };
  const status = budgetStatus(budgets, entries, orders, { today });
  const transport = status.categories.find((line) => line.category === "transport");
  assert.deepEqual([transport.spent, transport.percent, transport.over], [3500, 116.7, true], "the month only: October's 2 500 DH is not counted");
  assert.equal(status.categories.find((line) => line.category === "achat_matiere").over, false);
  assert.deepEqual(status.orders.map((line) => [line.number, line.client, line.spent, line.over]), [["164", "Client Exemple", 5500, true]]);
  assert.equal(status.cash.below, true, "under the 20 000 DH the direction wants to keep");

  const facts = budgetFacts(status);
  assert.deepEqual(facts.map((fact) => [fact.key, fact.kind, fact.owner, fact.severity]), [
    ["budget:categorie:transport:2026-11", "budget_depasse", "finance", "haute"],
    ["budget:categorie:salaire:2026-11", "budget_depasse", "finance", "haute"],
    ["budget:bc:164", "budget_depasse", "finance", "haute"],
    ["budget:tresorerie", "tresorerie_insuffisante", "finance", "haute"]
  ]);
  assert.match(facts[0].fact, /Budget « Transport et livraison » de novembre 2026 dépassé : 3 500,00 DH dépensés pour un budget de 3 000,00 DH \(116,7 %\)\./);
  assert.doesNotMatch(facts[1].fact, /900|500/, "everyone reads Amélioration: a salary budget's fact carries no amount");
  assert.match(facts[3].fact, /sous le minimum de 20 000,00 DH fixé par la direction/);

  const masked = budgetStatus(budgets, entries, orders, { today, confidential: false }).categories.find((line) => line.category === "salaire");
  assert.deepEqual([masked.budget, masked.spent, masked.masked, masked.over], [null, null, true, true]);

  // In Amélioration, lifted once the cash book no longer shows it; a new
  // month is a new budget.
  const improvement = createMemoryImprovementBook({ clock });
  assert.equal((await improvement.sync([], { budget: facts })).length, 4);
  const december = budgetFacts(budgetStatus(budgets, entries, orders, { today: new Date("2026-12-02T10:00:00Z") }));
  assert.equal(december.some((fact) => fact.key.startsWith("budget:categorie:transport")), false);
  await improvement.sync([], { budget: december });
  assert.equal((await improvement.state()).anomalies.find((entry) => entry.key === "budget:categorie:transport:2026-11").status, "levee");
});

test("Finance reads the budgets; the Director sets one on the direction's word", async () => {
  const cash = await cashWith([{ kind: "entree", amount: 8000, category: "solde_depart", day: "01/11/2026" }, { kind: "sortie", amount: 1200, category: "loyer", day: "02/11/2026", party: "Bailleur Exemple" }]);
  const books = { budget: createMemoryBudgetBook({ clock }), cash, team: { log: async () => {} } };
  const context = { books, workshop: { book: async () => [] }, clock };
  assert.deepEqual(budgetTools(context, "finance").map((entry) => entry.tool.name), ["budgets"]);
  assert.deepEqual(budgetTools(context, "commercial"), []);

  const empty = await runBudgetTool("budgets", {}, context, "finance");
  assert.equal(empty.budgets_du_mois, "aucun budget mensuel fixé par la direction");
  const set = await runBudgetTool("fixer_budget", { type: "categorie", cible: "loyer", montant: "1000" }, context, "sara");
  assert.equal(set.ok, true);
  assert.deepEqual(set.budgets_du_mois, ["Loyer : 1 200 DH dépensés sur 1 000 DH (120 %) — DÉPASSÉ"]);
  const wrong = await runBudgetTool("fixer_budget", { type: "categorie", cible: "vacances", montant: "1000" }, context, "sara");
  assert.equal(wrong.ok, false);
  const order = await runBudgetTool("fixer_budget", { type: "bon_commande", cible: "BC 170", montant: "9000" }, context, "sara");
  assert.deepEqual(order.budgets_par_bon_de_commande, ["BC n° 170 : 0 DH dépensés sur 9 000 DH (0 %)"]);
});

test("the direction sets the budgets in the cockpit; everyone reads them, salaries masked", async (t) => {
  const repository = new InMemoryRepository();
  const cashBook = await cashWith([{ kind: "entree", amount: 3000, category: "solde_depart", day: "01/11/2026" }, { kind: "sortie", amount: 800, category: "transport", day: "03/11/2026", party: "Transport Exemple" }]);
  const { app, inject } = await buildAuthenticatedApi({ repository, clock, cashBook });
  t.after(() => app.close());
  const operator = await createAuthenticatedUser(repository, { id: "karim", role: "operator" });

  assert.equal((await app.inject({ method: "PUT", url: "/api/budgets", payload: { monthly: { transport: "500" } }, headers: operator.headers })).statusCode, 403);
  const invalid = await inject({ method: "PUT", url: "/api/budgets", payload: { monthly: { transport: "-3" } } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(JSON.parse(invalid.body).details.code, "BUDGET_AMOUNT_INVALID");

  const saved = await inject({ method: "PUT", url: "/api/budgets", payload: { monthly: { transport: "500", salaire: "9000" }, cashFloor: "" } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(JSON.parse(saved.body).canDecide, true);

  const read = JSON.parse((await app.inject({ method: "GET", url: "/api/budgets", headers: operator.headers })).body);
  assert.equal(read.canDecide, false);
  assert.deepEqual(read.status.categories.map((line) => [line.category, line.spent, line.over]), [["transport", 800, true], ["salaire", null, false]]);

  const improvement = JSON.parse((await app.inject({ method: "GET", url: "/api/improvement", headers: operator.headers })).body);
  const alert = improvement.anomalies.find((entry) => entry.source === "budget");
  assert.ok(alert, "followed in Amélioration like any anomaly");
  assert.equal(alert.owner, "finance");
});
