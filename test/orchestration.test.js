import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  PrismaRepository,
  buildApi,
  createPermission,
  createRepository,
  hasValidDatabaseUrl,
  orchestrateRequest,
  seedMvpAgents
} from "../src/index.js";

test("repository factory uses in-memory repository when DATABASE_URL is missing", async () => {
  const repository = await createRepository({ env: {} });
  assert.ok(repository instanceof InMemoryRepository);
  assert.equal(hasValidDatabaseUrl(undefined), false);
  assert.equal(hasValidDatabaseUrl("not-a-url"), false);
});

test("repository factory uses PrismaRepository when DATABASE_URL is valid", async () => {
  const repository = await createRepository({
    env: { DATABASE_URL: "postgresql://user:pass@localhost:5432/ai_agents" },
    prisma: {}
  });
  assert.ok(repository instanceof PrismaRepository);
  assert.equal(hasValidDatabaseUrl("postgresql://user:pass@localhost:5432/ai_agents"), true);
});

test("MVP agent seed is idempotent and creates active agent records", async () => {
  const repository = new InMemoryRepository();

  await seedMvpAgents(repository);
  await seedMvpAgents(repository);

  const agents = await repository.listAgents();
  assert.deepEqual(
    agents.map((agent) => agent.id),
    ["director", "commercial", "finance", "production", "purchasing"]
  );
  assert.equal((await repository.getAgent("director")).role, "orchestrator");
  assert.equal((await repository.getAgent("finance")).status, "available");
});

test("Request Finance routes to finance agent", async () => {
  const request = await createOrchestratedRequest("combien dois-je encaisser cette semaine");
  assert.deepEqual(selectedAgents(request), ["finance"]);
  assert.equal(request.plans[0].steps[0].toolName, "get_pending_payments");
  assert.equal(request.executions[0].output.toolId, "get_pending_payments");
  assert.equal(request.executions[0].output.result.demo, true);
});

test("Request Commercial routes to commercial agent", async () => {
  const request = await createOrchestratedRequest("quels clients dois-je relancer");
  assert.deepEqual(selectedAgents(request), ["commercial"]);
});

test("Request Production routes to production agent", async () => {
  const request = await createOrchestratedRequest("quelles commandes risquent d'etre en retard");
  assert.deepEqual(selectedAgents(request), ["production"]);
});

test("Request Purchasing routes to purchasing agent", async () => {
  const request = await createOrchestratedRequest("qu'est-ce que je dois commander");
  assert.deepEqual(selectedAgents(request), ["purchasing"]);
});

test("Global request routes to all specialized agents", async () => {
  const request = await createOrchestratedRequest("fais-moi le point sur mon entreprise");
  assert.deepEqual(selectedAgents(request), ["finance", "commercial", "production", "purchasing"]);
});

test("orchestration creates a Plan", async () => {
  const request = await createOrchestratedRequest("combien dois-je encaisser cette semaine");
  assert.equal(request.plans.length, 1);
  assert.equal(request.plans[0].createdByAgentId, "director");
  assert.equal(request.plans[0].summary, "Deterministic MVP plan generated from request wording.");
});

test("orchestration creates PlanSteps", async () => {
  const request = await createOrchestratedRequest("fais-moi le point sur mon entreprise");
  assert.equal(request.plans[0].steps.length, 4);
  assert.deepEqual(
    request.plans[0].steps.map((step) => step.sequence),
    [1, 2, 3, 4]
  );
});

test("orchestration creates Executions", async () => {
  const request = await createOrchestratedRequest("quels clients dois-je relancer");
  assert.equal(request.executions.length, 1);
  assert.equal(request.executions[0].agentId, "commercial");
  assert.equal(request.executions[0].status, "completed");
});

test("orchestration creates AuditEvents", async () => {
  const request = await createOrchestratedRequest("qu'est-ce que je dois commander");
  const eventTypes = request.auditEvents.map((event) => event.type);

  assert.ok(eventTypes.includes("plan_created"));
  assert.ok(eventTypes.includes("plan_step_created"));
  assert.ok(eventTypes.includes("agent_selected"));
  assert.ok(eventTypes.includes("permission_checked"));
  assert.ok(eventTypes.includes("execution_created"));
});

test("orchestration allows permitted read/analyze actions", async () => {
  const request = await createOrchestratedRequest("combien dois-je encaisser cette semaine");
  const eventTypes = request.auditEvents.map((event) => event.type);

  assert.equal(request.status, "orchestrated");
  assert.ok(eventTypes.includes("permission_checked"));
  assert.equal(eventTypes.includes("permission_denied"), false);
});

test("orchestration blocks denied permissions", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  await repository.upsertAgent({
    ...(await repository.getAgent("finance")),
    permissions: []
  });
  const request = await repository.createRequest({
    title: "combien dois-je encaisser cette semaine",
    payload: { question: "combien dois-je encaisser cette semaine" }
  });

  const result = await orchestrateRequest({ repository, requestId: request.id });
  const eventTypes = result.auditEvents.map((event) => event.type);

  assert.equal(result.status, "blocked");
  assert.equal(result.executions[0].status, "blocked");
  assert.ok(eventTypes.includes("permission_denied"));
});

test("GET /api/requests/:id returns full request orchestration details", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const createdResponse = await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: {
      title: "fais-moi le point sur mon entreprise",
      payload: { question: "fais-moi le point sur mon entreprise" }
    }
  });
  const created = JSON.parse(createdResponse.body).request;

  const response = await app.inject({ method: "GET", url: `/api/requests/${created.id}` });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.request.status, "orchestrated");
  assert.equal(body.request.plans.length, 1);
  assert.equal(body.request.plans[0].steps.length, 4);
  assert.equal(body.request.plans[0].steps[0].agent.id, "finance");
  assert.equal(body.request.executions.length, 4);
  assert.ok(body.request.auditEvents.length >= 1);
  assert.deepEqual(body.request.approvals, []);
});

async function createOrchestratedRequest(title) {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const request = await repository.createRequest({
    title,
    payload: { question: title }
  });

  return orchestrateRequest({ repository, requestId: request.id });
}

function selectedAgents(request) {
  return request.plans[0].steps.map((step) => step.agentId);
}
