import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { createMemoryPlanStore } from "../src/agent/plan-store.js";
import { currentMonth, measureObjective } from "../src/agent/sales-objective.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// Records shaped as the workbook import stores them. Every name is invented.
const quote = (id, status, amount, issuedAt, extra = {}) => ({ id, status, source: "hkids_workbook", dates: { issuedAt }, data: { id, status, amount, ...extra } });
const order = (id, quoteId, orderedAt) => ({ id, status: "in_production", data: { id, quoteId, orderedAt } });
const payment = (id, status, amount, extra) => ({ id, status, data: { id, status, amount, ...extra } });

const RECORDS = {
  quotes: [
    quote("D-201", "accepted", 30000, "2026-10-25"),
    quote("D-202", "accepted_pending_deposit", 12000, "2026-11-03"),
    quote("D-203", "accepted", null, "2026-11-04"),
    quote("D-204", "sent_pending_reply", 25000, "2026-10-28", { noResponseDays: 9 }),
    quote("D-205", "sent_pending_reply", 8000, "2026-11-05", { noResponseDays: 1 }),
    quote("D-206", "rejected", 50000, "2026-11-02")
  ],
  // D-201 was quoted in October but signed in November: it counts in November.
  orders: [order("BC-301", "D-201", "2026-11-02")],
  payments: [
    payment("P-1", "received", 18000, { paidAt: "2026-11-04" }),
    payment("P-2", "expected", 7200, { expectedPaymentDate: "2026-11-20" }),
    payment("P-3", "received", 5000, { paidAt: "2026-10-30" })
  ]
};

test("an objective is measured from the data: signed, gap, open quotes and the pace per day", () => {
  const result = measureObjective(RECORDS, { amount: 100000, ...currentMonth(new Date("2026-11-10")), today: new Date("2026-11-10T09:00:00Z") });

  assert.deepEqual(result.period, { from: "2026-11-01", to: "2026-11-30", daysLeft: 21 });
  assert.equal(result.achieved, 42000, "D-201 by its order date and D-202; the rejected quote never counts");
  assert.equal(result.signedSales.withoutAmount, 1, "a sale with no amount is reported, not counted as zero");
  assert.equal(result.gap, 58000);
  assert.equal(result.percent, 42);
  assert.equal(result.pacePerDay, 2761.9);
  assert.deepEqual(
    { count: result.openQuotes.count, amount: result.openQuotes.amount, needFollowUp: result.openQuotes.needFollowUp, coverGap: result.openQuotes.coverGap },
    { count: 2, amount: 33000, needFollowUp: 1, coverGap: false },
    "the open quotes cannot close the gap alone: new business is needed"
  );
  assert.equal(result.openQuotes.largest[0].id, "D-204");
  assert.equal(result.collected.amount, 18000, "only money received in the period");
  assert.equal(result.toCollect.amount, 7200);
  assert.equal(result.demo, false);
});

test("collections are measured on money received, and a reached target says so", () => {
  const result = measureObjective(RECORDS, { indicator: "encaissements", amount: 15000, from: "2026-11-01", to: "2026-11-30", today: new Date("2026-11-10") });
  assert.equal(result.achieved, 18000);
  assert.equal(result.gap, 0);
  assert.equal(result.reached, true);
  assert.equal(result.percent, 100);
});

test("given a revenue objective, the Director measures, sets the strategy, gives each head their share, and the plan tracks the figure", async (t) => {
  const isDirector = (p) => p.instructions.startsWith("Tu es le Director IA");
  const answered = (p) => p.input.filter((item) => item.type === "function_call_output").map((item) => item.call_id);
  const call = (name, args, id) => ({ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) });
  const missions = [];
  const client = { responses: { create: async (p) => {
    if (!isDirector(p)) {
      missions.push({ agent: p.instructions.includes("Tu es l'agent Commercial") ? "commercial" : "marketing", mission: p.input[0].content });
      return { output_text: "Plan : relancer 2 devis (33 000 DH), produire 6 devis. Hypothèse : 60 000 DH signés.", output: [] };
    }
    const done = answered(p);
    if (!done.includes("m")) {
      return { output: [call("mesurer_objectif", { indicateur: "ventes_signees", montant: 100000, du: "", au: "" }, "m")] };
    }
    if (!done.includes("plan")) {
      return { output: [call("etablir_plan_action", {
        objectif: "100 000 DH de chiffre d'affaires en novembre",
        objectif_chiffre: { indicateur: "ventes_signees", montant: 100000, du: "", au: "" },
        strategie: "Relancer les devis ouverts, puis générer de nouvelles demandes.",
        priorites: ["Devis ouverts", "Nouvelles demandes"],
        etapes: [
          { agent: "commercial", tache: "Signer 60 000 DH : relances et nouveaux devis", echeance: "2026-11-20" },
          { agent: "marketing", tache: "Générer 15 demandes de devis", echeance: "2026-11-15" }
        ]
      }, "plan")] };
    }
    if (!done.includes("c")) {
      return { output: [
        call("deleguer_a_un_agent", { agent: "commercial", mission: "Ta part : 60 000 DH de ventes signées en novembre. Ton plan chiffré ?" }, "c"),
        call("deleguer_a_un_agent", { agent: "marketing", mission: "Ta part : 15 demandes de devis en novembre. Ton plan ?" }, "k")
      ] };
    }
    return { output_text: "Stratégie proposée : 0 DH signé sur 100 000 DH ; le Commercial vise 60 000 DH.", output: [] };
  } } };
  const planStore = createMemoryPlanStore();
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), agentClient: client, planStore });
  t.after(() => app.close());

  const body = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Je veux qu'on fasse 100 000 DH de chiffre d'affaires ce mois." } })).body);

  assert.deepEqual(missions.map((entry) => entry.agent).sort(), ["commercial", "marketing"], "each head gets their share");
  assert.equal(body.plan.target.amount, 100000);
  assert.match(body.plan.target.from, /^\d{4}-\d{2}-01$/, "no period given: the current month");
  assert.equal(body.plan.measure.target, 100000);
  assert.equal(body.plan.measure.gap, 100000 - body.plan.measure.achieved);
  assert.equal(body.plan.measure.demo, true, "the demo company says it is a demo");
  assert.deepEqual(body.plan.steps.map((step) => step.status), ["in_progress", "in_progress"]);

  const { plans } = JSON.parse((await inject({ method: "GET", url: "/api/plans" })).body);
  assert.equal(plans[0].measure.target, 100000, "the Plans view shows the figure, measured afresh");
});

test("a plain quote touches no plan and brings no alerts, even with a plan waiting on the Commercial", async (t) => {
  const planStore = createMemoryPlanStore();
  const plan = await planStore.create({ objective: "100 000 DH en novembre", steps: [{ agent: "commercial", task: "Signer 60 000 DH" }] });
  const isDirector = (p) => p.instructions.startsWith("Tu es le Director IA");
  const client = { responses: { create: async (p) => {
    if (!isDirector(p)) {
      return { output_text: "Il manque l'adresse de la cliente.", output: [] };
    }
    return p.input.some((item) => item.type === "function_call_output")
      ? { output_text: "Quelle est l'adresse de Meriem ?", output: [] }
      : { output: [{ type: "function_call", name: "deleguer_a_un_agent", call_id: "d1", arguments: JSON.stringify({ agent: "commercial", mission: "Devis pour Meriem : 1 lit nuage à 3000 DH TTC." }) }] };
  } } };
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), agentClient: client, planStore });
  t.after(() => app.close());

  const body = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "un devis pour Meriem, lit nuage 3000" } })).body);
  assert.equal(body.plan, null);
  assert.equal(body.alerts, null);
  assert.equal((await planStore.get(plan.id)).steps[0].status, "todo");
});
