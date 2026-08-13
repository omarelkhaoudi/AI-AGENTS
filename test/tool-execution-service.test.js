import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  ToolExecutionService,
  ToolExecutionServiceError,
  ToolRegistry,
  createMvpToolRegistry,
  createPermission,
  createToolDefinition,
  createToolInputSchema
} from "../src/index.js";

test("ToolExecutionService executes a valid tool for an authorized agent", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository })
  });

  const result = await service.execute(createServiceInput());
  const execution = await repository.getExecution(result.execution.id);

  assert.equal(result.status, "completed");
  assert.equal(result.toolId, "get_pending_payments");
  assert.equal(result.output.toolId, "get_pending_payments");
  assert.equal(result.output.result.demo, true);
  assert.equal(execution.status, "completed");
  assert.equal(result.output.result.context.requestId, "req-service");
  assert.equal(result.output.result.context.planId, "plan-service");
  assert.equal(result.output.result.context.stepId, "step-service");
  assert.equal(result.output.result.context.executionId, result.execution.id);
});

test("ToolExecutionService rejects missing tools with TOOL_NOT_FOUND", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository })
  });

  await assert.rejects(
    () => service.execute(createServiceInput({ toolId: "missing_tool" })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "TOOL_NOT_FOUND"
  );

  const events = await repository.listAuditEvents({ requestId: "req-service" });
  assert.equal(events.some((event) => event.type === "tool_called"), false);
});

test("ToolExecutionService rejects unauthorized agents with AGENT_NOT_ALLOWED", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository })
  });

  await assert.rejects(
    () => service.execute(createServiceInput({ agentId: "commercial" })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED"
  );

  const events = await repository.listAuditEvents({ requestId: "req-service" });
  const approvals = await repository.listPendingApprovals({ requestId: "req-service" });

  assert.equal(approvals.length, 0);
  assert.ok(events.some((event) => event.type === "permission_denied"));
  assert.equal(events.some((event) => event.type === "tool_called"), false);
});

test("ToolExecutionService rejects insufficient permissions with PERMISSION_DENIED", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository })
  });

  await assert.rejects(
    () => service.execute(createServiceInput({ agentPermissions: [] })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "PERMISSION_DENIED"
  );

  const events = await repository.listAuditEvents({ requestId: "req-service" });
  const approvals = await repository.listPendingApprovals({ requestId: "req-service" });

  assert.equal(approvals.length, 0);
  assert.ok(events.some((event) => event.type === "permission_denied"));
  assert.equal(events.some((event) => event.type === "tool_called"), false);
});

test("ToolExecutionService rejects human approval tools with APPROVAL_REQUIRED", async () => {
  const repository = new InMemoryRepository();
  const registry = new ToolRegistry({ repository });
  registry.register(createEchoTool({
    id: "approval_tool",
    requiredPermission: "human_approval_required"
  }));
  const service = new ToolExecutionService({ repository, toolRegistry: registry });

  await assert.rejects(
    () => service.execute(createServiceInput({
      toolId: "approval_tool",
      agentPermissions: [
        createPermission({ kind: "human_approval_required", resource: "request:*" })
      ]
    })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "APPROVAL_REQUIRED"
  );

  const events = await repository.listAuditEvents({ requestId: "req-service" });
  const approvals = await repository.listPendingApprovals({ requestId: "req-service" });

  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.ok(events.some((event) => event.type === "approval_requested"));
  assert.equal(events.some((event) => event.type === "permission_denied"), false);
  assert.equal(events.some((event) => event.type === "tool_called"), false);
});

test("ToolExecutionService rejects invalid input with INVALID_INPUT", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository })
  });

  await assert.rejects(
    () => service.execute(createServiceInput({ input: {} })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "INVALID_INPUT"
  );

  const events = await repository.listAuditEvents({ requestId: "req-service" });
  assert.equal(events.some((event) => event.type === "tool_called"), false);
});

test("ToolExecutionService records TOOL_FAILED when the tool throws", async () => {
  const repository = new InMemoryRepository();
  const registry = new ToolRegistry({ repository });
  registry.register(createEchoTool({
    id: "failing_tool",
    execute: async () => {
      throw new Error("planned failure");
    }
  }));
  const service = new ToolExecutionService({ repository, toolRegistry: registry });

  await assert.rejects(
    () => service.execute(createServiceInput({ toolId: "failing_tool" })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "TOOL_FAILED"
  );

  const events = await repository.listAuditEvents({ requestId: "req-service" });
  const executions = await repository.listExecutions();

  assert.ok(events.some((event) => event.type === "tool_called"));
  assert.ok(events.some((event) => event.type === "tool_failed"));
  assert.equal(events.some((event) => event.type === "tool_completed"), false);
  assert.equal(executions[0].status, "failed");
});

test("ToolExecutionService emits tool_called only when real execution starts", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository })
  });

  await assert.rejects(() => service.execute(createServiceInput({ input: {} })));
  await service.execute(createServiceInput({
    requestId: "req-service-real",
    input: { requestId: "req-service-real" }
  }));

  const rejectedEvents = await repository.listAuditEvents({ requestId: "req-service" });
  const acceptedEvents = await repository.listAuditEvents({ requestId: "req-service-real" });

  assert.equal(rejectedEvents.some((event) => event.type === "tool_called"), false);
  assert.equal(acceptedEvents.filter((event) => event.type === "tool_called").length, 1);
});

test("ToolExecutionService emits tool_completed on success", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository })
  });

  await service.execute(createServiceInput());
  const events = await repository.listAuditEvents({ requestId: "req-service" });

  assert.ok(events.some((event) => event.type === "tool_completed"));
});

test("ToolExecutionService audit metadata never stores sensitive input values", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository })
  });
  const sensitiveFieldNames = ["apiKey", "password", "token", "secret"];
  const sensitiveValues = ["sample-value-one", "sample-value-two", "sample-value-three", "sample-value-four"];

  await service.execute(createServiceInput({
    input: {
      requestId: "req-service",
      [sensitiveFieldNames[0]]: sensitiveValues[0],
      [sensitiveFieldNames[1]]: sensitiveValues[1],
      [sensitiveFieldNames[2]]: sensitiveValues[2],
      credentials: {
        [sensitiveFieldNames[3]]: sensitiveValues[3]
      }
    }
  }));

  const events = await repository.listAuditEvents({ requestId: "req-service" });
  const metadata = JSON.stringify(events.map((event) => event.metadata));

  for (const value of sensitiveValues) {
    assert.equal(metadata.includes(value), false);
  }
});

test("ToolExecutionService works with InMemoryRepository when creating an execution", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository })
  });

  const result = await service.execute(createServiceInput());
  const executions = await repository.listExecutions();

  assert.equal(executions.length, 1);
  assert.equal(executions[0].id, result.execution.id);
  assert.equal(executions[0].status, "completed");
  assert.equal(executions[0].planStepId, "step-service");
});

test("ToolExecutionService reuses an existing executionId when provided", async () => {
  const repository = new InMemoryRepository();
  const existingExecution = await repository.saveExecution({
    id: "exec-existing",
    requestId: "req-service",
    planId: "plan-service",
    planStepId: "step-service",
    agentId: "finance",
    status: "executing",
    input: { requestId: "req-service" },
    startedAt: new Date().toISOString()
  });
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository })
  });

  const result = await service.execute(createServiceInput({
    executionId: existingExecution.id
  }));
  const executions = await repository.listExecutions();

  assert.equal(result.execution.id, "exec-existing");
  assert.equal(result.execution.status, "completed");
  assert.equal(result.output.result.context.executionId, "exec-existing");
  assert.equal(executions.length, 1);
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

function createServiceInput({
  agentId = "finance",
  agentPermissions = [
    createPermission({ kind: "read_analyze", resource: "request:*" })
  ],
  toolId = "get_pending_payments",
  input = { requestId: "req-service" },
  requestId = "req-service",
  planId = "plan-service",
  planStepId = "step-service",
  executionId = null
} = {}) {
  return {
    agentId,
    agentPermissions,
    toolId,
    input,
    requestId,
    planId,
    planStepId,
    executionId
  };
}
