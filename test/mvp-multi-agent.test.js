import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  ToolExecutionService,
  ToolExecutionServiceError,
  ToolRegistry,
  listAgentBusinessConfigs,
  buildApi,
  getAgentBusinessConfig,
  createMockToolAdapter,
  createMvpAgentDefinitions,
  createMvpAgentHierarchy,
  createMvpTools,
  createMvpToolRegistry,
  createPermission,
  createToolDefinition,
  createToolInputSchema,
  seedMvpAgents,
  validateAgentBusinessConfig
} from "../src/index.js";

const CDC_CORE_AGENT_IDS = Object.freeze([
  "finance",
  "commercial",
  "production",
  "purchasing",
  "after_sales"
]);

const CDC_CORE_TOOL_IDS = Object.freeze([
  "get_pending_payments",
  "get_pending_quotes",
  "get_delayed_production_orders",
  "get_purchase_needs",
  "get_after_sales_overview"
]);

const CDC_CORE_RESPONSE_AGENT_IDS = Object.freeze([
  "director",
  ...CDC_CORE_AGENT_IDS
]);

const MVP_ORG_AGENT_IDS = Object.freeze([
  "director",
  "commercial",
  "finance",
  "production",
  "purchasing",
  "hr",
  "after_sales",
  "marketing",
  "community_manager",
  "legal"
]);

test("MVP central scenario orchestrates the CDC priority agents offline", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: {
      message: "Fais-moi le point complet de l'entreprise aujourd'hui."
    }
  });
  const body = JSON.parse(response.body);
  const request = body.request;
  const plan = request.plans[0];
  const events = request.auditEvents.map((event) => event.type);

  assert.equal(response.statusCode, 201);
  assert.equal(request.status, "orchestrated");
  assert.deepEqual(plan.steps.map((step) => step.agentId), CDC_CORE_AGENT_IDS);
  assert.deepEqual(plan.steps.map((step) => step.toolName), CDC_CORE_TOOL_IDS);
  assert.deepEqual(plan.steps.map((step) => step.sequence), [1, 2, 3, 4, 5]);
  assert.equal(request.executions.length, 5);
  assert.equal(request.executions.every((execution) => execution.status === "completed"), true);
  assert.equal(request.executions.every((execution) => execution.output.result.demo === true), true);
  assert.equal(request.executions.every((execution) => execution.output.result.dataSource === "demo_mock"), true);
  assert.equal(request.result.summary.completedExecutions, 5);
  assert.deepEqual(request.result.summary.agents, CDC_CORE_AGENT_IDS);
  assert.equal(request.result.toolResults.every((result) => result.demo === true), true);
  assert.deepEqual(request.approvals, []);
  assert.ok(events.includes("request_created"));
  assert.ok(events.includes("plan_created"));
  assert.equal(events.filter((type) => type === "permission_checked").length, 5);
  assert.equal(events.filter((type) => type === "tool_called").length, 5);
  assert.equal(events.filter((type) => type === "execution_completed").length, 5);
});

test("POST /api/director/requests returns a clean consolidated demo response", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/director/requests",
    payload: {
      message: "Fais-moi le point complet de l'entreprise aujourd'hui."
    }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "completed");
  assert.equal(body.message, "Fais-moi le point complet de l'entreprise aujourd'hui.");
  assert.match(body.summary.headline, /Point complete: 5\/5 agents responded/);
  assert.deepEqual(body.agents.map((agent) => agent.id), CDC_CORE_RESPONSE_AGENT_IDS);
  assert.deepEqual(body.agents.slice(1).map((agent) => agent.tool), CDC_CORE_TOOL_IDS);
  assert.equal(body.results.length, 5);
  assert.equal(body.results.every((result) => result.result.demo === true), true);
  assert.equal(body.findings.every((finding) => finding.demo === true), true);
  assert.equal(body.summary.receivables.length > 0, true);
  assert.equal(body.summary.purchaseNeeds.length > 0, true);
  assert.equal(body.summary.delayed.length > 0, true);
  assert.equal(body.summary.blockers.length > 0, true);
  assert.equal(body.summary.decisionsRequired.length > 0, true);
  assert.equal(body.decisionsRequired.some((decision) => decision.type === "business_decision"), true);
  assert.ok(body.audit.some((event) => event.type === "request_created"));
  assert.ok(body.audit.some((event) => event.type === "plan_created"));
  assert.equal(body.audit.filter((event) => event.type === "permission_checked").length, 5);
  assert.equal(body.audit.filter((event) => event.type === "tool_called").length, 5);
  assert.equal(body.audit.filter((event) => event.type === "execution_completed").length, 5);
  assert.doesNotMatch(response.body, /api[_-]?key|password|token|secret/i);
});

test("MVP business scenarios A to I return coherent Director summaries from demo tools only", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const scenarios = [
    {
      label: "A",
      message: "Fais-moi le point complet de l'entreprise aujourd'hui.",
      agents: CDC_CORE_AGENT_IDS,
      assertBody: (body) => {
        assert.equal(body.summary.delayed.length > 0, true);
        assert.equal(body.summary.receivables.length > 0, true);
        assert.equal(body.summary.purchaseNeeds.length > 0, true);
        assert.equal(body.summary.blockers.length > 0, true);
        assert.equal(body.summary.decisionsRequired.length > 0, true);
      }
    },
    {
      label: "B",
      message: "Quels sont les problemes importants aujourd'hui ?",
      agents: CDC_CORE_AGENT_IDS,
      assertBody: (body) => {
        assert.equal(body.summary.urgent.length > 0, true);
        assert.equal(body.findings.some((finding) => finding.priority === "urgent"), true);
        assert.equal(body.summary.monitoring.length > 0, true);
      }
    },
    {
      label: "C",
      message: "Combien devons-nous encaisser cette semaine ?",
      agents: ["finance"],
      assertBody: (body) => {
        const payments = body.results[0].result.items;
        const total = payments.reduce((sum, payment) => sum + payment.amount, 0);
        assert.equal(total, 20500);
        assert.equal(payments.every((payment) => payment.due === "this_week"), true);
      }
    },
    {
      label: "D",
      message: "Quels clients devons-nous relancer ?",
      agents: ["commercial"],
      assertBody: (body) => {
        assert.equal(body.results[0].tool, "get_pending_quotes");
        assert.equal(body.results[0].result.items.some((quote) => quote.status.includes("pending")), true);
        assert.equal(body.audit.some((event) => event.type === "approval_requested"), false);
      }
    },
    {
      label: "E",
      message: "Quelles commandes risquent d'etre en retard ?",
      agents: ["production"],
      assertBody: (body) => {
        const timings = body.results[0].result.items.map((item) => item.timing);
        assert.equal(timings.includes("a l'heure"), true);
        assert.equal(timings.includes("a surveiller"), true);
        assert.equal(timings.includes("en danger"), true);
      }
    },
    {
      label: "F",
      message: "Qu'est-ce qu'on doit commander aujourd'hui ?",
      agents: ["purchasing"],
      assertBody: (body) => {
        const needs = body.results[0].result.items;
        assert.equal(needs.every((need) => typeof need.quantity === "number"), true);
        assert.equal(needs.every((need) => typeof need.supplierName === "string"), true);
      }
    },
    {
      label: "G",
      message: "Prepare la communication de cette semaine.",
      agents: ["marketing", "community_manager"],
      assertBody: (body) => {
        assert.deepEqual(body.summary.marketingSynthesis.flow, ["community_manager", "marketing", "director"]);
        assert.equal(body.hierarchy.find((entry) => entry.agentId === "director").supervisedAgentIds.includes("community_manager"), false);
      }
    },
    {
      label: "H",
      message: "Quels problemes SAV devons-nous traiter ?",
      agents: ["after_sales"],
      assertBody: (body) => {
        assert.equal(body.summary.afterSales.length > 0, true);
        assert.equal(body.results[0].result.items.every((entry) => entry.status === "open"), true);
      }
    },
    {
      label: "I",
      message: "Y a-t-il des sujets juridiques importants ?",
      agents: ["legal"],
      assertBody: (body) => {
        assert.equal(body.summary.legal.length > 0, true);
        assert.equal(body.results[0].result.items.some((entry) => entry.urgency === "high"), true);
      }
    }
  ];

  for (const scenario of scenarios) {
    const { body, response } = await postDirector(app, scenario.message);
    assert.equal(response.statusCode, 201, scenario.label);
    assert.equal(body.status, "completed", scenario.label);
    assert.deepEqual(body.results.map((result) => result.agent), scenario.agents, scenario.label);
    assert.equal(body.results.every((result) => result.result.demo === true), true, scenario.label);
    assertAuditContains(body, ["request_created", "plan_created", "permission_checked", "tool_called", "execution_completed"], scenario.label);
    assert.equal(body.findings.every((finding) =>
      finding.agent &&
      finding.type &&
      finding.priority &&
      finding.title &&
      finding.description &&
      finding.source
    ), true, scenario.label);
    assert.doesNotMatch(JSON.stringify(body), /api[_-]?key|password|token|secret/i, scenario.label);
    scenario.assertBody(body);
  }
});

test("Director API returns coherent functional MVP responses for leader requests", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const scenarios = [
    {
      message: "Fais-moi le point complet de l'entreprise aujourd'hui.",
      status: "completed",
      agents: CDC_CORE_AGENT_IDS,
      tools: CDC_CORE_TOOL_IDS,
      verify: (body) => {
        assert.equal(body.summary.receivables.length > 0, true);
        assert.equal(body.summary.purchaseNeeds.length > 0, true);
        assert.equal(body.summary.afterSales.length > 0, true);
        assert.equal(body.decisionsRequired.some((decision) => decision.type === "business_decision"), true);
      }
    },
    {
      message: "Qu'est-ce qui est urgent aujourd'hui ?",
      status: "completed",
      agents: CDC_CORE_AGENT_IDS,
      tools: CDC_CORE_TOOL_IDS,
      verify: (body) => {
        assert.equal(body.summary.urgent.length > 0, true);
        assert.equal(body.summary.monitoring.length > 0, true);
      }
    },
    {
      message: "Combien devons-nous encaisser cette semaine ?",
      status: "completed",
      agents: ["finance"],
      tools: ["get_pending_payments"],
      verify: (body) => {
        assert.equal(body.summary.receivables.length > 0, true);
        assert.equal(body.results[0].result.items.every((item) => item.currency === "MAD"), true);
      }
    },
    {
      message: "Quelles commandes risquent d'etre en retard ?",
      status: "completed",
      agents: ["production"],
      tools: ["get_delayed_production_orders"],
      verify: (body) => {
        assert.equal(body.summary.delayed.length > 0, true);
      }
    },
    {
      message: "Quels clients devons-nous relancer ?",
      status: "completed",
      agents: ["commercial"],
      tools: ["get_pending_quotes"],
      verify: (body) => {
        assert.equal(body.results[0].result.items.some((item) => item.status.includes("pending")), true);
      }
    },
    {
      message: "Qu'est-ce qu'on doit commander aujourd'hui ?",
      status: "completed",
      agents: ["purchasing"],
      tools: ["get_purchase_needs"],
      verify: (body) => {
        assert.equal(body.summary.purchaseNeeds.length > 0, true);
      }
    },
    {
      message: "Quels sont les problemes SAV importants ?",
      status: "completed",
      agents: ["after_sales"],
      tools: ["get_after_sales_overview"],
      verify: (body) => {
        assert.equal(body.summary.afterSales.length > 0, true);
      }
    },
    {
      message: "Quels sont les sujets RH importants ?",
      status: "completed",
      agents: ["hr"],
      tools: ["get_hr_overview"],
      verify: (body) => {
        assert.equal(body.results[0].result.items.every((item) => item.id.startsWith("hr-")), true);
      }
    },
    {
      message: "Que devons-nous publier cette semaine ?",
      status: "completed",
      agents: ["marketing", "community_manager"],
      tools: ["get_marketing_overview", "get_community_overview"],
      verify: (body) => {
        assert.deepEqual(body.summary.marketingSynthesis.flow, ["community_manager", "marketing", "director"]);
        assert.equal(body.results[1].supervisorAgentId, "marketing");
      }
    },
    {
      message: "Y a-t-il des sujets juridiques importants ?",
      status: "completed",
      agents: ["legal"],
      tools: ["get_legal_overview"],
      verify: (body) => {
        assert.equal(body.summary.legal.length > 0, true);
      }
    },
    {
      message: "Effectue le paiement de cette facture.",
      status: "requires_approval",
      agents: ["finance"],
      tools: ["execute_invoice_payment"],
      verify: (body) => {
        assert.equal(body.results[0].status, "not_executed");
        assert.equal(body.results[0].result, null);
        assert.equal(body.decisionsRequired.some((decision) => decision.type === "approval"), true);
        assert.equal(body.audit.some((event) => event.type === "approval_requested"), true);
        assert.equal(body.audit.some((event) => event.type === "tool_called"), false);
      }
    }
  ];

  for (const scenario of scenarios) {
    const { body, response } = await postDirector(app, scenario.message);
    assert.equal(response.statusCode, 201, scenario.message);
    assert.equal(body.status, scenario.status, scenario.message);
    assert.deepEqual(body.results.map((result) => result.agent), scenario.agents, scenario.message);
    assert.deepEqual(body.results.map((result) => result.tool), scenario.tools, scenario.message);
    assert.equal(body.audit.some((event) => event.type === "request_created"), true, scenario.message);
    assert.equal(body.audit.some((event) => event.type === "plan_created"), true, scenario.message);
    assert.equal(body.audit.some((event) => event.type === "permission_checked"), true, scenario.message);
    assert.equal(body.results.every((result) => result.result === null || result.result.demo === true), true, scenario.message);
    assert.doesNotMatch(JSON.stringify(body), /api[_-]?key|password|token|secret/i, scenario.message);
    scenario.verify(body);
  }
});

test("Director routes multi-domain finance and production requests without planner execution", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const { body, response } = await postDirector(app, "Combien devons-nous encaisser et quelles commandes risquent d'etre en retard ?");

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "completed");
  assert.deepEqual(body.results.map((result) => result.agent), ["finance", "production"]);
  assert.deepEqual(body.results.map((result) => result.tool), ["get_pending_payments", "get_delayed_production_orders"]);
  assert.equal(body.audit.filter((event) => event.type === "tool_called").length, 2);
  assert.equal(body.audit.filter((event) => event.type === "execution_completed").length, 2);
  assert.equal(body.audit.some((event) => event.type === "approval_requested"), false);
});

test("Director routes commercial and purchasing requests together", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const { body, response } = await postDirector(app, "Quels clients devons-nous relancer et que devons-nous commander ?");

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "completed");
  assert.deepEqual(body.results.map((result) => result.agent), ["commercial", "purchasing"]);
  assert.deepEqual(body.results.map((result) => result.tool), ["get_pending_quotes", "get_purchase_needs"]);
  assert.equal(body.summary.purchaseNeeds.length > 0, true);
  assert.equal(body.audit.filter((event) => event.type === "tool_called").length, 2);
});

test("Director keeps HR requests limited to HR", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const { body, response } = await postDirector(app, "Fais-moi le point RH sur les absences et conges.");

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "completed");
  assert.deepEqual(body.results.map((result) => result.agent), ["hr"]);
  assert.equal(body.results[0].tool, "get_hr_overview");
  assert.equal(body.results[0].result.demo, true);
  assert.equal(body.results[0].result.dataSource, "demo_mock");
  assert.equal(body.results.some((result) => ["finance", "marketing", "production"].includes(result.agent)), false);
});

test("Director routes communication requests through Marketing supervision", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const { body, response } = await postDirector(app, "Prepare la communication de cette semaine.");

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "completed");
  assert.deepEqual(body.results.map((result) => result.agent), ["marketing", "community_manager"]);
  assert.equal(body.results[1].delegatedByAgentId, "marketing");
  assert.equal(body.results[1].supervisorAgentId, "marketing");
  assert.deepEqual(body.summary.marketingSynthesis.flow, ["community_manager", "marketing", "director"]);
  assert.equal(body.hierarchy.find((entry) => entry.agentId === "director").supervisedAgentIds.includes("community_manager"), false);
});

test("MVP business scenario J creates approval and does not execute payment", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const { body, response } = await postDirector(app, "Effectue le paiement de cette facture.");

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "requires_approval");
  assert.deepEqual(body.results.map((result) => result.agent), ["finance"]);
  assert.equal(body.results[0].tool, "execute_invoice_payment");
  assert.equal(body.results[0].status, "not_executed");
  assert.equal(body.results[0].result, null);
  assert.equal(body.decisionsRequired.length, 1);
  assert.equal(body.decisionsRequired[0].type, "approval");
  assert.equal(body.decisionsRequired[0].action, "execute_invoice_payment");
  assert.equal(body.audit.some((event) => event.type === "approval_requested"), true);
  assert.equal(body.audit.some((event) => event.type === "tool_called"), false);
  assert.equal(body.audit.some((event) => event.type === "execution_completed"), false);
});

test("POST /api/director/requests routes weekly communication through Marketing then Community Manager", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/director/requests",
    payload: {
      message: "Prepare la communication de cette semaine."
    }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "completed");
  assert.deepEqual(body.results.map((result) => result.agent), ["marketing", "community_manager"]);
  assert.deepEqual(body.results.map((result) => result.tool), ["get_marketing_overview", "get_community_overview"]);
  assert.equal(body.results[0].supervisedAgentIds.includes("community_manager"), true);
  assert.equal(body.results[1].supervisorAgentId, "marketing");
  assert.equal(body.results[1].delegatedByAgentId, "marketing");
  assert.deepEqual(body.summary.marketingSynthesis.flow, ["community_manager", "marketing", "director"]);
  assert.equal(body.summary.marketingSynthesis.status, "completed");
  assert.equal(body.summary.marketingSynthesis.marketingItems.length > 0, true);
  assert.equal(body.summary.marketingSynthesis.communityItems.length > 0, true);
  assert.deepEqual(body.hierarchy, [
    {
      agentId: "director",
      supervisorAgentId: null,
      supervisedAgentIds: ["marketing"]
    },
    {
      agentId: "marketing",
      supervisorAgentId: "director",
      supervisedAgentIds: ["community_manager"]
    },
    {
      agentId: "community_manager",
      supervisorAgentId: "marketing",
      supervisedAgentIds: []
    }
  ]);
  assert.equal(body.audit.filter((event) => event.type === "tool_called").length, 2);
  assert.doesNotMatch(response.body, /api[_-]?key|password|token|secret/i);
});

test("POST /api/director/requests reports partial results when Marketing is unavailable", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({
    repository,
    toolRegistry: createMarketingFailureRegistry()
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/director/requests",
    payload: {
      message: "Prepare la communication de cette semaine."
    }
  });
  const body = JSON.parse(response.body);
  const marketing = body.results.find((result) => result.agent === "marketing");

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "partial");
  assert.match(body.summary.headline, /1 agent\(s\) out of 2/);
  assert.match(body.summary.headline, /marketing/);
  assert.equal(body.results.filter((result) => result.status === "completed").length, 1);
  assert.equal(marketing.status, "failed");
  assert.equal(marketing.result, null);
  assert.equal(marketing.error.code, "TOOL_FAILED");
  assert.equal(body.findings.find((finding) => finding.agent === "marketing").itemCount, 0);
  assert.equal(body.summary.sections.whatIsGoingWell.some((entry) => entry.agent === "marketing"), false);
  assert.ok(body.audit.some((event) => event.type === "tool_failed"));
});

test("POST /api/director/requests reports partial results when an agent is unavailable", async (t) => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  await repository.upsertAgent({
    ...(await repository.getAgent("marketing")),
    status: "disabled"
  });
  const app = buildApi({ repository, seedAgents: false });
  t.after(() => app.close());

  const { body, response } = await postDirector(app, "Prepare la communication de cette semaine.");
  const marketing = body.results.find((result) => result.agent === "marketing");

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "partial");
  assert.equal(marketing.status, "blocked");
  assert.equal(marketing.result, null);
  assert.equal(body.summary.sections.whatIsGoingWell.some((entry) => entry.agent === "marketing"), false);
  assert.equal(body.audit.some((event) => event.type === "permission_denied" && event.agentId === "marketing"), true);
});

test("POST /api/director/requests preserves empty tool results without inventing findings", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({
    repository,
    toolRegistry: createEmptyLegalRegistry()
  });
  t.after(() => app.close());

  const { body, response } = await postDirector(app, "Y a-t-il des sujets juridiques importants ?");

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "completed");
  assert.equal(body.results[0].agent, "legal");
  assert.deepEqual(body.results[0].result.items, []);
  assert.equal(body.summary.legal.length, 0);
  assert.equal(body.findings[0].itemCount, 0);
});

test("POST /api/director/requests creates approval for sensitive actions without executing the tool", async (t) => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  await repository.upsertAgent({
    ...(await repository.getAgent("finance")),
    permissions: [
      createPermission({ kind: "execute_action", resource: "request:*" })
    ]
  });
  const app = buildApi({
    repository,
    seedAgents: false,
    planner: createSensitivePaymentPlanner(),
    toolRegistry: createSensitivePaymentRegistry()
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/director/requests",
    payload: {
      message: "Effectue le paiement de cette facture."
    }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "requires_approval");
  assert.equal(body.decisionsRequired.length, 1);
  assert.equal(body.decisionsRequired[0].type, "approval");
  assert.equal(body.decisionsRequired[0].action, "execute_invoice_payment");
  assert.match(body.summary.headline, /approval/);
  assert.equal(body.results[0].status, "not_executed");
  assert.equal(body.audit.some((event) => event.type === "approval_requested"), true);
  assert.equal(body.audit.some((event) => event.type === "tool_called"), false);

  const approveResponse = await app.inject({
    method: "POST",
    url: `/api/approvals/${body.decisionsRequired[0].approvalId}/approve`,
    payload: { approverId: "leader-demo" }
  });
  const approveBody = JSON.parse(approveResponse.body);
  const events = await repository.listAuditEvents({ requestId: body.requestId });

  assert.equal(approveResponse.statusCode, 200);
  assert.equal(approveBody.execution.status, "completed");
  assert.equal(events.some((event) => event.type === "tool_called"), true);
  assert.equal(events.some((event) => event.type === "approval_granted"), true);

  const secondApproveResponse = await app.inject({
    method: "POST",
    url: `/api/approvals/${body.decisionsRequired[0].approvalId}/approve`,
    payload: { approverId: "leader-demo" }
  });
  assert.equal(secondApproveResponse.statusCode, 409);
});

test("MVP organization chart documents every agent responsibility and access boundary", () => {
  const agents = createMvpAgentDefinitions();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));

  assert.deepEqual(agents.map((agent) => agent.id), MVP_ORG_AGENT_IDS);
  assert.equal(byId.get("director").metadata.supervisorAgentId, null);
  assert.equal(byId.get("marketing").metadata.supervisorAgentId, "director");
  assert.equal(byId.get("community_manager").metadata.supervisorAgentId, "marketing");
  assert.equal(byId.get("commercial").metadata.supervisorAgentId, "director");
  assert.equal(byId.get("finance").metadata.supervisorAgentId, "director");
  assert.equal(byId.get("production").metadata.supervisorAgentId, "director");
  assert.equal(byId.get("purchasing").metadata.supervisorAgentId, "director");
  assert.equal(byId.get("hr").metadata.supervisorAgentId, "director");
  assert.equal(byId.get("after_sales").metadata.supervisorAgentId, "director");
  assert.equal(byId.get("legal").metadata.supervisorAgentId, "director");
  assert.deepEqual(byId.get("marketing").metadata.supervisedAgentIds, ["community_manager"]);
  assert.deepEqual(byId.get("hr").metadata.supervisedAgentIds, []);
  assert.deepEqual(byId.get("community_manager").metadata.supervisedAgentIds, []);
  for (const agent of agents) {
    assert.equal(agent.status, "available");
    assert.equal(typeof agent.metadata.mission, "string");
    assert.equal(agent.metadata.mission.length > 0, true);
    assert.equal(agent.metadata.responsibilities.length > 0, true);
    assert.equal(agent.metadata.accessibleInformation.length > 0, true);
    assert.equal(agent.metadata.authorizedActions.length > 0, true);
    assert.equal(agent.metadata.approvalRequiredActions.length > 0, true);
    assert.equal(agent.tools.length > 0, true);
  }
});

test("HR agent contract, hierarchy, and business configuration are declarative", () => {
  const agents = createMvpAgentDefinitions();
  const hr = agents.find((agent) => agent.id === "hr");
  const config = getAgentBusinessConfig("hr");

  assert.equal(hr.name, "Ressources Humaines");
  assert.equal(hr.metadata.supervisorAgentId, "director");
  assert.deepEqual(hr.metadata.supervisedAgentIds, []);
  assert.equal(hr.metadata.sensitivity, "high");
  assert.deepEqual(hr.metadata.authorizedActions, ["read_analyze", "prepare_action"]);
  assert.deepEqual(hr.metadata.approvalRequiredActions, ["execute_action", "human_approval_required"]);
  assert.equal(hr.tools.includes("get_hr_overview"), true);
  assert.equal(hr.tools.includes("get_pending_payments"), false);
  assert.equal(hr.tools.includes("get_marketing_overview"), false);
  assert.equal(hr.tools.includes("get_delayed_production_orders"), false);
  assert.equal(hr.tools.includes("get_pending_quotes"), false);
  assert.equal(config.businessRules.every((rule) => typeof rule.id === "string" && typeof rule.trigger === "string"), true);
  assert.equal(config.businessRules.some((rule) => rule.requiresApproval === true), true);
  assert.equal(config.procedures.every((procedure) => typeof procedure.id === "string" && Array.isArray(procedure.steps)), true);
  assert.equal(config.procedures.some((procedure) => procedure.id.includes("draft")), true);
});

test("Every MVP agent exposes coherent business configuration through agent metadata", () => {
  const agents = createMvpAgentDefinitions();
  const configByAgent = new Map(listAgentBusinessConfigs().map((entry) => [entry.agentId, entry.config]));

  assert.deepEqual([...configByAgent.keys()], MVP_ORG_AGENT_IDS);
  for (const agent of agents) {
    const config = configByAgent.get(agent.id);
    const validation = validateAgentBusinessConfig(agent.id, config);
    assert.ok(config);
    assert.deepEqual(validation, { ok: true, errors: [] });
    assert.equal(agent.name, config.name);
    assert.equal(agent.description, config.description);
    assert.deepEqual(agent.capabilities, config.responsibilities);
    assert.deepEqual(agent.tools, config.tools);
    assert.equal(agent.metadata.mission, config.mission);
    assert.deepEqual(agent.metadata.responsibilities, config.responsibilities);
    assert.deepEqual(agent.metadata.accessibleInformation, config.accessibleInformation);
    assert.deepEqual(agent.metadata.authorizedActions, config.authorizedActions);
    assert.deepEqual(agent.metadata.approvalRequiredActions, config.approvalRequiredActions);
    assert.deepEqual(agent.metadata.businessRules, config.businessRules);
    assert.deepEqual(agent.metadata.procedures, config.procedures);
    assert.deepEqual(agent.metadata.promptInstructions, config.promptInstructions);
    assert.equal(agent.metadata.sensitivity, config.sensitivity);
  }
});

test("Business configuration keeps access boundaries explicit", () => {
  const marketing = getAgentBusinessConfig("marketing");
  const production = getAgentBusinessConfig("production");
  const hr = getAgentBusinessConfig("hr");
  const communityManager = createMvpAgentHierarchy().find((entry) => entry.agentId === "community_manager");
  const legal = createMvpAgentHierarchy().find((entry) => entry.agentId === "legal");

  assert.equal(marketing.accessibleInformation.some((entry) => entry.includes("receivable") || entry.includes("invoice")), false);
  assert.equal(marketing.tools.includes("get_pending_payments"), false);
  assert.equal(production.accessibleInformation.some((entry) => entry.startsWith("hr_")), false);
  assert.equal(production.tools.includes("get_hr_overview"), false);
  assert.equal(hr.accessibleInformation.some((entry) =>
    entry.includes("finance") ||
    entry.includes("marketing") ||
    entry.includes("production") ||
    entry.includes("receivable") ||
    entry.includes("invoice")
  ), false);
  assert.equal(hr.tools.includes("get_pending_payments"), false);
  assert.equal(hr.tools.includes("get_marketing_overview"), false);
  assert.equal(hr.tools.includes("get_delayed_production_orders"), false);
  assert.equal(communityManager.supervisorAgentId, "marketing");
  assert.equal(legal.supervisorAgentId, "director");
});

test("Community Manager is subordinate to Marketing and not a sibling agent", () => {
  const hierarchy = createMvpAgentHierarchy();
  const byId = new Map(hierarchy.map((entry) => [entry.agentId, entry]));

  assert.equal(byId.get("community_manager").supervisorAgentId, "marketing");
  assert.equal(byId.get("marketing").supervisedAgentIds.includes("community_manager"), true);
  assert.equal(byId.get("director").supervisedAgentIds.includes("marketing"), true);
  assert.equal(byId.get("director").supervisedAgentIds.includes("community_manager"), false);
});

test("Marketing receives Community Manager results before Director synthesis", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/director/requests",
    payload: {
      message: "Prepare la communication de cette semaine."
    }
  });
  const body = JSON.parse(response.body);
  const synthesis = body.summary.marketingSynthesis;

  assert.equal(response.statusCode, 201);
  assert.equal(synthesis.agent, "marketing");
  assert.equal(synthesis.delegatedAgentId, "community_manager");
  assert.equal(synthesis.communityItems.some((item) => item.id === "community-post-q3"), true);
  assert.equal(synthesis.marketingItems.some((item) => item.linkedCommunityTaskId === "community-post-q3"), true);
  assert.equal(body.findings.some((finding) => finding.agent === "community_manager" && finding.itemCount > 0), true);
  assert.equal(body.findings.some((finding) => finding.agent === "marketing" && finding.itemCount > 0), true);
});

test("MVP tools expose only their authorized specialized agents", () => {
  const registry = createMvpToolRegistry();
  const authorizations = new Map(registry.list().map((tool) => [tool.id, tool.allowedAgents]));

  assert.deepEqual(authorizations.get("get_pending_payments"), ["finance"]);
  assert.deepEqual(authorizations.get("get_marketing_overview"), ["marketing"]);
  assert.deepEqual(authorizations.get("get_community_overview"), ["community_manager"]);
  assert.deepEqual(authorizations.get("get_hr_overview"), ["hr"]);
  assert.deepEqual(authorizations.get("get_legal_overview"), ["legal"]);
  assert.equal(authorizations.get("get_pending_payments").includes("marketing"), false);
  assert.equal(authorizations.get("get_pending_payments").includes("hr"), false);
  assert.equal(authorizations.get("get_marketing_overview").includes("hr"), false);
  assert.equal(authorizations.get("get_delayed_production_orders").includes("hr"), false);
  assert.equal(authorizations.get("get_pending_quotes").includes("hr"), false);
  assert.equal(authorizations.get("get_community_overview").includes("marketing"), false);
  assert.equal(authorizations.get("get_marketing_overview").includes("community_manager"), false);
  assert.equal(authorizations.get("get_after_sales_overview").includes("community_manager"), false);
});

test("HR can execute only its mock overview tool and receives demo-marked data", async () => {
  const { service } = await createServiceHarness();
  const result = await service.execute(createServiceInput({
    agentId: "hr",
    toolId: "get_hr_overview"
  }));

  assert.equal(result.status, "completed");
  assert.equal(result.output.result.demo, true);
  assert.equal(result.output.result.dataSource, "demo_mock");
  assert.match(result.output.result.notice, /Demonstration data only/);
  assert.equal(result.output.result.items.length > 0, true);
  assert.equal(result.output.result.items.every((item) => item.id.startsWith("hr-")), true);
});

test("Marketing cannot execute a finance tool", async () => {
  const { repository, service } = await createServiceHarness();

  await assert.rejects(
    () => service.execute(createServiceInput({
      agentId: "marketing",
      toolId: "get_pending_payments"
    })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED"
  );

  await assertNoToolCall(repository);
});

test("Non-HR agents cannot execute the HR overview tool", async () => {
  const { repository, service } = await createServiceHarness();

  for (const agentId of ["finance", "commercial", "production", "purchasing", "marketing", "community_manager", "legal"]) {
    await assert.rejects(
      () => service.execute(createServiceInput({
        agentId,
        toolId: "get_hr_overview"
      })),
      (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED"
    );
  }

  await assertNoToolCall(repository);
});

test("Community Manager cannot execute a restricted HR tool", async () => {
  const { repository, service } = await createServiceHarness({
    registry: createRestrictedRegistry({
      toolId: "read_hr_records",
      allowedAgents: ["finance"]
    })
  });

  await assert.rejects(
    () => service.execute(createServiceInput({
      agentId: "community_manager",
      toolId: "read_hr_records"
    })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED"
  );

  await assertNoToolCall(repository);
});

test("Sensitive HR actions require human approval and are never auto-executed", async () => {
  const { repository, service } = await createServiceHarness({
    registry: createRestrictedRegistry({
      toolId: "update_hr_contract",
      allowedAgents: ["hr"],
      requiredPermission: "execute_action"
    })
  });

  await assert.rejects(
    () => service.execute(createServiceInput({
      agentId: "hr",
      toolId: "update_hr_contract",
      agentPermissions: [
        createPermission({ kind: "execute_action", resource: "request:*" })
      ]
    })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "APPROVAL_REQUIRED"
  );

  const events = await repository.listAuditEvents({ requestId: "req-mvp-security" });
  assert.equal(events.some((event) => event.type === "approval_requested"), true);
  assert.equal(events.some((event) => event.type === "tool_called"), false);
});

test("Legal cannot execute a restricted banking tool", async () => {
  const { repository, service } = await createServiceHarness({
    registry: createRestrictedRegistry({
      toolId: "read_banking_records",
      allowedAgents: ["finance"]
    })
  });

  await assert.rejects(
    () => service.execute(createServiceInput({
      agentId: "legal",
      toolId: "read_banking_records"
    })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED"
  );

  await assertNoToolCall(repository);
});

test("Production cannot execute a restricted HR tool", async () => {
  const { repository, service } = await createServiceHarness({
    registry: createRestrictedRegistry({
      toolId: "read_hr_records",
      allowedAgents: ["finance"]
    })
  });

  await assert.rejects(
    () => service.execute(createServiceInput({
      agentId: "production",
      toolId: "read_hr_records"
    })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED"
  );

  await assertNoToolCall(repository);
});

test("Commercial cannot execute sensitive legal action without permission", async () => {
  const { repository, service } = await createServiceHarness({
    registry: createRestrictedRegistry({
      toolId: "approve_legal_contract",
      allowedAgents: ["legal"],
      requiredPermission: "execute_action"
    })
  });

  await assert.rejects(
    () => service.execute(createServiceInput({
      agentId: "commercial",
      toolId: "approve_legal_contract",
      agentPermissions: []
    })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED"
  );

  await assertNoToolCall(repository);
});

test("unknown agents, unknown tools, and forbidden permissions are rejected before tool execution", async () => {
  const { repository, service } = await createServiceHarness();

  await assert.rejects(
    () => service.execute(createServiceInput({
      agentId: "missing_agent",
      toolId: "get_marketing_overview"
    })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED"
  );
  await assert.rejects(
    () => service.execute(createServiceInput({
      agentId: "marketing",
      toolId: "missing_tool"
    })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "TOOL_NOT_FOUND"
  );
  await assert.rejects(
    () => service.execute(createServiceInput({
      agentId: "marketing",
      toolId: "get_marketing_overview",
      agentPermissions: []
    })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "PERMISSION_DENIED"
  );

  await assertNoToolCall(repository);
});

test("sensitive MVP actions require approval and cannot bypass ToolExecutionService", async () => {
  const { repository, service } = await createServiceHarness({
    registry: createRestrictedRegistry({
      toolId: "publish_marketing_campaign",
      allowedAgents: ["marketing"],
      requiredPermission: "execute_action"
    })
  });

  await assert.rejects(
    () => service.execute(createServiceInput({
      agentId: "marketing",
      toolId: "publish_marketing_campaign",
      agentPermissions: [
        createPermission({ kind: "execute_action", resource: "request:*" })
      ]
    })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "APPROVAL_REQUIRED"
  );

  const events = await repository.listAuditEvents({ requestId: "req-mvp-security" });
  assert.ok(events.some((event) => event.type === "approval_requested"));
  assert.equal(events.some((event) => event.type === "tool_called"), false);
});

async function createServiceHarness({ registry = null } = {}) {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const service = new ToolExecutionService({
    repository,
    toolRegistry: registry ?? createMvpToolRegistry({ repository })
  });
  return { repository, service };
}

async function postDirector(app, message) {
  const response = await app.inject({
    method: "POST",
    url: "/api/director/requests",
    payload: { message }
  });
  return {
    response,
    body: JSON.parse(response.body)
  };
}

function assertAuditContains(body, types, label = "") {
  for (const type of types) {
    assert.equal(body.audit.some((event) => event.type === type), true, `${label} missing ${type}`);
  }
}

function createMarketingFailureRegistry() {
  const registry = new ToolRegistry();
  for (const tool of createMvpTools()) {
    if (tool.id !== "get_marketing_overview") {
      registry.register(tool);
    }
  }

  const inputSchema = createToolInputSchema({
    required: ["requestId"],
    properties: {
      requestId: { type: "string" }
    }
  });
  registry.register(createToolDefinition({
    id: "get_marketing_overview",
    name: "Get Marketing Overview",
    description: "Failing local test tool for unavailable marketing demo.",
    category: "marketing",
    requiredPermission: "read_analyze",
    allowedAgents: ["marketing"],
    inputSchema,
    adapter: createMockToolAdapter({
      toolId: "get_marketing_overview",
      inputSchema,
      resolve: async () => {
        throw new Error("Marketing demo source unavailable.");
      }
    })
  }));
  return registry;
}

function createEmptyLegalRegistry() {
  const registry = new ToolRegistry();
  for (const tool of createMvpTools()) {
    if (tool.id !== "get_legal_overview") {
      registry.register(tool);
    }
  }

  const inputSchema = createToolInputSchema({
    required: ["requestId"],
    properties: {
      requestId: { type: "string" }
    }
  });
  registry.register(createToolDefinition({
    id: "get_legal_overview",
    name: "Get Legal Overview",
    description: "Empty local test tool for legal demo.",
    category: "legal",
    requiredPermission: "read_analyze",
    allowedAgents: ["legal"],
    inputSchema,
    adapter: createMockToolAdapter({
      toolId: "get_legal_overview",
      inputSchema,
      resolve: async () => ({
        demo: true,
        dataSource: "demo_mock",
        notice: "Demonstration data only. This is not real company data.",
        items: []
      })
    })
  }));
  return registry;
}

function createSensitivePaymentPlanner() {
  return async ({ request }) => Object.freeze({
    version: "1",
    requestId: request.id,
    intent: "sensitive_payment_request",
    summary: "Prepare a sensitive payment action for human approval.",
    planner: "test_sensitive_payment",
    agents: ["finance"],
    steps: [
      Object.freeze({
        id: `${request.id}:test-sensitive-payment:1:finance`,
        agentId: "finance",
        sequence: 1,
        actionKind: "execute_action",
        actionType: "execute_invoice_payment",
        toolName: "execute_invoice_payment",
        resource: `request:${request.id}`,
        reason: "Payment execution is sensitive and must be approved by a human.",
        input: { requestId: request.id },
        requiresApproval: false
      })
    ],
    metadata: { planner: "test_sensitive_payment" }
  });
}

function createSensitivePaymentRegistry() {
  return createRestrictedRegistry({
    toolId: "execute_invoice_payment",
    allowedAgents: ["finance"],
    requiredPermission: "execute_action"
  });
}

function createServiceInput({
  agentId,
  toolId,
  agentPermissions = [
    createPermission({ kind: "read_analyze", resource: "request:*" })
  ]
} = {}) {
  return {
    agentId,
    agentPermissions,
    toolId,
    input: { requestId: "req-mvp-security" },
    requestId: "req-mvp-security",
    planId: "plan-mvp-security",
    planStepId: "step-mvp-security"
  };
}

function createRestrictedRegistry({
  toolId,
  allowedAgents,
  requiredPermission = "read_analyze"
}) {
  const registry = new ToolRegistry();
  const inputSchema = createToolInputSchema({
    required: ["requestId"],
    properties: {
      requestId: { type: "string" }
    }
  });
  registry.register(createToolDefinition({
    id: toolId,
    name: toolId,
    description: "Restricted local test tool.",
    category: "security_test",
    requiredPermission,
    allowedAgents,
    inputSchema,
    adapter: createMockToolAdapter({
      toolId,
      inputSchema,
      resolve: async () => ({
        demo: true,
        dataSource: "security_test_mock",
        items: []
      })
    })
  }));
  return registry;
}

async function assertNoToolCall(repository) {
  const events = await repository.listAuditEvents({ requestId: "req-mvp-security" });
  assert.equal(events.some((event) => event.type === "tool_called"), false);
}
