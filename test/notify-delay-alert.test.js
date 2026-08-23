import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TOOLS_BY_AGENT,
  InMemoryRepository,
  ToolAdapterError,
  ToolExecutionService,
  ToolExecutionServiceError,
  createDeterministicPlan,
  createMvpAgentPermissions,
  createMvpToolRegistry,
  createN8nToolAdapter,
  createPermission,
  createToolInputSchema,
  domainResource
} from "../src/index.js";

// Nothing in this file reaches the network. Every client is a stub that counts
// its calls, so a control that is supposed to refuse can be proved to have
// refused BEFORE anything left the process.
const TOOL_ID = "notify_delay_alert";
const INPUT = Object.freeze({
  requestId: "req-delay",
  orderId: "order-atlas-001",
  delayRisk: "high"
});

function stubClient({ error = null, body = { status: "received" } } = {}) {
  const calls = [];
  return {
    calls,
    postWorkflowEvent: async (event) => {
      calls.push(event);
      if (error) {
        throw error;
      }
      return { httpStatus: 200, body, durationMs: 4 };
    }
  };
}

function buildService(client, repository = new InMemoryRepository()) {
  return {
    repository,
    service: new ToolExecutionService({
      repository,
      toolRegistry: createMvpToolRegistry({ repository, workflowClient: client })
    })
  };
}

function serviceInput(overrides = {}) {
  return {
    agentId: "production",
    agentPermissions: createMvpAgentPermissions("production"),
    toolId: TOOL_ID,
    input: INPUT,
    requestId: "req-delay",
    planId: "plan-delay",
    planStepId: "step-delay",
    ...overrides
  };
}

test("the tool exists only when a client is injected", () => {
  const withoutClient = createMvpToolRegistry();
  const withClient = createMvpToolRegistry({ workflowClient: stubClient() });

  assert.equal(withoutClient.list().length, 21);
  assert.equal(withoutClient.get(TOOL_ID), null);
  assert.equal(withClient.list().length, 22);
  assert.ok(withClient.get(TOOL_ID));
});

test("the tool declares an outbound action, not a read", () => {
  const tool = createMvpToolRegistry({ workflowClient: stubClient() }).get(TOOL_ID);

  assert.equal(tool.requiredPermission, "execute_action");
  assert.deepEqual(tool.allowedAgents, ["production"]);
  assert.deepEqual(tool.securityDomains, ["production", "orders", "external_notifications"]);
  assert.deepEqual(tool.inputSchema.required, ["requestId", "orderId", "delayRisk"]);
});

// The planner must not be able to produce this step on its own.
test("no plan can route to the delay alert", () => {
  for (const tools of Object.values(DEFAULT_TOOLS_BY_AGENT)) {
    assert.equal(tools.includes(TOOL_ID), false);
  }

  for (const text of [
    "alerte retard production commande",
    "production delay alert",
    "fais le point complet sur l entreprise"
  ]) {
    const plan = createDeterministicPlan({ id: "req-plan", payload: { text } });
    assert.equal(plan.steps.some((step) => step.toolName === TOOL_ID), false, text);
  }
});

test("without an approval, nothing is sent and an approval is opened", async () => {
  const client = stubClient();
  const { repository, service } = buildService(client);

  await assert.rejects(
    () => service.execute(serviceInput()),
    (error) => {
      assert.ok(error instanceof ToolExecutionServiceError);
      assert.equal(error.code, "APPROVAL_REQUIRED");
      return true;
    }
  );

  assert.equal(client.calls.length, 0, "an unapproved alert must never be sent");

  const pending = await repository.listPendingApprovals({ requestId: "req-delay" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].requestedAction, TOOL_ID);
  assert.equal(pending[0].requestingAgent, "production");
});

test("an approved alert is sent once, correlated to its execution", async () => {
  const client = stubClient();
  const { repository, service } = buildService(client);

  await assert.rejects(() => service.execute(serviceInput()), { code: "APPROVAL_REQUIRED" });
  const [pending] = await repository.listPendingApprovals({ requestId: "req-delay" });
  await repository.approveApproval(pending.id, { approverId: null });

  const result = await service.execute(serviceInput({ approvalId: pending.id }));

  assert.equal(result.status, "completed");
  assert.equal(client.calls.length, 1);

  const [event] = client.calls;
  assert.equal(event.type, "delay_alert");
  assert.equal(event.agentId, "production");
  assert.equal(event.correlationId, result.execution.id);
  assert.equal(event.id, `${result.execution.id}:delay_alert`);
  assert.equal(event.payload.orderId, INPUT.orderId);
  assert.equal(event.payload.delayRisk, INPUT.delayRisk);

  assert.equal(result.output.result.provider, "n8n");
  assert.equal(result.output.result.httpStatus, 200);
  assert.equal(result.output.result.correlationId, result.execution.id);
});

// The one guarantee that stands in for the idempotency this commit does not
// implement: an approval is spent when it is used, and cannot be spent twice.
test("an approval cannot be replayed to send the alert again", async () => {
  const client = stubClient();
  const { repository, service } = buildService(client);

  await assert.rejects(() => service.execute(serviceInput()), { code: "APPROVAL_REQUIRED" });
  const [pending] = await repository.listPendingApprovals({ requestId: "req-delay" });
  await repository.approveApproval(pending.id, { approverId: null });

  await service.execute(serviceInput({ approvalId: pending.id }));
  await assert.rejects(
    () => service.execute(serviceInput({ approvalId: pending.id })),
    (error) => {
      assert.equal(error.code, "APPROVAL_ALREADY_EXECUTED");
      return true;
    }
  );

  assert.equal(client.calls.length, 1, "a replayed approval must not send a second alert");
});

test("a rejected approval sends nothing", async () => {
  const client = stubClient();
  const { repository, service } = buildService(client);

  await assert.rejects(() => service.execute(serviceInput()), { code: "APPROVAL_REQUIRED" });
  const [pending] = await repository.listPendingApprovals({ requestId: "req-delay" });
  await repository.rejectApproval(pending.id, { approverId: null });

  await assert.rejects(
    () => service.execute(serviceInput({ approvalId: pending.id })),
    (error) => {
      assert.equal(error.code, "APPROVAL_REJECTED");
      return true;
    }
  );
  assert.equal(client.calls.length, 0);
});

test("an agent that is not production cannot reach the alert", async () => {
  const client = stubClient();
  const { service } = buildService(client);

  await assert.rejects(
    () => service.execute(serviceInput({
      agentId: "after_sales",
      agentPermissions: createMvpAgentPermissions("after_sales")
    })),
    (error) => {
      assert.equal(error.code, "AGENT_NOT_ALLOWED");
      return true;
    }
  );
  assert.equal(client.calls.length, 0);
});

// external_notifications is the point of the new domain: revoking it alone must
// stop the alert, while the production and orders reads stay untouched.
test("revoking the outbound domain stops the alert on its own", async () => {
  const client = stubClient();
  const { service } = buildService(client);
  const withoutOutbound = createMvpAgentPermissions("production").filter(
    (permission) => permission.resource !== domainResource("external_notifications")
  );

  await assert.rejects(
    () => service.execute(serviceInput({ agentPermissions: withoutOutbound })),
    (error) => {
      assert.equal(error.code, "DOMAIN_NOT_ALLOWED");
      assert.deepEqual(error.details.missingDomains, ["external_notifications"]);
      return true;
    }
  );
  assert.equal(client.calls.length, 0);
});

test("an agent with no prepare permission is denied before any approval exists", async () => {
  const client = stubClient();
  const { repository, service } = buildService(client);
  const readOnly = [
    createPermission({ kind: "read_analyze", resource: "request:*" }),
    ...["production", "orders", "external_notifications"].map((domain) =>
      createPermission({ kind: "read_analyze", resource: domainResource(domain) })
    )
  ];

  await assert.rejects(
    () => service.execute(serviceInput({ agentPermissions: readOnly })),
    (error) => {
      assert.equal(error.code, "PERMISSION_DENIED");
      return true;
    }
  );

  assert.equal(client.calls.length, 0);
  assert.equal((await repository.listPendingApprovals({ requestId: "req-delay" })).length, 0);
});

test("a missing workflow input is refused before anything is built", async () => {
  const client = stubClient();
  const { service } = buildService(client);

  for (const field of ["orderId", "delayRisk"]) {
    const input = { ...INPUT };
    delete input[field];
    await assert.rejects(
      () => service.execute(serviceInput({ input })),
      (error) => {
        assert.equal(error.code, "INVALID_INPUT");
        return true;
      },
      field
    );
  }
  assert.equal(client.calls.length, 0);
});

// The workflow contract is the last check before the wire. It is exercised on
// the adapter directly, because the tool definition already restricts the agent.
test("the workflow contract is enforced before the call, not after", async () => {
  const schema = createToolInputSchema({
    required: ["orderId", "delayRisk"],
    properties: { orderId: { type: "string" }, delayRisk: { type: "string" } }
  });
  const client = stubClient();
  const adapter = createN8nToolAdapter({
    toolId: TOOL_ID,
    eventType: "delay_alert",
    inputSchema: schema,
    client
  });

  // finance is not among the delay_alert allowedAgents.
  await assert.rejects(
    () => adapter.execute(
      { agentId: "finance", requestId: "req-delay", executionId: "exec-1" },
      { orderId: "order-1", delayRisk: "high" }
    ),
    (error) => {
      assert.ok(error instanceof ToolAdapterError);
      assert.equal(error.code, "N8N_WORKFLOW_EVENT_INVALID");
      assert.equal(error.details.contractCode, "WORKFLOW_AGENT_NOT_ALLOWED");
      return true;
    }
  );

  // A payload the tool schema would have caught, checked again at the boundary.
  await assert.rejects(
    () => adapter.execute(
      { agentId: "production", requestId: "req-delay", executionId: "exec-1" },
      { orderId: "order-1", delayRisk: "" }
    ),
    (error) => {
      assert.equal(error.code, "N8N_WORKFLOW_EVENT_INVALID");
      assert.equal(error.details.contractCode, "WORKFLOW_INPUT_INVALID");
      return true;
    }
  );

  assert.equal(client.calls.length, 0, "a contract refusal must never reach n8n");
});

test("a failed call marks the execution failed and leaks no boundary detail", async () => {
  const client = stubClient({ error: new Error("boom") });
  const { repository, service } = buildService(client);

  await assert.rejects(() => service.execute(serviceInput()), { code: "APPROVAL_REQUIRED" });
  const [pending] = await repository.listPendingApprovals({ requestId: "req-delay" });
  await repository.approveApproval(pending.id, { approverId: null });

  await assert.rejects(() => service.execute(serviceInput({ approvalId: pending.id })));

  const executions = await repository.listExecutions();
  assert.equal(executions.length, 1);
  assert.equal(executions[0].status, "failed");
  assert.equal(client.calls.length, 1);
});
