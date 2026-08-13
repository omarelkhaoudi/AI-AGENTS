import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  PlannerContractError,
  PrismaRepository,
  createDeterministicPlanner,
  createMvpToolRegistry,
  createPermission,
  createPrismaClient,
  createStubLLMPlanner,
  hasValidDatabaseUrl,
  orchestrateRequest,
  runPlanner,
  seedMvpAgents,
  validatePlannerPlan
} from "../src/index.js";

const postgresIntegrationEnabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const postgresUrlAvailable = hasValidDatabaseUrl(process.env.DATABASE_URL);
const skipReason =
  postgresIntegrationEnabled && postgresUrlAvailable
    ? false
    : "Set RUN_POSTGRES_INTEGRATION=true and DATABASE_URL to run PostgreSQL planner tests.";

test("deterministic planner works through the Planner interface", async () => {
  const request = createPlannerRequest("combien dois-je encaisser cette semaine");
  const plan = await runPlanner(createDeterministicPlanner(), { request });

  assert.equal(plan.planner, "deterministic");
  assert.deepEqual(plan.agents, ["finance"]);
  assert.equal(plan.steps[0].agentId, "finance");
  assert.equal(plan.steps[0].toolName, "get_pending_payments");
  assert.equal(plan.steps[0].requiresApproval, false);
});

test("StubLLMPlanner returns a structured offline plan", async () => {
  const plan = await runPlanner(createStubLLMPlanner(), {
    request: createPlannerRequest("simulate future LLM planning")
  });

  assert.equal(plan.planner, "stub_llm");
  assert.deepEqual(plan.agents, ["finance"]);
  assert.equal(plan.steps[0].toolName, "get_company_overview");
  assert.equal(plan.metadata.network, "disabled");
});

test("validates a valid plan against agents and tools", async () => {
  const { repository, toolRegistry, request } = await createPlannerValidationContext();
  const plan = await runPlanner(createDeterministicPlanner(), { request, repository });

  assert.equal(await validatePlannerPlan(plan, { repository, toolRegistry }), true);
});

test("rejects an invalid plan before execution", async () => {
  const { repository, toolRegistry } = await createPlannerValidationContext();

  await assert.rejects(
    () => validatePlannerPlan({ summary: "", planner: "", agents: [], steps: [] }, { repository, toolRegistry }),
    (error) => error instanceof PlannerContractError && error.code === "PLAN_INVALID"
  );
});

test("rejects a plan with an unknown agent", async () => {
  const { repository, toolRegistry, request } = await createPlannerValidationContext();
  const plan = createPlan({
    request,
    agents: ["unknown-agent"],
    steps: [{ agentId: "unknown-agent", toolName: "get_company_overview" }]
  });

  await assert.rejects(
    () => validatePlannerPlan(plan, { repository, toolRegistry }),
    (error) => hasPlannerValidationDetail(error, "agentId does not exist")
  );
});

test("rejects a plan with an unknown tool", async () => {
  const { repository, toolRegistry, request } = await createPlannerValidationContext();
  const plan = createPlan({
    request,
    agents: ["finance"],
    steps: [{ agentId: "finance", toolName: "missing_tool" }]
  });

  await assert.rejects(
    () => validatePlannerPlan(plan, { repository, toolRegistry }),
    (error) => hasPlannerValidationDetail(error, "toolName does not exist")
  );
});

test("rejects an incomplete step", async () => {
  const { repository, toolRegistry, request } = await createPlannerValidationContext();
  const plan = createPlan({
    request,
    agents: ["finance"],
    steps: [{ agentId: "finance", toolName: "" }]
  });

  await assert.rejects(
    () => validatePlannerPlan(plan, { repository, toolRegistry }),
    (error) => hasPlannerValidationDetail(error, "toolName is required")
  );
});

test("preserves requiresApproval from planner output", async () => {
  const request = createPlannerRequest("approval preservation");
  const plan = await runPlanner(createStubLLMPlanner({
    plan: createPlan({
      request,
      agents: ["finance"],
      steps: [{ agentId: "finance", toolName: "get_company_overview", requiresApproval: true }]
    })
  }), { request });

  assert.equal(plan.steps[0].requiresApproval, true);
});

test("Planner cannot execute tools directly through its context", async () => {
  let toolRegistryWasExposed = false;
  const planner = async ({ request, toolRegistry }) => {
    toolRegistryWasExposed = toolRegistry !== undefined;
    return createPlan({
      request,
      agents: ["finance"],
      steps: [{ agentId: "finance", toolName: "get_company_overview" }]
    });
  };

  const plan = await runPlanner(planner, {
    request: createPlannerRequest("no registry in planner context"),
    toolRegistry: {
      execute() {
        throw new Error("Planner must not execute tools.");
      }
    }
  });

  assert.equal(toolRegistryWasExposed, false);
  assert.equal(plan.steps[0].toolName, "get_company_overview");
});

test("existing orchestration remains compatible with the Planner interface and InMemoryRepository", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const request = await repository.createRequest({
    title: "quels clients dois-je relancer",
    payload: { question: "quels clients dois-je relancer" }
  });

  const result = await orchestrateRequest({ repository, requestId: request.id });

  assert.equal(result.status, "orchestrated");
  assert.equal(result.plans[0].metadata.planner, "deterministic");
  assert.equal(result.plans[0].steps[0].agentId, "commercial");
  assert.equal(result.executions[0].status, "completed");
});

test("invalid planner output stops orchestration before tool execution", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const request = await repository.createRequest({
    title: "invalid planner",
    payload: { question: "invalid planner" }
  });
  const planner = async ({ request: normalizedRequest }) => createPlan({
    request: normalizedRequest,
    agents: ["finance"],
    steps: [{ agentId: "finance", toolName: "missing_tool" }]
  });

  await assert.rejects(
    () => orchestrateRequest({ repository, requestId: request.id, planner }),
    PlannerContractError
  );

  const saved = await repository.getRequest(request.id);
  assert.equal(saved.plans.length, 0);
  assert.equal(saved.executions.length, 0);
  assert.equal(saved.auditEvents.some((event) => event.type === "tool_called"), false);
});

test("Planner validation works with PostgreSQL through orchestration", {
  skip: skipReason
}, async () => {
  const prisma = await createPrismaClient();
  const repository = new PrismaRepository({ prisma });
  let requestId = null;

  try {
    await seedMvpAgents(repository);
    const request = await repository.createRequest({
      title: "fais-moi le point sur mon entreprise",
      payload: { question: "fais-moi le point sur mon entreprise" },
      metadata: { test: "postgres-planner" }
    });
    requestId = request.id;

    const result = await orchestrateRequest({ repository, requestId });

    assert.equal(result.status, "orchestrated");
    assert.equal(result.plans[0].metadata.planner, "deterministic");
    assert.equal(result.plans[0].steps.length, 4);
    assert.equal(result.executions.length, 4);
  } finally {
    if (requestId) {
      await prisma.request.delete({ where: { id: requestId } }).catch(() => undefined);
    }
    await repository.disconnect();
  }
});

async function createPlannerValidationContext() {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const toolRegistry = createMvpToolRegistry({ repository });
  const request = createPlannerRequest("validation context");

  await repository.upsertAgent({
    ...(await repository.getAgent("finance")),
    permissions: [createPermission({ kind: "read_analyze", resource: "request:*" })]
  });

  return { repository, toolRegistry, request };
}

function createPlannerRequest(title) {
  return Object.freeze({
    id: `request-${title.replace(/\W+/g, "-").toLowerCase()}`,
    title,
    payload: { question: title },
    metadata: {},
    createdById: null
  });
}

function createPlan({
  request,
  agents = ["finance"],
  steps = [{ agentId: "finance", toolName: "get_company_overview" }]
}) {
  return Object.freeze({
    summary: "Test planner plan.",
    planner: "test_planner",
    agents,
    steps: steps.map((step, index) => Object.freeze({
      agentId: step.agentId,
      sequence: index + 1,
      actionKind: step.actionKind ?? "read_analyze",
      actionType: step.actionType ?? "analyze_request",
      toolName: step.toolName,
      resource: `request:${request.id}`,
      input: step.input ?? { requestId: request.id },
      requiresApproval: step.requiresApproval ?? false
    })),
    metadata: { planner: "test_planner" }
  });
}

function hasPlannerValidationDetail(error, text) {
  return error instanceof PlannerContractError &&
    error.code === "PLAN_INVALID" &&
    error.details.errors.some((entry) => entry.includes(text));
}
