import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  LlmProviderError,
  PlannerConfigurationError,
  PlanningError,
  buildApi,
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
  assert.equal(calls[0].instructions, "system prompt");
  assert.equal(calls[0].input[0].content[0].text, "user prompt");
  assert.equal(calls[0].text.format.type, "json_schema");
  assert.equal(calls[0].text.format.name, "ai_agents_planner_plan");
  assert.equal(calls[0].text.format.schema.required.includes("steps"), true);
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

test("OpenAI provider creates the SDK client lazily when no client is injected", async () => {
  const calls = [];
  const provider = createOpenAIProvider({
    apiKey: "x",
    clientFactory: async ({ apiKey }) => {
      calls.push({ apiKey });
      return createFakeOpenAIClient({ response: { structuredPlan: createPlan("req-client-factory") } });
    }
  });

  const plan = await provider.generateStructuredPlan(createProviderInput("req-client-factory"));

  assert.deepEqual(calls, [{ apiKey: "x" }]);
  assert.equal(plan.requestId, "req-client-factory");
});

test("OpenAI provider rejects invalid clients created by the client factory", async () => {
  const provider = createOpenAIProvider({
    apiKey: "test",
    clientFactory: async () => ({})
  });

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
    const provider = createOpenAIProvider({
      apiKey: "test",
      clientFactory: async () => createFakeOpenAIClient({ response: { structuredPlan: createPlan("req-network") } })
    });
    await provider.generateStructuredPlan(createProviderInput("req-network"));
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

test("OpenAI planner end-to-end stays inside Director and ToolExecutionService with a fake client", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const app = buildApi({
    repository,
    config: {
      planner: {
        provider: "llm_openai",
        openai: {
          apiKey: "test",
          model: "test-model"
        }
      }
    },
    planner: createPlannerFromConfig({
      provider: "llm_openai",
      openai: {
        apiKey: "test",
        model: "test-model"
      }
    }, {
      openaiClient: createFakeOpenAIClient({
        response: (payload) => ({
          structuredPlan: createPlan(extractRequestIdFromPrompt(payload) ?? "req-openai-e2e")
        })
      })
    })
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/requests",
      payload: {
        title: "OpenAI offline e2e",
        payload: { question: "Fais-moi le point" },
        metadata: { testRequestId: "req-openai-e2e" }
      }
    });
    const body = JSON.parse(response.body);
    const events = await repository.listAuditEvents({ requestId: body.request.id });

    assert.equal(response.statusCode, 201);
    assert.equal(body.request.status, "orchestrated");
    assert.equal(body.request.plans[0].metadata.planner, "openai");
    assert.equal(body.request.executions[0].status, "completed");
    assert.equal(body.request.executions[0].output.result.demo, true);
    assert.ok(events.some((event) => event.type === "permission_checked"));
    assert.ok(events.some((event) => event.type === "tool_called"));
  } finally {
    await app.close();
  }
});

test("OpenAI planner can produce the central CDC Director plan with the five priority agents", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const request = await repository.createRequest({
    title: "Fais-moi le point complet de l'entreprise aujourd'hui.",
    payload: { question: "Fais-moi le point complet de l'entreprise aujourd'hui." }
  });
  const planner = createPlannerFromConfig({
    provider: "llm_openai",
    openai: {
      apiKey: "test",
      model: "test-model"
    }
  }, {
    openaiClient: createFakeOpenAIClient({
      response: { structuredPlan: createCentralCompanyPlan(request.id) }
    })
  });

  const result = await orchestrateRequest({
    repository,
    requestId: request.id,
    planner
  });
  const events = await repository.listAuditEvents({ requestId: request.id });

  assert.equal(result.status, "orchestrated");
  assert.deepEqual(result.plans[0].steps.map((step) => step.agentId), [
    "finance",
    "commercial",
    "production",
    "purchasing",
    "after_sales"
  ]);
  assert.deepEqual(result.executions.map((execution) => execution.status), [
    "completed",
    "completed",
    "completed",
    "completed",
    "completed"
  ]);
  assert.equal(result.executions.every((execution) => execution.output.result.demo === true), true);
  assert.equal(events.filter((event) => event.type === "tool_called").length, 5);
});

test("OpenAI planner sensitive execution request still creates approval and does not execute automatically", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const request = await repository.createRequest({
    title: "Effectue le paiement de cette facture.",
    payload: { question: "Effectue le paiement de cette facture." }
  });
  const planner = createPlannerFromConfig({
    provider: "llm_openai",
    openai: {
      apiKey: "test",
      model: "test-model"
    }
  }, {
    openaiClient: createFakeOpenAIClient({
      response: { structuredPlan: createSensitivePaymentPlan(request.id) }
    })
  });

  const result = await orchestrateRequest({
    repository,
    requestId: request.id,
    planner
  });
  const approvals = await repository.listApprovals();
  const events = await repository.listAuditEvents({ requestId: request.id });

  assert.equal(result.status, "blocked");
  assert.equal(result.plans[0].steps[0].requiresApproval, true);
  assert.equal(result.executions.length, 0);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.equal(approvals[0].requestedAction, "execute_invoice_payment");
  assert.equal(events.some((event) => event.type === "approval_requested"), true);
  assert.equal(events.some((event) => event.type === "tool_completed"), false);
});

test("invalid OpenAI plan stops before tool execution and does not persist business execution", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const request = await repository.createRequest({
    title: "invalid openai plan",
    payload: { question: "invalid openai plan" }
  });
  const planner = createPlannerFromConfig({
    provider: "llm_openai",
    openai: {
      apiKey: "test",
      model: "test-model"
    }
  }, {
    openaiClient: createFakeOpenAIClient({
      response: {
        structuredPlan: {
          version: "1",
          requestId: "req-invalid-openai-plan",
          intent: "invalid",
          summary: "Invalid plan.",
          planner: "openai",
          agents: ["finance"],
          steps: [],
          metadata: { planner: "openai" }
        }
      }
    })
  });

  await assert.rejects(
    () => orchestrateRequest({ repository, requestId: request.id, planner }),
    (error) => error instanceof PlanningError && error.code === "PLANNING_FAILED"
  );

  const saved = await repository.getRequest(request.id);
  const events = await repository.listAuditEvents({ requestId: request.id });

  assert.equal(saved.plans.length, 0);
  assert.equal(saved.executions.length, 0);
  assert.equal(events.some((event) => event.type === "tool_called"), false);
});

function createFakeOpenAIClient({ response = null, error = null, calls = [] } = {}) {
  return Object.freeze({
    responses: Object.freeze({
      async create(payload) {
        calls.push(payload);
        if (error) {
          throw error;
        }
        return typeof response === "function" ? response(payload) : response;
      }
    })
  });
}

function extractRequestIdFromPrompt(payload) {
  const text = payload?.input?.[0]?.content?.[0]?.text;
  const match = typeof text === "string" ? text.match(/"requestId":\s*"([^"]+)"/) : null;
  return match?.[1] ?? null;
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
    version: "1",
    requestId,
    intent: "openai_fake_planning",
    summary: "OpenAI fake structured plan.",
    planner: "openai",
    agents: ["finance"],
    steps: [
      Object.freeze({
        id: `${requestId}:openai:1:finance`,
        agentId: "finance",
        sequence: 1,
        actionKind: "read_analyze",
        actionType: "analyze_request",
        toolName: "get_company_overview",
        resource: `request:${requestId}`,
        input: { requestId },
        requiresApproval: false,
        reason: "OpenAI fake planner reason."
      })
    ],
    metadata: { planner: "openai" }
  });
}

function createCentralCompanyPlan(requestId) {
  const steps = [
    ["finance", "get_pending_payments"],
    ["commercial", "get_pending_quotes"],
    ["production", "get_delayed_production_orders"],
    ["purchasing", "get_purchase_needs"],
    ["after_sales", "get_after_sales_overview"]
  ].map(([agentId, toolName], index) => ({
    id: `${requestId}:openai-central:${index + 1}:${agentId}`,
    agentId,
    sequence: index + 1,
    actionKind: "read_analyze",
    actionType: "analyze_request",
    toolName,
    resource: `request:${requestId}`,
    input: { requestId },
    requiresApproval: false,
    reason: "OpenAI fake central CDC planning step."
  }));

  return Object.freeze({
    version: "1",
    requestId,
    intent: "global_company_overview",
    summary: "OpenAI fake central CDC structured plan.",
    planner: "openai",
    agents: steps.map((step) => step.agentId),
    steps,
    metadata: { planner: "openai", scenario: "central_cdc" }
  });
}

function createSensitivePaymentPlan(requestId) {
  return Object.freeze({
    version: "1",
    requestId,
    intent: "sensitive_invoice_payment",
    summary: "OpenAI fake sensitive payment plan.",
    planner: "openai",
    agents: ["finance"],
    steps: [
      Object.freeze({
        id: `${requestId}:openai-sensitive:1:finance`,
        agentId: "finance",
        sequence: 1,
        actionKind: "execute_action",
        actionType: "execute_invoice_payment",
        toolName: "execute_invoice_payment",
        resource: `request:${requestId}`,
        input: { requestId },
        requiresApproval: false,
        reason: "OpenAI fake planner requested sensitive payment execution."
      })
    ],
    metadata: { planner: "openai", scenario: "sensitive_payment" }
  });
}
