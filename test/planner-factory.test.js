import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  PlannerConfigurationError,
  PlanningError,
  PrismaRepository,
  buildApi,
  createPlannerConfig,
  createPlannerFromConfig,
  createPrismaClient,
  hasValidDatabaseUrl,
  loadFoundationConfig,
  orchestrateRequest,
  seedMvpAgents
} from "../src/index.js";

const postgresIntegrationEnabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const postgresUrlAvailable = hasValidDatabaseUrl(process.env.DATABASE_URL);
const postgresSkipReason =
  postgresIntegrationEnabled && postgresUrlAvailable
    ? false
    : "Set RUN_POSTGRES_INTEGRATION=true and DATABASE_URL to run PostgreSQL planner factory tests.";

test("missing PLANNER_PROVIDER selects the deterministic planner by default", () => {
  const config = createPlannerConfig({});
  const planner = createPlannerFromConfig(config);

  assert.equal(config.provider, "deterministic");
  assert.equal(planner.id, "deterministic");
  assert.equal(planner.kind, "deterministic");
});

test("PLANNER_PROVIDER=deterministic selects DeterministicPlanner", () => {
  const planner = createPlannerFromConfig(createPlannerConfig({
    PLANNER_PROVIDER: "deterministic"
  }));

  assert.equal(planner.id, "deterministic");
  assert.equal(planner.kind, "deterministic");
});

test("PLANNER_PROVIDER=stub_llm selects StubLLMPlanner", () => {
  const planner = createPlannerFromConfig(createPlannerConfig({
    PLANNER_PROVIDER: "stub_llm"
  }));

  assert.equal(planner.id, "stub_llm");
  assert.equal(planner.kind, "llm_stub");
});

test("PLANNER_PROVIDER=llm_mock selects LlmPlanner with MockLlmProvider", async () => {
  const repository = await createRepositoryWithAgents();
  const planner = createPlannerFromConfig(createPlannerConfig({
    PLANNER_PROVIDER: "llm_mock"
  }));
  const request = await repository.createRequest({
    title: "llm mock planner",
    payload: { question: "llm mock planner" }
  });

  const result = await orchestrateRequest({
    repository,
    requestId: request.id,
    planner
  });

  assert.equal(planner.kind, "llm");
  assert.equal(result.status, "orchestrated");
  assert.equal(result.plans[0].metadata.planner, "llm_mock");
});

test("unknown planner provider fails with CONFIGURATION_ERROR", () => {
  assert.throws(
    () => createPlannerConfig({ PLANNER_PROVIDER: "unknown" }),
    (error) => error instanceof PlannerConfigurationError && error.code === "CONFIGURATION_ERROR"
  );

  assert.throws(
    () => createPlannerFromConfig({ provider: "unknown" }),
    (error) => error instanceof PlannerConfigurationError && error.code === "CONFIGURATION_ERROR"
  );
});

test("loadFoundationConfig exposes planner configuration", () => {
  const config = loadFoundationConfig({
    NODE_ENV: "test",
    PLANNER_PROVIDER: "stub_llm"
  });

  assert.deepEqual(config.planner, { provider: "stub_llm" });
});

test("API uses the configured planner selection", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({
    repository,
    config: {
      planner: { provider: "llm_mock" }
    }
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: { message: "use configured planner" }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 201);
  assert.equal(body.request.status, "orchestrated");
  assert.equal(body.request.plans[0].metadata.planner, "llm_mock");
});

test("planner failure becomes a clean orchestration error", async () => {
  const repository = await createRepositoryWithAgents();
  const request = await repository.createRequest({
    title: "planner failure",
    payload: { question: "planner failure" }
  });
  const planner = async () => {
    throw new Error("provider internal failure");
  };

  await assert.rejects(
    () => orchestrateRequest({ repository, requestId: request.id, planner }),
    (error) => error instanceof PlanningError && error.code === "PLANNING_FAILED"
  );
});

test("API exposes planning failures without stack traces or sensitive data", async (t) => {
  const repository = new InMemoryRepository();
  const planner = async () => {
    throw new Error("internal failure with should-not-leak");
  };
  const app = buildApi({ repository, planner });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: {
      message: "planner failure",
      metadata: {
        visible: "ok"
      }
    }
  });
  const bodyText = response.body;
  const body = JSON.parse(bodyText);

  assert.equal(response.statusCode, 500);
  assert.equal(body.error, "Request orchestration failed.");
  assert.equal(body.details.name, "PlanningError");
  assert.equal(body.details.code, "PLANNING_FAILED");
  assert.doesNotMatch(bodyText, /stack|should-not-leak|internal failure/i);
});

test("planner factory does not perform external network calls", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("Network calls are forbidden in planner selection tests.");
  };

  try {
    const repository = await createRepositoryWithAgents();
    const request = await repository.createRequest({
      title: "network safety",
      payload: { question: "network safety" }
    });
    await orchestrateRequest({
      repository,
      requestId: request.id,
      planner: createPlannerFromConfig({ provider: "llm_mock" })
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalled, false);
});

test("configured planner works with InMemoryRepository", async () => {
  const repository = await createRepositoryWithAgents();
  const request = await repository.createRequest({
    title: "in memory configured planner",
    payload: { question: "in memory configured planner" }
  });

  const result = await orchestrateRequest({
    repository,
    requestId: request.id,
    planner: createPlannerFromConfig({ provider: "stub_llm" })
  });

  assert.equal(result.status, "orchestrated");
  assert.equal(result.plans[0].metadata.planner, "stub_llm");
});

test("configured planner works with PostgreSQL integration", {
  skip: postgresSkipReason
}, async () => {
  const prisma = await createPrismaClient();
  const repository = new PrismaRepository({ prisma });
  let requestId = null;

  try {
    await seedMvpAgents(repository);
    const request = await repository.createRequest({
      title: "postgres configured planner",
      payload: { question: "postgres configured planner" },
      metadata: { test: "postgres-planner-factory" }
    });
    requestId = request.id;

    const result = await orchestrateRequest({
      repository,
      requestId,
      planner: createPlannerFromConfig({ provider: "llm_mock" })
    });

    assert.equal(result.status, "orchestrated");
    assert.equal(result.plans[0].metadata.planner, "llm_mock");
    assert.equal(result.executions.length, 1);
  } finally {
    if (requestId) {
      await prisma.request.delete({ where: { id: requestId } }).catch(() => undefined);
    }
    await repository.disconnect();
  }
});

async function createRepositoryWithAgents() {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  return repository;
}
