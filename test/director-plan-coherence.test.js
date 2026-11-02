import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository, createDemoBusinessRecords } from "../src/index.js";
import { checkConsistency } from "../src/agent/consistency.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// Records shaped as the business memory stores them. Every name is invented.
const record = (domain, id, status, data) => ({ domain, id, status, data: { id, ...data } });

test("the demo company shows the contradictions no single agent can see", () => {
  const byDomain = {};
  for (const entry of createDemoBusinessRecords()) {
    (byDomain[entry.domain] ??= []).push(entry);
  }
  const codes = checkConsistency(byDomain).map((finding) => finding.code);

  assert.deepEqual(codes, ["PRODUCTION_WITHOUT_DEPOSIT", "PRODUCTION_WITHOUT_ORDER", "PURCHASE_BEFORE_DEPOSIT"]);
  const [first] = checkConsistency(byDomain);
  assert.equal(first.severity, "high", "late deposit on a running order comes first");
  assert.deepEqual([...first.agents], ["production", "finance", "commercial"]);
});

test("each cross-check fires on its own case and stays silent otherwise", () => {
  const findings = checkConsistency({
    quotes: [record("quotes", "Q1", "sent_pending_reply", {})],
    orders: [
      record("orders", "O1", "in_production", { quoteId: "Q1" }),
      record("orders", "O2", "delivered", {}),
      record("orders", "O3", "in_production", {})
    ],
    production: [record("production", "P3", "in_progress", { orderId: "O3" })],
    payments: [
      record("payments", "PAY2", "expected", { orderId: "O2", type: "balance", amount: 4000, currency: "MAD", dueStatus: "overdue" }),
      record("payments", "PAY3", "received", { orderId: "O3", type: "deposit", amount: 6000 })
    ],
    purchase_needs: [
      record("purchase_needs", "N1", "medium", { linkedOrderId: "O2", item: "Panneau MDF" }),
      record("purchase_needs", "N2", "high", { linkedOrderId: "O9", item: "Vernis" })
    ]
  });
  const codes = findings.map((finding) => finding.code).sort();

  assert.deepEqual(codes, ["DELIVERED_NOT_PAID", "ORDER_WITHOUT_ACCEPTED_QUOTE", "PURCHASE_FOR_CLOSED_ORDER", "PURCHASE_FOR_UNKNOWN_ORDER"]);
  assert.ok(!codes.includes("PRODUCTION_WITHOUT_DEPOSIT"), "a received deposit is not a contradiction");
  assert.match(findings.find((f) => f.code === "DELIVERED_NOT_PAID").fact, /4000 MAD/);
});

test("the Director shows its plan, has the agents work it, checks coherence, and reports", async (t) => {
  const isDirector = (p) => p.instructions.startsWith("Tu es le Director IA");
  const lastOutputFor = (p, name) => p.input.filter((item) => item.type === "function_call_output").map((item) => item.call_id).includes(name);
  const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
  const client = { responses: { create: async (p) => {
    if (!isDirector(p)) {
      return { output_text: "Atlas : acompte de 12000 MAD en retard.", output: [] };
    }
    if (!lastOutputFor(p, "plan")) {
      return call("etablir_plan_action", {
        objectif: "Savoir ce qui bloque cette semaine",
        strategie: "Croiser finance et production",
        priorites: ["Acompte Atlas", "Atelier"],
        etapes: [{ agent: "finance", tache: "Lister les encaissements en retard" }, { agent: "production", tache: "Lister les commandes en danger" }]
      }, "plan");
    }
    if (!lastOutputFor(p, "fin")) {
      return call("deleguer_a_un_agent", { agent: "finance", mission: "Encaissements en retard ?" }, "fin");
    }
    if (!lastOutputFor(p, "coh")) {
      return call("verifier_coherence", {}, "coh");
    }
    return { output_text: "La production avance sur Atlas sans acompte : décision à prendre.", output: [] };
  } } };
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), agentClient: client });
  t.after(() => app.close());

  const body = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Qu'est-ce qui bloque cette semaine ?" } })).body);

  assert.equal(body.plan.objective, "Savoir ce qui bloque cette semaine");
  assert.deepEqual(body.plan.steps.map((step) => [step.agent, step.status]), [["finance", "in_progress"], ["production", "todo"]],
    "a step only counts as done once its agent has answered");
  assert.match(body.plan.steps[0].result, /12000 MAD/, "the step keeps what the agent found");
  assert.equal(body.alerts[0].code, "PRODUCTION_WITHOUT_DEPOSIT");
  assert.match(body.reply, /sans acompte/);
});
