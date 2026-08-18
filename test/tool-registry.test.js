import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  ToolRegistry,
  ToolRegistryError,
  createPermission,
  createToolDefinition,
  createToolInputSchema,
  createMvpToolRegistry
} from "../src/index.js";

test("register, get, list, and has manage tool discovery", () => {
  const registry = new ToolRegistry();
  const tool = createEchoTool();

  registry.register(tool);

  assert.equal(registry.has("echo_tool"), true);
  assert.equal(registry.get("echo_tool").name, "Echo Tool");
  assert.deepEqual(registry.list().map((entry) => entry.id), ["echo_tool"]);
  assert.throws(() => registry.register(tool), /already registered/);
});

test("executes an authorized tool and preserves execution context", async () => {
  const repository = new InMemoryRepository();
  const registry = createMvpToolRegistry({ repository });
  const context = createToolContext();

  const result = await registry.execute("get_pending_payments", context, {
    requestId: context.requestId
  });
  const events = await repository.listAuditEvents({ requestId: context.requestId });
  const completed = events.find((event) => event.type === "tool_completed");

  assert.equal(result.status, "completed");
  assert.equal(result.toolId, "get_pending_payments");
  assert.equal(result.output.demo, true);
  assert.equal(result.output.notice, "Demonstration data only. This is not real company data.");
  assert.deepEqual(result.output.context, {
    requestId: context.requestId,
    planId: context.planId,
    stepId: context.stepId,
    executionId: context.executionId,
    agentId: context.agentId
  });
  assert.ok(events.some((event) => event.type === "tool_called"));
  assert.equal(completed.planId, context.planId);
  assert.equal(completed.planStepId, context.stepId);
  assert.equal(completed.executionId, context.executionId);
});

test("rejects an agent that is not allowed to use a tool", async () => {
  const repository = new InMemoryRepository();
  const registry = createMvpToolRegistry({ repository });
  const context = createToolContext({ agentId: "commercial" });

  await assert.rejects(
    () => registry.execute("get_pending_payments", context, { requestId: context.requestId }),
    (error) => error instanceof ToolRegistryError && error.code === "AGENT_NOT_ALLOWED"
  );

  const events = await repository.listAuditEvents({ requestId: context.requestId });
  assert.ok(events.some((event) => event.type === "permission_denied"));
  assert.ok(events.some((event) => event.type === "tool_failed"));
});

test("rejects insufficient permissions", async () => {
  const repository = new InMemoryRepository();
  const registry = createMvpToolRegistry({ repository });
  const context = createToolContext({ agentPermissions: [] });

  await assert.rejects(
    () => registry.execute("get_pending_payments", context, { requestId: context.requestId }),
    (error) => error instanceof ToolRegistryError && error.code === "PERMISSION_DENIED"
  );

  const events = await repository.listAuditEvents({ requestId: context.requestId });
  assert.ok(events.some((event) => event.type === "permission_denied"));
});

test("rejects missing tools", async () => {
  const repository = new InMemoryRepository();
  const registry = createMvpToolRegistry({ repository });
  const context = createToolContext();

  await assert.rejects(
    () => registry.execute("missing_tool", context, { requestId: context.requestId }),
    (error) => error instanceof ToolRegistryError && error.code === "TOOL_NOT_FOUND"
  );

  const events = await repository.listAuditEvents({ requestId: context.requestId });
  assert.ok(events.some((event) => event.type === "tool_called"));
  assert.ok(events.some((event) => event.type === "tool_failed"));
});

test("rejects invalid input", async () => {
  const repository = new InMemoryRepository();
  const registry = createMvpToolRegistry({ repository });
  const context = createToolContext();

  await assert.rejects(
    () => registry.execute("get_pending_payments", context, {}),
    (error) => error instanceof ToolRegistryError && error.code === "INVALID_INPUT"
  );

  const events = await repository.listAuditEvents({ requestId: context.requestId });
  assert.ok(events.some((event) => event.type === "tool_failed"));
});

test("records tool_failed when a tool throws", async () => {
  const repository = new InMemoryRepository();
  const registry = new ToolRegistry({ repository });
  registry.register(createEchoTool({
    id: "failing_tool",
    execute: async () => {
      throw new Error("planned failure");
    }
  }));
  const context = createToolContext();

  await assert.rejects(
    () => registry.execute("failing_tool", context, { requestId: context.requestId }),
    (error) => error instanceof ToolRegistryError && error.code === "TOOL_FAILED"
  );

  const events = await repository.listAuditEvents({ requestId: context.requestId });
  assert.ok(events.some((event) => event.type === "tool_failed"));
});

test("never auto-executes tools that require human approval", async () => {
  const repository = new InMemoryRepository();
  const registry = new ToolRegistry({ repository });
  registry.register(createEchoTool({
    id: "approval_tool",
    requiredPermission: "human_approval_required"
  }));
  const context = createToolContext({
    agentPermissions: [
      createPermission({ kind: "human_approval_required", resource: "request:*" })
    ]
  });

  await assert.rejects(
    () => registry.execute("approval_tool", context, { requestId: context.requestId }),
    (error) => error instanceof ToolRegistryError && error.code === "PERMISSION_DENIED"
  );

  const events = await repository.listAuditEvents({ requestId: context.requestId });
  assert.ok(events.some((event) => event.type === "permission_denied"));
  assert.equal(events.some((event) => event.type === "tool_completed"), false);
});

test("does not trust approvalGranted outside ToolExecutionService", async () => {
  const repository = new InMemoryRepository();
  const registry = new ToolRegistry({ repository });
  registry.register(createEchoTool({
    id: "sensitive_direct_bypass_tool",
    requiredPermission: "execute_action"
  }));
  const context = createToolContext({
    agentPermissions: [
      createPermission({ kind: "execute_action", resource: "request:*" })
    ],
    approvalGranted: true
  });

  await assert.rejects(
    () => registry.execute("sensitive_direct_bypass_tool", context, { requestId: context.requestId }),
    (error) => error instanceof ToolRegistryError && error.code === "PERMISSION_DENIED"
  );

  const events = await repository.listAuditEvents({ requestId: context.requestId });
  assert.equal(events.some((event) => event.type === "tool_completed"), false);
});

function createEchoTool({
  id = "echo_tool",
  requiredPermission = "read_analyze",
  execute = async (context, input) => ({ context, input })
} = {}) {
  return createToolDefinition({
    id,
    name: "Echo Tool",
    description: "Echoes context and input for tests.",
    category: "test",
    requiredPermission,
    allowedAgents: ["finance"],
    inputSchema: createToolInputSchema({
      required: ["requestId"],
      properties: {
        requestId: { type: "string" }
      }
    }),
    execute
  });
}

function createToolContext({
  requestId = "req-tool",
  planId = "plan-tool",
  stepId = "step-tool",
  executionId = "exec-tool",
  agentId = "finance",
  agentPermissions = [
    createPermission({ kind: "read_analyze", resource: "request:*" })
  ],
  approvalGranted = false
} = {}) {
  return {
    requestId,
    planId,
    stepId,
    executionId,
    agentId,
    agentPermissions,
    approvalGranted
  };
}
