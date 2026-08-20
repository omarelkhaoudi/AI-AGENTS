import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TOOLS_BY_AGENT,
  PLANNER_PLAN_VERSION,
  PlannerContractError,
  createDeterministicPlan,
  validatePlannerPlan
} from "../src/index.js";

// Reference snapshot of the deterministic planner. It is captured before the
// multi-step refactor and must stay identical after it: this is the proof that
// enabling several steps per agent changes no behaviour.
const REFERENCE_PLANS = Object.freeze([
  {
    label: "company overview",
    message: "Fais-moi le point sur mon entreprise aujourd'hui.",
    intent: "global_company_overview",
    agents: ["finance", "commercial", "production", "purchasing", "hr", "after_sales", "marketing", "community_manager", "legal"],
    steps: [
      // Lot 2C commit 3: finance and commercial each keep their historical tool
      // and gain a computing one, in that order.
      ["finance", 1, "get_pending_payments", "read_analyze", false],
      ["finance", 2, "get_receivables_summary", "read_analyze", false],
      ["commercial", 3, "get_pending_quotes", "read_analyze", false],
      ["commercial", 4, "get_quote_follow_ups", "read_analyze", false],
      // Lot 2C commit 4: production and purchasing follow the same pattern.
      ["production", 5, "get_delayed_production_orders", "read_analyze", false],
      ["production", 6, "get_production_schedule", "read_analyze", false],
      ["purchasing", 7, "get_purchase_needs", "read_analyze", false],
      ["purchasing", 8, "get_material_requirements", "read_analyze", false],
      ["hr", 9, "get_hr_overview", "read_analyze", false],
      ["after_sales", 10, "get_after_sales_overview", "read_analyze", false],
      ["marketing", 11, "get_marketing_overview", "read_analyze", false],
      ["community_manager", 12, "get_community_overview", "read_analyze", false],
      ["legal", 13, "get_legal_overview", "read_analyze", false]
    ]
  },
  {
    label: "finance only",
    message: "Quels paiements sont en retard ?",
    intent: "finance",
    agents: ["finance"],
    steps: [
      ["finance", 1, "get_pending_payments", "read_analyze", false],
      ["finance", 2, "get_receivables_summary", "read_analyze", false]
    ]
  },
  {
    label: "production and purchasing",
    message: "Quels besoins matieres sont lies aux commandes en retard ?",
    intent: "global_company_overview",
    agents: ["production", "purchasing"],
    steps: [
      ["production", 1, "get_delayed_production_orders", "read_analyze", false],
      ["production", 2, "get_production_schedule", "read_analyze", false],
      ["purchasing", 3, "get_purchase_needs", "read_analyze", false],
      ["purchasing", 4, "get_material_requirements", "read_analyze", false]
    ]
  },
  {
    label: "marketing and community manager",
    message: "Prepare la communication commerciale de cette semaine.",
    intent: "global_company_overview",
    agents: ["marketing", "community_manager"],
    steps: [
      ["marketing", 1, "get_marketing_overview", "read_analyze", false],
      ["community_manager", 2, "get_community_overview", "read_analyze", false]
    ]
  },
  {
    label: "sensitive payment",
    message: "Effectue le paiement de cette facture.",
    intent: "sensitive_invoice_payment",
    agents: ["finance"],
    steps: [["finance", 1, "execute_invoice_payment", "execute_action", true]]
  },
  {
    label: "hr only",
    message: "Fais le point RH.",
    intent: "hr",
    agents: ["hr"],
    steps: [["hr", 1, "get_hr_overview", "read_analyze", false]]
  }
]);

function planFor(message, requestId = "req-snap") {
  return createDeterministicPlan({ id: requestId, title: message, payload: { message } });
}

function stepTuple(step) {
  return [step.agentId, step.sequence, step.toolName, step.actionKind, step.requiresApproval];
}

test("the deterministic planner still produces the reference plans", () => {
  for (const reference of REFERENCE_PLANS) {
    const plan = planFor(reference.message);

    assert.equal(plan.version, PLANNER_PLAN_VERSION, reference.label);
    assert.equal(plan.planner, "deterministic", reference.label);
    assert.equal(plan.intent, reference.intent, reference.label);
    assert.deepEqual([...plan.agents], reference.agents, reference.label);
    assert.deepEqual(plan.steps.map(stepTuple), reference.steps, reference.label);
  }
});

test("step ids are still derived from the request, the position and the agent", () => {
  for (const reference of REFERENCE_PLANS) {
    const plan = planFor(reference.message);

    assert.deepEqual(
      plan.steps.map((step) => step.id),
      reference.steps.map(([agentId], index) => `req-snap:deterministic:${index + 1}:${agentId}`),
      reference.label
    );
  }
});

// Sequences are unique per plan in the database schema, not per agent. The
// planner must number steps globally, whatever the number of steps an agent has.
test("sequences are a contiguous run starting at one, with no duplicate", () => {
  for (const reference of REFERENCE_PLANS) {
    const sequences = planFor(reference.message).steps.map((step) => step.sequence);

    assert.deepEqual(sequences, sequences.map((_, index) => index + 1), reference.label);
    assert.equal(new Set(sequences).size, sequences.length, reference.label);
  }
});

test("the plan agent list carries no duplicate", () => {
  for (const reference of REFERENCE_PLANS) {
    const { agents } = planFor(reference.message);

    assert.equal(new Set(agents).size, agents.length, reference.label);
  }
});

// Only these four agents carry a second step. Every other agent keeps exactly
// one, so no routing was widened beyond what Lot 2C commit 4 allows.
const AGENTS_WITH_TWO_STEPS = Object.freeze(["finance", "commercial", "production", "purchasing"]);

test("only the four routed agents contribute a second step", () => {
  for (const reference of REFERENCE_PLANS) {
    const plan = planFor(reference.message);
    const stepsByAgent = new Map();

    for (const step of plan.steps) {
      stepsByAgent.set(step.agentId, (stepsByAgent.get(step.agentId) ?? 0) + 1);
    }

    for (const [agentId, count] of stepsByAgent) {
      const sensitive = plan.intent.startsWith("sensitive_");
      const expected = AGENTS_WITH_TWO_STEPS.includes(agentId) && !sensitive ? 2 : 1;
      assert.equal(count, expected, `${reference.label}: ${agentId}`);
    }
  }
});

test("every planned tool is still one the planner routed before", () => {
  const routable = new Set([
    "get_pending_payments",
    "get_pending_quotes",
    "get_delayed_production_orders",
    "get_purchase_needs",
    "get_hr_overview",
    "get_after_sales_overview",
    "get_marketing_overview",
    "get_community_overview",
    "get_legal_overview",
    "get_receivables_summary",
    "get_quote_follow_ups",
    "get_production_schedule",
    "get_material_requirements",
    "execute_invoice_payment",
    "prepare_hr_sensitive_decision",
    "prepare_legal_sensitive_decision"
  ]);

  for (const reference of REFERENCE_PLANS) {
    for (const step of planFor(reference.message).steps) {
      assert.ok(routable.has(step.toolName), `${reference.label}: ${step.toolName} must not be routed yet`);
    }
  }
});

// The contract already accepts several steps for one agent. This pins that
// behaviour so the refactor can rely on it.
test("a plan with several steps for one agent is accepted", async () => {
  const plan = planFor("Quels paiements sont en retard ?");
  const [first] = plan.steps;
  const extended = {
    ...plan,
    steps: [
      first,
      { ...first, id: `${first.id}:2`, sequence: 2, toolName: "get_pending_quotes" }
    ]
  };

  assert.equal(await validatePlannerPlan(extended), true);
});

test("a plan reusing a sequence is rejected", async () => {
  const plan = planFor("Quels paiements sont en retard ?");
  const [first] = plan.steps;
  const duplicated = {
    ...plan,
    steps: [first, { ...first, id: `${first.id}:2`, toolName: "get_pending_quotes" }]
  };

  await assert.rejects(
    () => validatePlannerPlan(duplicated),
    (error) => {
      assert.ok(error instanceof PlannerContractError);
      assert.ok(
        error.details.errors.some((detail) => detail.includes("sequence")),
        `expected a sequence error, got ${JSON.stringify(error.details)}`
      );
      return true;
    }
  );
});

test("a plan reusing a step id is still rejected", async () => {
  const plan = planFor("Quels paiements sont en retard ?");
  const [first] = plan.steps;
  const duplicated = { ...plan, steps: [first, { ...first, sequence: 2 }] };

  await assert.rejects(
    () => validatePlannerPlan(duplicated),
    (error) => error instanceof PlannerContractError && error.details.errors.some((detail) => detail.includes("duplicated"))
  );
});

// The capability this commit enables, exercised through the seam so the
// production table stays exactly as it is.
test("an agent carrying two tools produces two distinct steps", async () => {
  const plan = createDeterministicPlan(
    { id: "req-two", title: "t", payload: { message: "Quels paiements sont en retard ?" } },
    { toolNamesByAgent: { finance: ["get_pending_payments", "get_overdue_invoices"] } }
  );

  assert.deepEqual([...plan.agents], ["finance"], "the agent list stays free of duplicates");
  assert.deepEqual(
    plan.steps.map((step) => [step.agentId, step.sequence, step.toolName]),
    [
      ["finance", 1, "get_pending_payments"],
      ["finance", 2, "get_overdue_invoices"]
    ]
  );
  assert.equal(new Set(plan.steps.map((step) => step.id)).size, 2, "step ids must stay unique");
  assert.equal(await validatePlannerPlan(plan), true);
});

test("steps stay numbered across the whole plan, not per agent", () => {
  const plan = createDeterministicPlan(
    { id: "req-multi", title: "t", payload: { message: "Quels besoins matieres sont lies aux commandes en retard ?" } },
    {
      toolNamesByAgent: {
        production: ["get_delayed_production_orders", "get_production_schedule"],
        purchasing: ["get_purchase_needs", "get_material_requirements"]
      }
    }
  );

  assert.deepEqual(plan.steps.map((step) => step.sequence), [1, 2, 3, 4]);
  assert.deepEqual(
    plan.steps.map((step) => step.agentId),
    ["production", "production", "purchasing", "purchasing"]
  );
  assert.equal(new Set(plan.steps.map((step) => step.id)).size, 4);
});

test("a sensitive request still collapses the agent to its single approval tool", () => {
  const plan = createDeterministicPlan(
    { id: "req-sensitive", title: "t", payload: { message: "Effectue le paiement de cette facture." } },
    { toolNamesByAgent: { finance: ["get_pending_payments", "get_overdue_invoices"] } }
  );

  assert.deepEqual(plan.steps.map((step) => step.toolName), ["execute_invoice_payment"]);
  assert.equal(plan.steps[0].requiresApproval, true);
});

test("only the four routed agents declare a second tool", () => {
  for (const [agentId, tools] of Object.entries(DEFAULT_TOOLS_BY_AGENT)) {
    assert.ok(Array.isArray(tools), agentId);
    assert.equal(tools.length, AGENTS_WITH_TWO_STEPS.includes(agentId) ? 2 : 1, agentId);
  }

  // The historical tool stays first: the Director keeps reporting it before the
  // computing one.
  assert.deepEqual([...DEFAULT_TOOLS_BY_AGENT.finance], ["get_pending_payments", "get_receivables_summary"]);
  assert.deepEqual([...DEFAULT_TOOLS_BY_AGENT.commercial], ["get_pending_quotes", "get_quote_follow_ups"]);
  assert.deepEqual([...DEFAULT_TOOLS_BY_AGENT.production], ["get_delayed_production_orders", "get_production_schedule"]);
  assert.deepEqual([...DEFAULT_TOOLS_BY_AGENT.purchasing], ["get_purchase_needs", "get_material_requirements"]);
});
