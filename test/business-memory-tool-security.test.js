import assert from "node:assert/strict";
import test from "node:test";
import {
  createMvpAgentPermissions,
  BUSINESS_DATA_SOURCES,
  InMemoryRepository,
  ToolAdapterError,
  ToolExecutionService,
  ToolExecutionServiceError,
  ToolRegistry,
  createDemoBusinessMemoryRepository,
  createMockToolAdapter,
  createPermission,
  createToolDefinition,
  createToolInputSchema,
  readBusinessRecordsForTool
} from "../src/index.js";

test("tools read authorized business memory records through the explicit read contract", async () => {
  const records = await readBusinessRecordsForTool({
    businessMemory: createDemoBusinessMemoryRepository(),
    domain: "payments",
    agentId: "finance",
    source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
    filters: {
      data: { invoiceId: "invoice-atlas-deposit" }
    }
  });

  assert.deepEqual(records.map((record) => record.id), ["payment-atlas-deposit"]);
});

test("generic filters cannot bypass business memory domain access", async () => {
  await assert.rejects(
    () => readBusinessRecordsForTool({
      businessMemory: createDemoBusinessMemoryRepository(),
      domain: "payments",
      agentId: "marketing",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      filters: {
        ids: ["payment-atlas-deposit"],
        data: { invoiceId: "invoice-atlas-deposit" },
        metadata: { draft: true }
      }
    }),
    (error) => {
      assert.equal(error instanceof ToolAdapterError, true);
      assert.equal(error.code, "BUSINESS_MEMORY_ACCESS_DENIED");
      assert.equal(JSON.stringify(error.details).includes("payment-atlas-deposit"), false);
      assert.equal(JSON.stringify(error.details).includes("invoice-atlas-deposit"), false);
      return true;
    }
  );
});

test("business memory read contract rejects invalid memory objects without data leakage", async () => {
  await assert.rejects(
    () => readBusinessRecordsForTool({
      businessMemory: {},
      domain: "payments",
      agentId: "finance",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK
    }),
    (error) =>
      error instanceof ToolAdapterError &&
      error.code === "BUSINESS_MEMORY_CONTRACT_INVALID" &&
      JSON.stringify(error.details) === "{\"missing\":[\"listBusinessRecords\"]}"
  );
});

test("ToolExecutionService reports sanitized business memory denials without leaking records", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMisconfiguredPaymentReadRegistry()
  });

  await assert.rejects(
    () => service.execute({
      agentId: "marketing",
      agentPermissions: createMvpAgentPermissions("marketing"),
      toolId: "misconfigured_payment_reader",
      input: { requestId: "req-bm-tool-security" },
      requestId: "req-bm-tool-security",
      planId: "plan-bm-tool-security",
      planStepId: "step-bm-tool-security"
    }),
    (error) => {
      assert.equal(error instanceof ToolExecutionServiceError, true);
      assert.equal(error.code, "TOOL_FAILED");
      assert.equal(error.details.adapterCode, "BUSINESS_MEMORY_ACCESS_DENIED");
      const serialized = JSON.stringify(error);
      assert.equal(serialized.includes("payment-atlas-deposit"), false);
      assert.equal(serialized.includes("invoice-atlas-deposit"), false);
      return true;
    }
  );

  const executions = await repository.listExecutions();
  const events = await repository.listAuditEvents({ requestId: "req-bm-tool-security" });
  const serializedSavedState = JSON.stringify({ executions, events });

  assert.equal(executions.length, 1);
  assert.equal(executions[0].status, "failed");
  assert.equal(executions[0].output, null);
  assert.equal(events.some((event) => event.type === "tool_called"), true);
  assert.equal(events.some((event) => event.type === "tool_failed"), true);
  assert.equal(serializedSavedState.includes("payment-atlas-deposit"), false);
  assert.equal(serializedSavedState.includes("invoice-atlas-deposit"), false);
});

function createMisconfiguredPaymentReadRegistry() {
  const businessMemory = createDemoBusinessMemoryRepository();
  const registry = new ToolRegistry();
  const inputSchema = createToolInputSchema({
    required: ["requestId"],
    properties: {
      requestId: { type: "string" }
    }
  });

  registry.register(createToolDefinition({
    id: "misconfigured_payment_reader",
    name: "Misconfigured Payment Reader",
    description: "Test-only tool intentionally misconfigured to prove BusinessMemory still enforces domains.",
    category: "security_test",
    requiredPermission: "read_analyze",
    allowedAgents: ["marketing"],
    inputSchema,
    adapter: createMockToolAdapter({
      toolId: "misconfigured_payment_reader",
      inputSchema,
      resolve: async (context) => {
        const records = await readBusinessRecordsForTool({
          businessMemory,
          domain: "payments",
          agentId: context.agentId,
          source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
          filters: {
            ids: ["payment-atlas-deposit"],
            data: { invoiceId: "invoice-atlas-deposit" }
          }
        });
        return {
          demo: true,
          dataSource: BUSINESS_DATA_SOURCES.DEMO_MOCK,
          items: records.map((record) => record.data)
        };
      }
    })
  }));

  return registry;
}
