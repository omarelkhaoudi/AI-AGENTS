import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  LlmPlannerError,
  LlmProviderError,
  buildPlannerPrompt,
  createLlmPlanner,
  createMockLlmProvider,
  createMvpToolRegistry,
  createProviderTimeoutError,
  hasValidDatabaseUrl,
  orchestrateRequest,
  runPlanner,
  seedMvpAgents
} from "../src/index.js";

test("mock LLM provider returns a deterministic structured plan", async () => {
  const provider = createMockLlmProvider();
  const plan = await provider.generateStructuredPlan({
    request: createRequest("provider mock")
  });

  assert.equal(plan.planner, "llm_mock");
  assert.equal(plan.steps[0].agentId, "finance");
  assert.equal(plan.steps[0].toolName, "get_company_overview");
});

test("planner prompt includes safe planning context only", async () => {
  const repository = await createRepositoryWithAgents();
  const registry = createMvpToolRegistry({ repository });
  const prompt = buildPlannerPrompt({
    request: {
      ...createRequest("prompt context"),
      payload: {
        message: "prompt context",
        [sensitiveKey("api", "Key")]: "should-not-leak"
      }
    },
    agents: await repository.listAgents(),
    tools: registry.list()
  });

  assert.match(prompt.system, /Return only valid JSON/);
  assert.match(prompt.user, /availableAgents/);
  assert.match(prompt.user, /availableTools/);
  assert.doesNotMatch(prompt.user, /should-not-leak/);
  assert.match(prompt.user, /\[REDACTED\]/);
});

test("LLM planner generates a valid plan through the provider boundary", async () => {
  const repository = await createRepositoryWithAgents();
  const planner = createLlmPlanner({ provider: createMockLlmProvider() });
  const plan = await runPlanner(planner, {
    request: createRequest("fais-moi le point"),
    repository
  });

  assert.equal(plan.planner, "llm_mock");
  assert.equal(plan.steps[0].requiresApproval, false);
  assert.equal(plan.metadata.source, "llm_provider");
});

test("LLM planner rejects invalid provider response", async () => {
  const repository = await createRepositoryWithAgents();
  const planner = createLlmPlanner({
    provider: createMockLlmProvider({ plan: "not json" })
  });

  await assert.rejects(
    () => runPlanner(planner, { request: createRequest("bad json"), repository }),
    (error) => error instanceof LlmPlannerError && error.code === "JSON_INVALID"
  );
});

test("LLM planner rejects unknown agents", async () => {
  const repository = await createRepositoryWithAgents();
  const planner = createLlmPlanner({
    provider: createMockLlmProvider({
      plan: createPlan({
        requestId: "req-agent",
        agents: ["unknown-agent"],
        steps: [{ agentId: "unknown-agent", toolName: "get_company_overview" }]
      })
    })
  });

  await assert.rejects(
    () => runPlanner(planner, { request: createRequest("unknown agent", "req-agent"), repository }),
    (error) => error instanceof LlmPlannerError && error.code === "AGENT_UNKNOWN"
  );
});

test("LLM planner rejects unknown tools", async () => {
  const repository = await createRepositoryWithAgents();
  const planner = createLlmPlanner({
    provider: createMockLlmProvider({
      plan: createPlan({
        requestId: "req-tool",
        steps: [{ agentId: "finance", toolName: "missing_tool" }]
      })
    })
  });

  await assert.rejects(
    () => runPlanner(planner, { request: createRequest("unknown tool", "req-tool"), repository }),
    (error) => error instanceof LlmPlannerError && error.code === "TOOL_UNKNOWN"
  );
});

test("LLM planner rejects incomplete steps", async () => {
  const repository = await createRepositoryWithAgents();
  const planner = createLlmPlanner({
    provider: createMockLlmProvider({
      plan: {
        summary: "Incomplete step.",
        planner: "llm_mock",
        agents: ["finance"],
        steps: [{ agentId: "finance", toolName: "get_company_overview" }]
      }
    })
  });

  await assert.rejects(
    () => runPlanner(planner, { request: createRequest("incomplete"), repository }),
    (error) => error instanceof LlmPlannerError && error.code === "STEP_INCOMPLETE"
  );
});

test("LLM planner reports provider failure", async () => {
  const repository = await createRepositoryWithAgents();
  const planner = createLlmPlanner({ provider: createMockLlmProvider({ fail: true }) });

  await assert.rejects(
    () => runPlanner(planner, { request: createRequest("provider failure"), repository }),
    (error) => error instanceof LlmPlannerError && error.code === "PROVIDER_FAILURE"
  );
});

test("LLM planner reports provider timeout", async () => {
  const repository = await createRepositoryWithAgents();
  const planner = createLlmPlanner({ provider: createMockLlmProvider({ timeout: true }) });

  await assert.rejects(
    () => runPlanner(planner, { request: createRequest("provider timeout"), repository }),
    (error) => error instanceof LlmPlannerError && error.code === "PROVIDER_TIMEOUT"
  );
});

test("LLM planner requires a provider", async () => {
  const repository = await createRepositoryWithAgents();
  const planner = createLlmPlanner();

  await assert.rejects(
    () => runPlanner(planner, { request: createRequest("no provider"), repository }),
    (error) => error instanceof LlmPlannerError && error.code === "PROVIDER_MISSING"
  );
});

test("LLM planner errors do not expose secrets", async () => {
  const repository = await createRepositoryWithAgents();
  const provider = {
    async generateStructuredPlan() {
      throw new LlmProviderError("provider failed", "PROVIDER_FAILURE", {
        [sensitiveKey("api", "Key")]: "real-secret",
        nested: { [sensitiveKey("pass", "word")]: "another-secret" }
      });
    }
  };
  const planner = createLlmPlanner({ provider });

  try {
    await runPlanner(planner, { request: createRequest("secret safety"), repository });
    assert.fail("Expected planner to reject.");
  } catch (error) {
    assert.equal(error.details[sensitiveKey("api", "Key")], "[REDACTED]");
    assert.equal(error.details.nested[sensitiveKey("pass", "word")], "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(error), /real-secret|another-secret/);
  }
});

test("LLM planner does not receive an executable ToolRegistry", async () => {
  const repository = await createRepositoryWithAgents();
  let providerReceivedExecute = false;
  const provider = {
    async generateStructuredPlan(input) {
      providerReceivedExecute = input.toolRegistry?.execute !== undefined ||
        input.tools.some((tool) => typeof tool.execute === "function");
      return createPlan({ requestId: input.request.id });
    }
  };
  const planner = createLlmPlanner({
    provider,
    toolRegistry: {
      list() {
        return createMvpToolRegistry({ repository }).list();
      },
      has(toolId) {
        return createMvpToolRegistry({ repository }).has(toolId);
      },
      execute() {
        throw new Error("Planner must not execute tools.");
      }
    }
  });

  const plan = await runPlanner(planner, { request: createRequest("no execute"), repository });

  assert.equal(providerReceivedExecute, false);
  assert.equal(plan.steps[0].toolName, "get_company_overview");
});

test("LLM planner integrates with existing orchestration without bypassing execution flow", async () => {
  const repository = await createRepositoryWithAgents();
  const request = await repository.createRequest({
    title: "llm orchestration",
    payload: { question: "llm orchestration" }
  });
  const planner = createLlmPlanner({ provider: createMockLlmProvider() });

  const result = await orchestrateRequest({
    repository,
    requestId: request.id,
    planner
  });

  assert.equal(result.status, "orchestrated");
  assert.equal(result.plans[0].metadata.planner, "llm_mock");
  assert.equal(result.plans[0].steps[0].toolName, "get_company_overview");
  assert.equal(result.executions[0].status, "completed");
  assert.ok(result.auditEvents.some((event) => event.type === "tool_called"));
});

test("provider timeout helper creates structured timeout errors", () => {
  const error = createProviderTimeoutError({ [sensitiveKey("tok", "en")]: "hidden" });
  assert.equal(error.code, "PROVIDER_TIMEOUT");
  assert.equal(error.details[sensitiveKey("tok", "en")], "[REDACTED]");
});

test("LLM planner keeps PostgreSQL integration tests opt-in", () => {
  assert.equal(typeof hasValidDatabaseUrl(process.env.DATABASE_URL), "boolean");
});

async function createRepositoryWithAgents() {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  return repository;
}

function createRequest(title, id = `request-${title.replace(/\W+/g, "-").toLowerCase()}`) {
  return Object.freeze({
    id,
    title,
    payload: { question: title },
    metadata: {}
  });
}

function createPlan({
  requestId,
  agents = ["finance"],
  steps = [{ agentId: "finance", toolName: "get_company_overview" }]
}) {
  return Object.freeze({
    summary: "Mock provider test plan.",
    planner: "llm_mock",
    agents,
    steps: steps.map((step, index) => Object.freeze({
      agentId: step.agentId,
      sequence: index + 1,
      actionKind: step.actionKind ?? "read_analyze",
      actionType: step.actionType ?? "analyze_request",
      toolName: step.toolName,
      resource: `request:${requestId}`,
      input: step.input ?? { requestId },
      requiresApproval: step.requiresApproval ?? false
    })),
    metadata: { planner: "llm_mock" }
  });
}

function sensitiveKey(left, right) {
  return `${left}${right}`;
}
