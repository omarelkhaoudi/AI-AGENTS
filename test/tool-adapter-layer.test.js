import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  N8N_TOOL_ADAPTER_INTERFACE,
  PrismaRepository,
  ToolAdapterError,
  ToolExecutionService,
  ToolExecutionServiceError,
  ToolRegistry,
  ToolRegistryError,
  approveApprovalRequest,
  createMockToolAdapter,
  createMvpToolRegistry,
  createPermission,
  createPrismaClient,
  createToolAdapter,
  createToolDefinition,
  createToolInputSchema,
  getToolAdapterMetadata,
  hasValidDatabaseUrl,
  seedMvpAgents,
  validateToolAdapter
} from "../src/index.js";

const postgresIntegrationEnabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const postgresUrlAvailable = hasValidDatabaseUrl(process.env.DATABASE_URL);
const postgresSkipReason =
  postgresIntegrationEnabled && postgresUrlAvailable
    ? false
    : "Set RUN_POSTGRES_INTEGRATION=true and DATABASE_URL to run PostgreSQL tool adapter tests.";

test("tool adapter contract accepts a valid adapter and exposes redacted metadata", () => {
  const sensitiveKey = ["api", "Key"].join("");
  const adapter = createToolAdapter({
    toolId: "adapter_contract_tool",
    kind: "mock",
    validateInput: () => true,
    execute: async () => ({ demo: true, items: [] }),
    getMetadata: () => ({
      provider: "local_mock",
      [sensitiveKey]: "sample-value-one"
    })
  });

  assert.equal(validateToolAdapter(adapter), true);
  assert.equal(adapter.toolId, "adapter_contract_tool");
  assert.equal(getToolAdapterMetadata(adapter)[sensitiveKey], "[REDACTED]");
  assert.equal(N8N_TOOL_ADAPTER_INTERFACE.kind, "n8n");
  assert.equal(N8N_TOOL_ADAPTER_INTERFACE.status, "planned_not_implemented");
});

test("ToolRegistry reports TOOL_NOT_FOUND for unknown tools", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createAdapterRegistry()
  });

  await assert.rejects(
    () => service.execute(createAdapterServiceInput({ toolId: "missing_tool" })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "TOOL_NOT_FOUND"
  );
});

test("ToolRegistry reports ADAPTER_NOT_FOUND when a tool requires a missing adapter", async () => {
  const registry = new ToolRegistry();
  registry.register(createToolDefinition({
    id: "missing_adapter_tool",
    name: "Missing Adapter Tool",
    description: "Tool definition requiring an adapter that is not registered.",
    category: "test",
    requiredPermission: "read_analyze",
    allowedAgents: ["finance"],
    inputSchema: createAdapterInputSchema(),
    adapterRequired: true
  }));

  await assert.rejects(
    () => registry.execute("missing_adapter_tool", createRegistryContext(), { requestId: "req-adapter" }),
    (error) => error instanceof ToolRegistryError && error.code === "ADAPTER_NOT_FOUND"
  );
});

test("ToolRegistry returns INVALID_INPUT for adapter-level input validation failures", async () => {
  const registry = new ToolRegistry();
  registry.register(createAdapterBackedTool({
    id: "strict_adapter_tool",
    adapter: createToolAdapter({
      toolId: "strict_adapter_tool",
      kind: "mock",
      validateInput(input) {
        if (input.mode !== "ok") {
          throw new ToolAdapterError("Adapter input mode is invalid.", "INVALID_INPUT");
        }
      },
      execute: async () => ({ demo: true, items: [] })
    })
  }));

  await assert.rejects(
    () => registry.execute("strict_adapter_tool", createRegistryContext(), { requestId: "req-adapter" }),
    (error) => error instanceof ToolRegistryError && error.code === "INVALID_INPUT"
  );
});

test("ToolExecutionService executes a tool through its adapter", async () => {
  const repository = new InMemoryRepository();
  const calls = [];
  const registry = createAdapterRegistry({ calls });
  const service = new ToolExecutionService({ repository, toolRegistry: registry });

  const result = await service.execute(createAdapterServiceInput());
  const events = await repository.listAuditEvents({ requestId: "req-adapter" });

  assert.equal(result.status, "completed");
  assert.equal(result.output.result.demo, true);
  assert.equal(calls.length, 1);
  assert.ok(events.some((event) => event.type === "tool_called"));
  assert.ok(events.some((event) => event.type === "tool_completed"));
});

test("adapter execution errors are reported as TOOL_FAILED", async () => {
  const repository = new InMemoryRepository();
  const registry = new ToolRegistry();
  registry.register(createAdapterBackedTool({
    id: "failing_adapter_tool",
    adapter: createMockToolAdapter({
      toolId: "failing_adapter_tool",
      inputSchema: createAdapterInputSchema(),
      resolve: async () => {
        throw new ToolAdapterError("Adapter failed as planned.", "ADAPTER_FAILED");
      }
    })
  }));
  const service = new ToolExecutionService({ repository, toolRegistry: registry });

  await assert.rejects(
    () => service.execute(createAdapterServiceInput({ toolId: "failing_adapter_tool" })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "TOOL_FAILED"
  );

  const events = await repository.listAuditEvents({ requestId: "req-adapter" });
  assert.ok(events.some((event) => event.type === "tool_failed"));
});

test("permissions are still enforced before adapters can execute", async () => {
  const repository = new InMemoryRepository();
  const calls = [];
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createAdapterRegistry({ calls })
  });

  await assert.rejects(
    () => service.execute(createAdapterServiceInput({ agentPermissions: [] })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "PERMISSION_DENIED"
  );

  const events = await repository.listAuditEvents({ requestId: "req-adapter" });
  assert.equal(calls.length, 0);
  assert.ok(events.some((event) => event.type === "permission_denied"));
  assert.equal(events.some((event) => event.type === "tool_called"), false);
});

test("approval flow is still enforced before sensitive adapters can execute", async () => {
  const repository = new InMemoryRepository();
  const calls = [];
  const registry = new ToolRegistry();
  registry.register(createAdapterBackedTool({
    id: "sensitive_adapter_tool",
    requiredPermission: "execute_action",
    adapter: createCountingAdapter({
      toolId: "sensitive_adapter_tool",
      calls
    })
  }));
  const service = new ToolExecutionService({ repository, toolRegistry: registry });

  let pending = null;
  await assert.rejects(
    () => service.execute(createAdapterServiceInput({
      toolId: "sensitive_adapter_tool",
      agentPermissions: [
        createPermission({ kind: "execute_action", resource: "request:*" })
      ]
    })),
    (error) => {
      pending = error.details.approval;
      return error instanceof ToolExecutionServiceError && error.code === "APPROVAL_REQUIRED";
    }
  );

  assert.equal(calls.length, 0);

  const approved = await approveApprovalRequest({
    repository,
    approvalId: pending.id
  });
  await service.execute(createAdapterServiceInput({
    toolId: "sensitive_adapter_tool",
    agentPermissions: [
      createPermission({ kind: "execute_action", resource: "request:*" })
    ],
    approvalId: approved.id
  }));

  assert.equal(calls.length, 1);
});

test("adapter metadata and audit events do not leak sensitive values", async () => {
  const sensitiveKey = ["pass", "word"].join("");
  const sensitiveValue = "sample-value-two";
  const repository = new InMemoryRepository();
  const registry = new ToolRegistry({ repository });
  registry.register(createAdapterBackedTool({
    id: "metadata_adapter_tool",
    adapter: createMockToolAdapter({
      toolId: "metadata_adapter_tool",
      inputSchema: createAdapterInputSchema(),
      metadata: {
        [sensitiveKey]: sensitiveValue
      },
      resolve: async (context) => ({
        demo: true,
        context,
        items: []
      })
    })
  }));

  await registry.execute("metadata_adapter_tool", createRegistryContext({ repository }), {
    requestId: "req-adapter"
  });

  const events = await repository.listAuditEvents({ requestId: "req-adapter" });
  const metadata = JSON.stringify(events.map((event) => event.metadata));

  assert.equal(metadata.includes(sensitiveValue), false);
  assert.equal(getToolAdapterMetadata(registry.getAdapter("metadata_adapter_tool"))[sensitiveKey], "[REDACTED]");
});

test("all MVP tools still execute through mock adapters with unchanged demo responses", async () => {
  const repository = new InMemoryRepository();
  const registry = createMvpToolRegistry({ repository });
  const cases = [
    ["get_company_overview", "finance"],
    ["get_pending_payments", "finance"],
    ["get_pending_quotes", "commercial"],
    ["get_delayed_production_orders", "production"],
    ["get_purchase_needs", "purchasing"]
  ];

  for (const [toolId, agentId] of cases) {
    const result = await registry.execute(toolId, createRegistryContext({
      repository,
      requestId: `req-${toolId}`,
      agentId
    }), {
      requestId: `req-${toolId}`
    });

    assert.equal(registry.hasAdapter(toolId), true);
    assert.equal(result.status, "completed");
    assert.equal(result.output.demo, true);
    assert.equal(result.output.dataSource, "demo_mock");
    assert.equal(result.output.notice, "Demonstration data only. This is not real company data.");
    assert.equal(Array.isArray(result.output.items), true);
  }
});

test("adapter layer works with InMemoryRepository through ToolExecutionService", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createAdapterRegistry()
  });

  const result = await service.execute(createAdapterServiceInput());
  const execution = await repository.getExecution(result.execution.id);

  assert.equal(execution.status, "completed");
  assert.equal(execution.output.result.dataSource, "adapter_mock");
});

test("adapter layer works with PostgreSQL through ToolExecutionService", {
  skip: postgresSkipReason
}, async () => {
  const prisma = await createPrismaClient();
  const repository = new PrismaRepository({ prisma });
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createAdapterRegistry()
  });
  let requestId = null;

  try {
    await seedMvpAgents(repository);
    const request = await repository.createRequest({
      title: "adapter postgres test",
      payload: { message: "adapter postgres test" }
    });
    requestId = request.id;

    const result = await service.execute(createAdapterServiceInput({
      requestId,
      input: { requestId },
      planId: null,
      planStepId: null
    }));
    const persistedExecution = await prisma.execution.findUnique({
      where: { id: result.execution.id }
    });

    assert.equal(result.status, "completed");
    assert.equal(persistedExecution.status, "completed");
    assert.equal(await prisma.auditEvent.count({ where: { requestId, type: "tool_called" } }), 1);
  } finally {
    if (requestId) {
      await prisma.request.delete({ where: { id: requestId } }).catch(() => undefined);
    }
    await repository.disconnect();
  }
});

function createAdapterRegistry({ calls = [] } = {}) {
  const registry = new ToolRegistry();
  registry.register(createAdapterBackedTool({
    adapter: createCountingAdapter({ calls })
  }));
  return registry;
}

function createAdapterBackedTool({
  id = "adapter_tool",
  requiredPermission = "read_analyze",
  adapter
} = {}) {
  return createToolDefinition({
    id,
    name: "Adapter Tool",
    description: "Tool backed by a test adapter.",
    category: "test",
    requiredPermission,
    allowedAgents: ["finance"],
    inputSchema: createAdapterInputSchema(),
    adapter
  });
}

function createCountingAdapter({
  toolId = "adapter_tool",
  calls = []
} = {}) {
  return createMockToolAdapter({
    toolId,
    inputSchema: createAdapterInputSchema(),
    metadata: {
      dataSource: "adapter_mock"
    },
    resolve: async (context, input) => {
      calls.push({ context, input });
      return {
        demo: true,
        dataSource: "adapter_mock",
        context,
        items: [{ id: "adapter-demo-item" }]
      };
    }
  });
}

function createAdapterInputSchema() {
  return createToolInputSchema({
    required: ["requestId"],
    properties: {
      requestId: { type: "string" }
    }
  });
}

function createRegistryContext({
  repository = null,
  requestId = "req-adapter",
  agentId = "finance"
} = {}) {
  return {
    repository,
    requestId,
    planId: "plan-adapter",
    stepId: "step-adapter",
    executionId: "exec-adapter",
    agentId,
    agentPermissions: [
      createPermission({ kind: "read_analyze", resource: "request:*" })
    ]
  };
}

function createAdapterServiceInput({
  toolId = "adapter_tool",
  agentPermissions = [
    createPermission({ kind: "read_analyze", resource: "request:*" })
  ],
  requestId = "req-adapter",
  input = { requestId: "req-adapter" },
  planId = "plan-adapter",
  planStepId = "step-adapter",
  approvalId = null
} = {}) {
  return {
    agentId: "finance",
    agentPermissions,
    toolId,
    input,
    requestId,
    planId,
    planStepId,
    approvalId
  };
}
