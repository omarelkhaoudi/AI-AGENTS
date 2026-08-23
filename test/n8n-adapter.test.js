import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  ToolAdapterError,
  ToolExecutionService,
  ToolRegistry,
  WorkflowBoundaryError,
  createMvpAgentPermissions,
  createMvpToolRegistry,
  createN8nToolAdapter,
  createToolDefinition,
  createToolInputSchema,
  seedMvpAgents
} from "../src/index.js";

// No network anywhere in this file: the n8n client is a stub, and every test
// counts its calls. A refusal that still called out would be a bypass, so the
// counter is the assertion that matters most here.
const EVENT_TYPE = "delay_alert";
const TOOL_ID = "test_notify_delay_alert";

const INPUT_SCHEMA = createToolInputSchema({
  required: ["requestId", "orderId"],
  properties: {
    requestId: { type: "string" },
    orderId: { type: "string" },
    delayRisk: { type: "string" }
  }
});

function stubClient({ response, error } = {}) {
  const calls = [];
  return {
    calls,
    postWorkflowEvent: async (event) => {
      calls.push(event);
      if (error) {
        throw error;
      }
      return response ?? { httpStatus: 200, body: { status: "received" }, durationMs: 12 };
    }
  };
}

function buildTool({ client, requiredPermission = "read_analyze", allowedAgents = ["production"], securityDomains = ["production"] }) {
  return createToolDefinition({
    id: TOOL_ID,
    name: "Test delay alert",
    description: "Test-only tool used to prove the adapter stays behind the guard rails.",
    category: "production",
    securityDomains,
    requiredPermission,
    allowedAgents,
    inputSchema: INPUT_SCHEMA,
    adapterRequired: true,
    adapter: createN8nToolAdapter({ toolId: TOOL_ID, eventType: EVENT_TYPE, inputSchema: INPUT_SCHEMA, client })
  });
}

function buildRegistry(tool, repository) {
  const registry = new ToolRegistry({ repository });
  registry.register(tool);
  return registry;
}

const CONTEXT = Object.freeze({
  agentId: "production",
  requestId: "req-1",
  planId: "plan-1",
  stepId: "step-1",
  executionId: "exec-1",
  agentPermissions: createMvpAgentPermissions("production")
});

const INPUT = Object.freeze({ requestId: "req-1", orderId: "order-atlas-001", delayRisk: "high" });

test("the adapter is registered as an n8n adapter, not a mock", () => {
  const adapter = createN8nToolAdapter({
    toolId: TOOL_ID,
    eventType: EVENT_TYPE,
    inputSchema: INPUT_SCHEMA,
    client: stubClient()
  });

  assert.equal(adapter.kind, "n8n");
  assert.equal(adapter.toolId, TOOL_ID);
  assert.equal(adapter.getMetadata().provider, "n8n");
  assert.equal(adapter.getMetadata().eventType, EVENT_TYPE);
});

test("an unknown event type is refused at construction", () => {
  assert.throws(
    () => createN8nToolAdapter({ toolId: TOOL_ID, eventType: "not_a_workflow", inputSchema: INPUT_SCHEMA, client: stubClient() }),
    (error) => error instanceof ToolAdapterError && error.code === "N8N_EVENT_TYPE_UNKNOWN"
  );
});

test("a missing client is refused at construction, not at call time", () => {
  for (const client of [undefined, null, {}, { postWorkflowEvent: "nope" }]) {
    assert.throws(
      () => createN8nToolAdapter({ toolId: TOOL_ID, eventType: EVENT_TYPE, inputSchema: INPUT_SCHEMA, client }),
      (error) => error instanceof ToolAdapterError && error.code === "N8N_CLIENT_REQUIRED"
    );
  }
});

test("the event sent to n8n follows the workflow contract", async () => {
  const client = stubClient();
  const registry = buildRegistry(buildTool({ client }), new InMemoryRepository());

  await registry.execute(TOOL_ID, { ...CONTEXT, audit: false }, INPUT);

  assert.equal(client.calls.length, 1);
  const event = client.calls[0];
  assert.equal(event.type, EVENT_TYPE);
  assert.equal(event.correlationId, "exec-1");
  assert.equal(event.id, "exec-1:delay_alert");
  assert.equal(event.agentId, "production");
  assert.equal(event.requestId, "req-1");
  assert.deepEqual(event.payload, INPUT);
  assert.equal(event.metadata.toolId, TOOL_ID);
});

test("the result carries what an execution needs to be traced", async () => {
  const client = stubClient({ response: { httpStatus: 200, body: { status: "received" }, durationMs: 42 } });
  const registry = buildRegistry(buildTool({ client }), new InMemoryRepository());

  const { status, output } = await registry.execute(TOOL_ID, { ...CONTEXT, audit: false }, INPUT);

  assert.equal(status, "completed");
  assert.equal(output.provider, "n8n");
  assert.equal(output.correlationId, "exec-1");
  assert.equal(output.httpStatus, 200);
  assert.equal(output.durationMs, 42);
  assert.deepEqual(output.output, { status: "received" });
});

// An orphan run in n8n would be worse than a refusal here: nothing would tie it
// back to a request, a plan or an audit trail.
test("no execution id means no call, and no invented identifier", async () => {
  const client = stubClient();
  const registry = buildRegistry(buildTool({ client }), new InMemoryRepository());

  for (const executionId of [undefined, null, "", "   "]) {
    await assert.rejects(
      () => registry.execute(TOOL_ID, { ...CONTEXT, executionId, audit: false }, INPUT),
      (error) => {
        assert.equal(error.code, "TOOL_FAILED");
        assert.equal(error.details.adapterCode, "N8N_EXECUTION_CONTEXT_REQUIRED");
        return true;
      }
    );
  }
  assert.equal(client.calls.length, 0, "a refused call must never reach n8n");
});

test("an invalid input is refused before anything is sent", async () => {
  const client = stubClient();
  const registry = buildRegistry(buildTool({ client }), new InMemoryRepository());

  await assert.rejects(() => registry.execute(TOOL_ID, { ...CONTEXT, audit: false }, { requestId: "req-1" }));
  assert.equal(client.calls.length, 0);
});

test("a boundary failure becomes a tool adapter failure, without leaking", async () => {
  const boundaryError = new WorkflowBoundaryError("The n8n webhook answered with an unexpected status.", "N8N_UNEXPECTED_STATUS", {
    url: "https://n8n.example.test/delay-alert",
    httpStatus: 500,
    durationMs: 33,
    body: "[REDACTED]"
  });
  const client = stubClient({ error: boundaryError });
  const adapter = createN8nToolAdapter({
    toolId: TOOL_ID,
    eventType: EVENT_TYPE,
    inputSchema: INPUT_SCHEMA,
    client
  });

  // The adapter itself: this is where the diagnosis lives.
  await assert.rejects(
    () => adapter.execute(CONTEXT, INPUT),
    (error) => {
      assert.ok(error instanceof ToolAdapterError);
      assert.equal(error.code, "N8N_WORKFLOW_CALL_FAILED");
      assert.equal(error.details.boundaryCode, "N8N_UNEXPECTED_STATUS");
      assert.equal(error.details.httpStatus, 500);
      assert.equal(error.details.correlationId, "exec-1");
      assert.equal(error.details.url, "https://n8n.example.test/delay-alert");
      return true;
    }
  );
});

// The registry turns a ToolAdapterError into a ToolRegistryError and keeps only
// the adapter code: the richer details stay at the adapter level.
test("a boundary failure surfaces through the registry as a tool failure", async () => {
  const client = stubClient({
    error: new WorkflowBoundaryError("timeout", "N8N_REQUEST_TIMEOUT", { url: "https://n8n.example.test/x" })
  });
  const registry = buildRegistry(buildTool({ client }), new InMemoryRepository());

  await assert.rejects(
    () => registry.execute(TOOL_ID, { ...CONTEXT, audit: false }, INPUT),
    (error) => {
      assert.equal(error.code, "TOOL_FAILED");
      assert.equal(error.details.adapterCode, "N8N_WORKFLOW_CALL_FAILED");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// The four controls. Each one must refuse before the client is ever called.
// ---------------------------------------------------------------------------

test("control 1: an agent that is not allowed never reaches n8n", async () => {
  const client = stubClient();
  const registry = buildRegistry(buildTool({ client }), new InMemoryRepository());

  await assert.rejects(
    () => registry.execute(TOOL_ID, { ...CONTEXT, agentId: "marketing", audit: false }, INPUT),
    (error) => error.code === "AGENT_NOT_ALLOWED"
  );
  assert.equal(client.calls.length, 0);
});

test("control 2: a sensitive tool called outside ToolExecutionService never reaches n8n", async () => {
  const client = stubClient();
  const tool = buildTool({ client, requiredPermission: "execute_action" });
  const registry = buildRegistry(tool, new InMemoryRepository());

  await assert.rejects(
    () => registry.execute(TOOL_ID, { ...CONTEXT, audit: false }, INPUT),
    (error) => error.code === "PERMISSION_DENIED"
  );
  assert.equal(client.calls.length, 0);
});

test("control 3: an agent without the security domain never reaches n8n", async (t) => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const client = stubClient();
  const registry = buildRegistry(buildTool({ client, securityDomains: ["payments"] }), repository);
  const service = new ToolExecutionService({ repository, toolRegistry: registry });
  const request = await repository.createRequest({ title: "t", payload: {} });

  await assert.rejects(
    () => service.execute({
      agentId: "production",
      agentPermissions: createMvpAgentPermissions("production"),
      toolId: TOOL_ID,
      input: { requestId: request.id, orderId: "order-atlas-001" },
      requestId: request.id
    }),
    (error) => {
      assert.equal(error.code, "DOMAIN_NOT_ALLOWED");
      return true;
    }
  );
  assert.equal(client.calls.length, 0, "a domain refusal must never reach n8n");
});

test("control 4: a sensitive tool without approval prepares and never reaches n8n", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const client = stubClient();
  const registry = buildRegistry(buildTool({ client, requiredPermission: "execute_action" }), repository);
  const service = new ToolExecutionService({ repository, toolRegistry: registry });
  const request = await repository.createRequest({ title: "t", payload: {} });

  await assert.rejects(() => service.execute({
    agentId: "production",
    agentPermissions: createMvpAgentPermissions("production"),
    toolId: TOOL_ID,
    input: { requestId: request.id, orderId: "order-atlas-001" },
    requestId: request.id
  }));
  assert.equal(client.calls.length, 0, "an unapproved action must never reach n8n");
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test("a successful call is audited like any other tool", async () => {
  const repository = new InMemoryRepository();
  const client = stubClient();
  const registry = buildRegistry(buildTool({ client }), repository);

  await registry.execute(TOOL_ID, CONTEXT, INPUT);
  const types = (await repository.listAuditEvents()).map((event) => event.type);

  assert.ok(types.includes("tool_called"));
  assert.ok(types.includes("tool_completed"));
});

test("a refused call is audited as a permission denial", async () => {
  const repository = new InMemoryRepository();
  const client = stubClient();
  const registry = buildRegistry(buildTool({ client }), repository);

  await assert.rejects(() => registry.execute(TOOL_ID, { ...CONTEXT, agentId: "marketing" }, INPUT));
  const types = (await repository.listAuditEvents()).map((event) => event.type);

  assert.ok(types.includes("permission_denied"));
  assert.ok(types.includes("tool_failed"));
  assert.equal(client.calls.length, 0);
});

test("a boundary failure is audited as a tool failure", async () => {
  const repository = new InMemoryRepository();
  const client = stubClient({
    error: new WorkflowBoundaryError("timeout", "N8N_REQUEST_TIMEOUT", { url: "https://n8n.example.test/x" })
  });
  const registry = buildRegistry(buildTool({ client }), repository);

  await assert.rejects(() => registry.execute(TOOL_ID, CONTEXT, INPUT));
  const types = (await repository.listAuditEvents()).map((event) => event.type);

  assert.ok(types.includes("tool_called"));
  assert.ok(types.includes("tool_failed"));
});

// ---------------------------------------------------------------------------
// Nothing is wired into the product yet.
// ---------------------------------------------------------------------------

test("the MVP registry holds no n8n adapter and still lists twenty one tools", () => {
  const registry = createMvpToolRegistry();
  const tools = registry.list();

  assert.equal(tools.length, 21);
  for (const tool of tools) {
    const adapter = registry.getAdapter(tool.id);
    assert.notEqual(adapter?.kind, "n8n", `${tool.id} must not be wired to n8n yet`);
  }
});
