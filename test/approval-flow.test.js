import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalStateError,
  InMemoryRepository,
  PrismaRepository,
  ToolExecutionService,
  ToolExecutionServiceError,
  ToolRegistry,
  approveApprovalRequest,
  buildApi,
  createPermission,
  createPrismaClient,
  createToolDefinition,
  createToolInputSchema,
  executeApprovedApproval,
  hasValidDatabaseUrl,
  rejectApprovalRequest,
  seedMvpAgents
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

const postgresIntegrationEnabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const postgresUrlAvailable = hasValidDatabaseUrl(process.env.DATABASE_URL);
const postgresSkipReason =
  postgresIntegrationEnabled && postgresUrlAvailable
    ? false
    : "Set RUN_POSTGRES_INTEGRATION=true and DATABASE_URL to run PostgreSQL approval flow tests.";

test("read/analyze actions execute directly without approval", async () => {
  const { repository, service } = await createServiceHarness();

  const result = await service.execute(createReadInput());
  const approvals = await repository.listPendingApprovals({ requestId: "req-approval" });

  assert.equal(result.status, "completed");
  assert.equal(result.execution.status, "completed");
  assert.deepEqual(approvals, []);
});

test("sensitive actions create pending approval and do not execute the tool", async () => {
  const { repository, service } = await createServiceHarness();
  const approval = await requirePendingApproval(service);
  const executions = await repository.listExecutions();
  const events = await repository.listAuditEvents({ requestId: "req-approval" });

  assert.equal(approval.status, "pending");
  assert.equal(approval.requestedAction, "execute_sensitive_tool");
  assert.equal(executions.length, 0);
  assert.ok(events.some((event) => event.type === "approval_requested"));
  assert.equal(events.some((event) => event.type === "tool_called"), false);
});

test("approved approval executes the sensitive tool once", async () => {
  const { repository, service } = await createServiceHarness();
  const pending = await requirePendingApproval(service);
  const approved = await approveApprovalRequest({
    repository,
    approvalId: pending.id,
    approverId: APPROVER_ID
  });

  const result = await service.execute(createSensitiveInput({ approvalId: approved.id }));
  const savedApproval = await repository.getApproval(approved.id);
  const events = await repository.listAuditEvents({ requestId: "req-approval" });

  assert.equal(result.status, "completed");
  assert.equal(result.output.result.demo, true);
  assert.equal(savedApproval.status, "approved");
  assert.equal(savedApproval.metadata.executionId, result.execution.id);
  assert.ok(events.some((event) => event.type === "approval_granted"));
  assert.ok(events.some((event) => event.type === "tool_called"));
  assert.ok(events.some((event) => event.type === "tool_completed"));
});

test("rejected approval prevents sensitive tool execution", async () => {
  const { repository, service } = await createServiceHarness();
  const pending = await requirePendingApproval(service);
  const rejected = await rejectApprovalRequest({
    repository,
    approvalId: pending.id,
    approverId: APPROVER_ID
  });

  await assert.rejects(
    () => service.execute(createSensitiveInput({ approvalId: rejected.id })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "APPROVAL_REJECTED"
  );

  const events = await repository.listAuditEvents({ requestId: "req-approval" });
  assert.ok(events.some((event) => event.type === "approval_rejected"));
  assert.equal(events.some((event) => event.type === "tool_called"), false);
});

test("double approval is rejected cleanly", async () => {
  const { repository, service } = await createServiceHarness();
  const pending = await requirePendingApproval(service);

  await approveApprovalRequest({ repository, approvalId: pending.id, approverId: APPROVER_ID });

  await assert.rejects(
    () => approveApprovalRequest({ repository, approvalId: pending.id, approverId: APPROVER_ID }),
    (error) => error instanceof ApprovalStateError && error.code === "APPROVAL_ALREADY_APPROVED"
  );
});

test("double execution with the same approval is impossible", async () => {
  const { repository, service } = await createServiceHarness();
  const pending = await requirePendingApproval(service);
  const approved = await approveApprovalRequest({ repository, approvalId: pending.id, approverId: APPROVER_ID });

  await service.execute(createSensitiveInput({ approvalId: approved.id }));

  await assert.rejects(
    () => service.execute(createSensitiveInput({ approvalId: approved.id })),
    (error) => error instanceof ToolExecutionServiceError && error.code === "APPROVAL_ALREADY_EXECUTED"
  );
});

test("approval repository supports pending, approve, and reject transitions in memory", async () => {
  const repository = new InMemoryRepository();
  const created = await repository.createApproval(createApprovalRecord({ id: "approval-memory" }));

  assert.equal(created.status, "pending");
  assert.equal((await repository.listPendingApprovals()).length, 1);

  const approved = await repository.approveApproval(created.id, { approverId: APPROVER_ID });
  assert.equal(approved.status, "approved");

  const rejectedSource = await repository.createApproval(createApprovalRecord({ id: "approval-reject" }));
  const rejected = await repository.rejectApproval(rejectedSource.id, { approverId: APPROVER_ID });
  assert.equal(rejected.status, "rejected");
});

test("approval API lists, reads, approves, and executes pending approvals", async (t) => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  await grantFinanceExecution(repository);
  const registry = createSensitiveRegistry();
  const { app, inject } = await buildAuthenticatedApi({
    repository,
    seedAgents: false,
    planner: createSensitivePlanner(),
    toolRegistry: registry
  });
  t.after(() => app.close());

  const requestResponse = await inject({
    method: "POST",
    url: "/api/requests",
    payload: { message: "execute sensitive approval flow" }
  });
  const createdRequest = JSON.parse(requestResponse.body).request;
  const approval = createdRequest.approvals[0];

  assert.equal(createdRequest.status, "blocked");
  assert.equal(createdRequest.executions.length, 0);
  assert.equal(approval.status, "pending");

  const listResponse = await inject({ method: "GET", url: "/api/approvals" });
  const listBody = JSON.parse(listResponse.body);
  assert.equal(listBody.approvals.some((entry) => entry.id === approval.id), true);

  const getResponse = await inject({ method: "GET", url: `/api/approvals/${approval.id}` });
  assert.equal(getResponse.statusCode, 200);

  const approveResponse = await inject({
    method: "POST",
    url: `/api/approvals/${approval.id}/approve`,
    payload: {}
  });
  const approveBody = JSON.parse(approveResponse.body);

  assert.equal(approveResponse.statusCode, 200);
  assert.equal(approveBody.approval.status, "approved");
  assert.equal(approveBody.execution.status, "completed");
  assert.equal(approveBody.execution.output.result.demo, true);

  const secondApprove = await inject({
    method: "POST",
    url: `/api/approvals/${approval.id}/approve`,
    payload: {}
  });
  assert.equal(secondApprove.statusCode, 409);
});

test("approval API rejects approvals without executing tools", async (t) => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  await grantFinanceExecution(repository);
  const { app, inject } = await buildAuthenticatedApi({
    repository,
    seedAgents: false,
    planner: createSensitivePlanner(),
    toolRegistry: createSensitiveRegistry()
  });
  t.after(() => app.close());

  const requestResponse = await inject({
    method: "POST",
    url: "/api/requests",
    payload: { message: "execute sensitive approval flow" }
  });
  const approval = JSON.parse(requestResponse.body).request.approvals[0];

  const rejectResponse = await inject({
    method: "POST",
    url: `/api/approvals/${approval.id}/reject`,
    payload: {}
  });
  const rejectBody = JSON.parse(rejectResponse.body);
  const events = await repository.listAuditEvents({ requestId: approval.requestId });

  assert.equal(rejectResponse.statusCode, 200);
  assert.equal(rejectBody.approval.status, "rejected");
  assert.equal((await repository.listExecutions()).length, 0);
  assert.ok(events.some((event) => event.type === "approval_rejected"));
  assert.equal(events.some((event) => event.type === "tool_called"), false);
});

test("approval API returns clean errors for missing approvals", async (t) => {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository, seedAgents: false });
  t.after(() => app.close());

  const getResponse = await inject({ method: "GET", url: "/api/approvals/missing" });
  const approveResponse = await inject({ method: "POST", url: "/api/approvals/missing/approve" });

  assert.equal(getResponse.statusCode, 404);
  assert.equal(JSON.parse(getResponse.body).details.code, "APPROVAL_NOT_FOUND");
  assert.equal(approveResponse.statusCode, 404);
  assert.equal(JSON.parse(approveResponse.body).details.code, "APPROVAL_NOT_FOUND");
});

test("PostgreSQL approval flow persists pending approval, approval execution, and audits", {
  skip: postgresSkipReason
}, async () => {
  const prisma = await createPrismaClient();
  const repository = new PrismaRepository({ prisma });
  const { app, inject } = await buildAuthenticatedApi({
    repository,
    seedAgents: false,
    planner: createSensitivePlanner(),
    toolRegistry: createSensitiveRegistry()
  });
  let requestId = null;

  try {
    await seedMvpAgents(repository);
    await grantFinanceExecution(repository);

    const requestResponse = await inject({
      method: "POST",
      url: "/api/requests",
      payload: { message: "execute sensitive approval flow" }
    });
    const createdRequest = JSON.parse(requestResponse.body).request;
    requestId = createdRequest.id;
    const approval = createdRequest.approvals[0];

    assert.equal(createdRequest.status, "blocked");
    assert.equal(approval.status, "pending");
    assert.equal(
      await prisma.auditEvent.count({ where: { requestId, type: "tool_called" } }),
      0
    );

    const approveResponse = await inject({
      method: "POST",
      url: `/api/approvals/${approval.id}/approve`,
      payload: {}
    });
    const approveBody = JSON.parse(approveResponse.body);
    const persistedApproval = await prisma.approval.findUnique({ where: { id: approval.id } });

    assert.equal(approveResponse.statusCode, 200);
    assert.equal(approveBody.execution.status, "completed");
    assert.equal(persistedApproval.status, "approved");
    assert.equal(await prisma.execution.count({ where: { requestId } }), 1);
    assert.equal(await prisma.auditEvent.count({ where: { requestId, type: "tool_called" } }), 1);
    assert.equal(await prisma.auditEvent.count({ where: { requestId, type: "approval_granted" } }), 1);
  } finally {
    if (requestId) {
      await prisma.request.delete({ where: { id: requestId } }).catch(() => undefined);
    }
    await app.close();
  }
});

const APPROVER_ID = "leader-1";

// An approval decision is only valid for a real user carrying the approval
// capability, so the harness provisions one exactly as production would.
async function createServiceHarness() {
  const repository = new InMemoryRepository();
  await repository.upsertUser({ id: APPROVER_ID, name: "Leader One", role: "leader" });
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createSensitiveRegistry()
  });
  return { repository, service };
}

function createReadInput() {
  return {
    agentId: "finance",
    agentPermissions: [
      createPermission({ kind: "read_analyze", resource: "request:*" })
    ],
    toolId: "read_demo_tool",
    input: { requestId: "req-approval" },
    requestId: "req-approval",
    planId: "plan-approval",
    planStepId: "step-approval"
  };
}

function createSensitiveInput({ approvalId = null } = {}) {
  return {
    agentId: "finance",
    agentPermissions: [
      createPermission({ kind: "execute_action", resource: "request:*" })
    ],
    toolId: "execute_sensitive_tool",
    input: { requestId: "req-approval" },
    requestId: "req-approval",
    planId: "plan-approval",
    planStepId: "step-approval",
    approvalId
  };
}

async function requirePendingApproval(service) {
  let pending = null;
  await assert.rejects(
    () => service.execute(createSensitiveInput()),
    (error) => {
      pending = error.details.approval;
      return error instanceof ToolExecutionServiceError && error.code === "APPROVAL_REQUIRED";
    }
  );
  return pending;
}

function createSensitiveRegistry() {
  const registry = new ToolRegistry();
  registry.register(createDemoTool({
    id: "read_demo_tool",
    requiredPermission: "read_analyze"
  }));
  registry.register(createDemoTool({
    id: "execute_sensitive_tool",
    requiredPermission: "execute_action"
  }));
  return registry;
}

function createDemoTool({ id, requiredPermission }) {
  return createToolDefinition({
    id,
    name: id,
    description: "Local deterministic test tool.",
    category: "test",
    requiredPermission,
    allowedAgents: ["finance"],
    inputSchema: createToolInputSchema({
      required: ["requestId"],
      properties: {
        requestId: { type: "string" }
      }
    }),
    execute: async (context) => ({
      demo: true,
      dataSource: "test_mock",
      context,
      items: [{ status: "ok" }]
    })
  });
}

function createApprovalRecord({ id }) {
  return {
    id,
    requestId: "req-approval",
    planStepId: "step-approval",
    requestingAgent: "finance",
    requestedByAgentId: "finance",
    requestedAction: "execute_sensitive_tool",
    reason: "Approval flow test.",
    affectedResource: "request:req-approval",
    risk: "high",
    status: "pending",
    metadata: {
      toolId: "execute_sensitive_tool"
    }
  };
}

async function grantFinanceExecution(repository) {
  const finance = await repository.getAgent("finance");
  await repository.upsertAgent({
    ...finance,
    permissions: [
      createPermission({ kind: "execute_action", resource: "request:*" })
    ]
  });
}

function createSensitivePlanner() {
  return async ({ request }) => ({
    version: "1",
    requestId: request.id,
    intent: "sensitive_approval_flow_test",
    summary: "Sensitive approval flow test plan.",
    planner: "test_sensitive",
    agents: ["finance"],
    steps: [
      {
        id: `${request.id}:test-sensitive:1:finance`,
        agentId: "finance",
        sequence: 1,
        actionKind: "execute_action",
        actionType: "execute_sensitive_tool",
        toolName: "execute_sensitive_tool",
        resource: `request:${request.id}`,
        reason: "Test sensitive action requires approval.",
        input: {
          requestId: request.id
        },
        requiresApproval: false
      }
    ],
    metadata: {
      planner: "test_sensitive"
    }
  });
}
