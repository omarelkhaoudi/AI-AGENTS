import assert from "node:assert/strict";
import test from "node:test";
import {
  PrismaRepository,
  buildApi,
  createPrismaClient,
  hasValidDatabaseUrl,
  orchestrateRequest,
  seedMvpAgents
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

const postgresIntegrationEnabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const postgresUrlAvailable = hasValidDatabaseUrl(process.env.DATABASE_URL);
const skipReason =
  postgresIntegrationEnabled && postgresUrlAvailable
    ? false
    : "Set RUN_POSTGRES_INTEGRATION=true and DATABASE_URL to run PostgreSQL integration tests.";

test("PostgreSQL persists Request -> Plan -> PlanStep -> Execution -> AuditEvent", {
  skip: skipReason
}, async () => {
  const prisma = await createPrismaClient();
  const repository = new PrismaRepository({ prisma });
  let requestId = null;

  try {
    await seedMvpAgents(repository);
    const request = await repository.createRequest({
      title: "combien dois-je encaisser cette semaine",
      payload: {
        question: "combien dois-je encaisser cette semaine"
      },
      metadata: {
        test: "postgres-integration"
      }
    });
    requestId = request.id;

    const result = await orchestrateRequest({
      repository,
      requestId: request.id
    });

    assert.equal(result.status, "orchestrated");
    assert.equal(result.plans.length, 1);
    assert.equal(result.plans[0].steps.length, 1);
    assert.equal(result.plans[0].steps[0].agentId, "finance");
    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0].status, "completed");
    assert.ok(result.auditEvents.some((event) => event.type === "plan_created"));
    assert.ok(result.auditEvents.some((event) => event.type === "execution_completed"));
  } finally {
    if (requestId) {
      await prisma.request.delete({ where: { id: requestId } }).catch(() => undefined);
    }
    await repository.disconnect();
  }
});

// This test is skipped whenever DATABASE_URL is absent, which is the case in
// the current environment: its expectations are therefore NOT verified by any
// run. They were derived from the in-memory orchestration of the same message,
// which shares the planner and the orchestrator with the Prisma path. It had
// already drifted before Lot 2C commit 4: it expected eight steps and omitted
// the hr agent entirely.
test("API with PostgreSQL persists POST /api/requests and returns full GET details", {
  skip: skipReason
}, async () => {
  const prisma = await createPrismaClient();
  const repository = new PrismaRepository({ prisma });
  const { app, inject } = await buildAuthenticatedApi({ repository });
  let requestId = null;

  try {
    const postResponse = await inject({
      method: "POST",
      url: "/api/requests",
      payload: {
        message: "Fais-moi le point sur mon entreprise aujourd'hui"
      }
    });
    const postBody = JSON.parse(postResponse.body);
    requestId = postBody.request.id;

    assert.equal(postResponse.statusCode, 201);
    assert.equal(postBody.request.status, "orchestrated");
    assert.equal(postBody.request.title, "Fais-moi le point sur mon entreprise aujourd'hui");
    assert.equal(postBody.request.payload.message, "Fais-moi le point sur mon entreprise aujourd'hui");
    assert.equal(postBody.request.plans.length, 1);
    assert.equal(postBody.request.plans[0].steps.length, 13);
    assert.equal(postBody.request.executions.length, 13);
    assert.equal(postBody.request.result.summary.completedExecutions, 13);

    const persistedCounts = await countPersistedRequestGraph(prisma, requestId);
    assert.deepEqual(persistedCounts, {
      requests: 1,
      plans: 1,
      planSteps: 13,
      executions: 13,
      // Eight audit events per step plus two for the request itself.
      auditEvents: 106
    });

    const getResponse = await inject({
      method: "GET",
      url: `/api/requests/${requestId}`
    });
    const getBody = JSON.parse(getResponse.body);

    assert.equal(getResponse.statusCode, 200);
    assert.equal(getBody.request.id, requestId);
    assert.equal(getBody.request.plans[0].steps[0].agent.id, "finance");
    assert.deepEqual(
      getBody.request.plans[0].steps.map((step) => step.agentId),
      [
        "finance",
        "finance",
        "commercial",
        "commercial",
        "production",
        "production",
        "purchasing",
        "purchasing",
        "hr",
        "after_sales",
        "marketing",
        "community_manager",
        "legal"
      ]
    );
    assert.equal(getBody.request.executions.length, 13);
    assert.ok(getBody.request.auditEvents.some((event) => event.type === "request_created"));
    assert.ok(getBody.request.auditEvents.some((event) => event.type === "execution_completed"));
    assert.deepEqual(getBody.request.approvals, []);
  } finally {
    if (requestId) {
      await prisma.request.delete({ where: { id: requestId } }).catch(() => undefined);
    }
    await app.close();
  }
});

async function countPersistedRequestGraph(prisma, requestId) {
  const [requests, plans, planSteps, executions, auditEvents] = await Promise.all([
    prisma.request.count({ where: { id: requestId } }),
    prisma.plan.count({ where: { requestId } }),
    prisma.planStep.count({ where: { plan: { requestId } } }),
    prisma.execution.count({ where: { requestId } }),
    prisma.auditEvent.count({ where: { requestId } })
  ]);

  return {
    requests,
    plans,
    planSteps,
    executions,
    auditEvents
  };
}
