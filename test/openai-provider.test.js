import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  LlmProviderError,
  PlannerConfigurationError,
  createOpenAIProvider,
  createPlannerConfig,
  createPlannerFromConfig,
  createProviderTimeoutError,
  generateStructuredPlanWithProvider,
  orchestrateRequest,
  seedMvpAgents
} from "../src/index.js";

test("OpenAI provider implements the LLMProvider contract", async () => {
  const provider = createOpenAIProvider({
    client: createFakeOpenAIClient({ response: { structuredPlan: createPlan("req-contract") } }),
    apiKey: "test",
    model: "test-model"
  });

  const plan = await generateStructuredPlanWithProvider(provider, createProviderInput("req-contract"));

  assert.equal(provider.id, "openai_provider");
  assert.equal(plan.planner, "openai");
});

test("OpenAI provider sends the configured model and planner prompt", async () => {
  const calls = [];
  const client = createFakeOpenAIClient({
    calls,
    response: { structuredPlan: createPlan("req-model") }
  });
  const provider = createOpenAIProvider({
    client,
    apiKey: "test",
    model: "configured-model"
  });

  await provider.generateStructuredPlan(createProviderInput("req-model"));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "configured-model");
  assert.equal(calls[0].input[0].content, "system prompt");
  assert.equal(calls[0].input[1].content, "user prompt");
  assert.deepEqual(calls[0].response_format, { type: "json_object" });
});

test("OpenAI provider extracts structured output from object responses", async () => {
  const provider = createOpenAIProvider({
    client: createFakeOpenAIClient({ response: { output_parsed: createPlan("req-object") } }),
    apiKey: "test"
  });

  const plan = await provider.generateStructuredPlan(createProviderInput("req-object"));

  assert.equal(plan.steps[0].input.requestId, "req-object");
});

test("OpenAI provider parses structured output from text responses", async () => {
  const provider = createOpenAIProvider({
    client: createFakeOpenAIClient({ response: { output_text: JSON.stringify(createPlan("req-text")) } }),
    apiKey: "test"
  });

  const plan = await provider.generateStructuredPlan(createProviderInput("req-text"));

  assert.equal(plan.steps[0].input.requestId, "req-text");
});

test("OpenAI provider rejects invalid structured responses", async () => {
  const provider = createOpenAIProvider({
    client: createFakeOpenAIClient({ response: { output_text: "not-json" } }),
    apiKey: "test"
  });

  await assert.rejects(
    () => provider.generateStructuredPlan(createProviderInput("req-invalid")),
    (error) => error instanceof LlmProviderError && error.code === "JSON_INVALID"
  );
});

test("OpenAI provider rejects empty responses", async () => {
  const provider = createOpenAIProvider({
    client: createFakeOpenAIClient({ response: {} }),
    apiKey: "test"
  });

  await assert.rejects(
    () => provider.generateStructuredPlan(createProviderInput("req-empty")),
    (error) => error instanceof LlmProviderError && error.code === "INVALID_RESPONSE"
  );
});

test("OpenAI provider transforms client failures safely", async () => {
  const provider = createOpenAIProvider({
    client: createFakeOpenAIClient({
      error: Object.assign(new Error("Authorization bearer should-not-leak"), { code: "AUTH_FAILED" })
    }),
    apiKey: "test"
  });

  await assert.rejects(
    () => provider.generateStructuredPlan(createProviderInput("req-failure")),
    (error) => {
      assert.equal(error.code, "PROVIDER_FAILURE");
      assert.doesNotMatch(JSON.stringify(error), /should-not-leak|Authorization bearer/i);
      return true;
    }
  );
});

test("OpenAI provider rejects missing clients", async () => {
  const provider = createOpenAIProvider({ apiKey: "test" });

  await assert.rejects(
    () => provider.generateStructuredPlan(createProviderInput("req-client")),
    (error) => error instanceof LlmProviderError && error.code === "CLIENT_MISSING"
  );
});

test("OpenAI provider rejects missing API keys only when used", async () => {
  const provider = createOpenAIProvider({
    client: createFakeOpenAIClient({ response: { structuredPlan: createPlan("req-key") } }),
    apiKey: ""
  });

  await assert.rejects(
    () => provider.generateStructuredPlan(createProviderInput("req-key")),
    (error) => error instanceof LlmProviderError && error.code === "API_KEY_MISSING"
  );
});

test("OpenAI provider reports timeout errors", async () => {
  const provider = createOpenAIProvider({
    client: createFakeOpenAIClient({
      error: createProviderTimeoutError({ provider: "fake" })
    }),
    apiKey: "test"
  });

  await assert.rejects(
    () => provider.generateStructuredPlan(createProviderInput("req-timeout")),
    (error) => error instanceof LlmProviderError && error.code === "PROVIDER_TIMEOUT"
  );
});

test("OpenAI provider never performs network calls without an injected client implementation", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("Network calls are forbidden.");
  };

  try {
    const provider = createOpenAIProvider({ apiKey: "test" });
    await assert.rejects(
      () => provider.generateStructuredPlan(createProviderInput("req-network")),
      /injected client/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalled, false);
});

test("OpenAI provider errors do not expose secrets", async () => {
  const provider = createOpenAIProvider({
    client: createFakeOpenAIClient({
      error: new Error("client saw super-hidden-value")
    }),
    apiKey: "test"
  });

  await assert.rejects(
    () => provider.generateStructuredPlan(createProviderInput("req-secret")),
    (error) => {
      assert.doesNotMatch(JSON.stringify(error), /super-hidden-value/);
      return true;
    }
  );
});

test("PLANNER_PROVIDER=llm_openai requires an API key", () => {
  assert.throws(
    () => createPlannerConfig({ PLANNER_PROVIDER: "llm_openai" }),
    (error) => error instanceof PlannerConfigurationError && error.code === "CONFIGURATION_ERROR"
  );
});

test("PLANNER_PROVIDER=llm_openai selects LlmPlanner with OpenAIProvider and fake client", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const request = await repository.createRequest({
    title: "openai configured planner",
    payload: { question: "openai configured planner" }
  });
  const planner = createPlannerFromConfig({
    provider: "llm_openai",
    openai: {
      apiKey: "test",
      model: "test-model"
    }
  }, {
    openaiClient: createFakeOpenAIClient({
      response: { structuredPlan: createPlan(request.id) }
    })
  });

  const result = await orchestrateRequest({
    repository,
    requestId: request.id,
    planner
  });

  assert.equal(result.status, "orchestrated");
  assert.equal(result.plans[0].metadata.planner, "openai");
  assert.equal(result.executions[0].status, "completed");
});

function createFakeOpenAIClient({ response = null, error = null, calls = [] } = {}) {
  return Object.freeze({
    responses: Object.freeze({
      async create(payload) {
        calls.push(payload);
        if (error) {
          throw error;
        }
        return response;
      }
    })
  });
}

function createProviderInput(requestId) {
  return Object.freeze({
    request: { id: requestId },
    prompt: {
      system: "system prompt",
      user: "user prompt"
    },
    output: "planner_contract_json"
  });
}

function createPlan(requestId) {
  return Object.freeze({
    summary: "OpenAI fake structured plan.",
    planner: "openai",
    agents: ["finance"],
    steps: [
      Object.freeze({
        agentId: "finance",
        sequence: 1,
        actionKind: "read_analyze",
        actionType: "analyze_request",
        toolName: "get_company_overview",
        resource: `request:${requestId}`,
        input: { requestId },
        requiresApproval: false
      })
    ],
    metadata: { planner: "openai" }
  });
}
