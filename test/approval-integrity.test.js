import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalStateError,
  InMemoryRepository,
  ToolExecutionService,
  ToolExecutionServiceError,
  ToolRegistry,
  approveApprovalRequest,
  buildApi,
  createPermission,
  createToolDefinition,
  createToolInputSchema,
  rejectApprovalRequest,
  seedMvpAgents
} from "../src/index.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

const SENSITIVE_TOOL_ID = "execute_sensitive_action";

function createSensitiveRegistry(calls = []) {
  const registry = new ToolRegistry();
  registry.register(createToolDefinition({
    id: SENSITIVE_TOOL_ID,
    name: "Execute Sensitive Action",
    description: "Mock sensitive action used to verify the approval integrity rules.",
    category: "finance",
    requiredPermission: "execute_action",
    allowedAgents: ["finance"],
    inputSchema: createToolInputSchema({
      required: ["requestId"],
      properties: { requestId: { type: "string" } }
    }),
    execute: async (context) => {
      calls.push(context);
      return { demo: true, items: [] };
    }
  }));
  return registry;
}

async function createPendingApproval({ repository, calls }) {
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createSensitiveRegistry(calls)
  });

  let pending = null;
  await assert.rejects(
    () => service.execute({
      agentId: "finance",
      agentPermissions: [createPermission({ kind: "execute_action", resource: "request:*" })],
      toolId: SENSITIVE_TOOL_ID,
      input: { requestId: "req-integrity" },
      requestId: "req-integrity",
      planStepId: "step-integrity"
    }),
    (error) => {
      pending = error.details.approval;
      return error instanceof ToolExecutionServiceError && error.code === "APPROVAL_REQUIRED";
    }
  );

  return { service, pending };
}

test("an approval cannot be granted without an approver", async () => {
  const repository = new InMemoryRepository();
  const { pending } = await createPendingApproval({ repository, calls: [] });

  await assert.rejects(
    () => approveApprovalRequest({ repository, approvalId: pending.id }),
    (error) => error instanceof ApprovalStateError && error.code === "APPROVER_REQUIRED"
  );

  assert.equal((await repository.getApproval(pending.id)).status, "pending");
});

test("an approval cannot be granted by an approver that does not exist", async () => {
  const repository = new InMemoryRepository();
  const { pending } = await createPendingApproval({ repository, calls: [] });

  await assert.rejects(
    () => approveApprovalRequest({ repository, approvalId: pending.id, approverId: "ghost-approver" }),
    (error) => error instanceof ApprovalStateError && error.code === "APPROVER_UNKNOWN"
  );

  assert.equal((await repository.getApproval(pending.id)).status, "pending");
});

test("an approval cannot be granted by a user whose role cannot decide", async () => {
  const repository = new InMemoryRepository();
  await repository.upsertUser({ id: "operator-1", name: "Operator", role: "operator" });
  const { pending } = await createPendingApproval({ repository, calls: [] });

  await assert.rejects(
    () => approveApprovalRequest({ repository, approvalId: pending.id, approverId: "operator-1" }),
    (error) => error instanceof ApprovalStateError && error.code === "APPROVER_NOT_ALLOWED"
  );

  assert.equal((await repository.getApproval(pending.id)).status, "pending");
});

test("a rejection is subject to the same approver rules as an approval", async () => {
  const repository = new InMemoryRepository();
  await repository.upsertUser({ id: "operator-2", name: "Operator", role: "operator" });
  const { pending } = await createPendingApproval({ repository, calls: [] });

  await assert.rejects(
    () => rejectApprovalRequest({ repository, approvalId: pending.id }),
    (error) => error instanceof ApprovalStateError && error.code === "APPROVER_REQUIRED"
  );
  await assert.rejects(
    () => rejectApprovalRequest({ repository, approvalId: pending.id, approverId: "nobody" }),
    (error) => error instanceof ApprovalStateError && error.code === "APPROVER_UNKNOWN"
  );
  await assert.rejects(
    () => rejectApprovalRequest({ repository, approvalId: pending.id, approverId: "operator-2" }),
    (error) => error instanceof ApprovalStateError && error.code === "APPROVER_NOT_ALLOWED"
  );
});

test("a granted approval records the real approver in the approval and in the audit trail", async () => {
  const repository = new InMemoryRepository();
  await repository.upsertUser({ id: "leader-real", name: "Real Leader", role: "leader" });
  const { pending } = await createPendingApproval({ repository, calls: [] });

  const approved = await approveApprovalRequest({
    repository,
    approvalId: pending.id,
    approverId: "leader-real",
    decisionReason: "Verified with the supplier."
  });

  assert.equal(approved.status, "approved");
  assert.equal(approved.approverId, "leader-real");

  const granted = (await repository.listAuditEvents()).find((event) => event.type === "approval_granted");
  assert.equal(granted.actorUserId, "leader-real");
});

test("the API refuses an approverId supplied in the request body", async (t) => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const { app, inject } = await buildAuthenticatedApi({ repository, userId: "leader-api", seedAgents: false });
  t.after(() => app.close());

  for (const url of ["/api/approvals/any-id/approve", "/api/approvals/any-id/reject"]) {
    const response = await inject({
      method: "POST",
      url,
      payload: { approverId: "someone-else" }
    });

    assert.equal(response.statusCode, 400, `${url} must refuse a body-supplied approver`);
    assert.equal(JSON.parse(response.body).details.code, "IDENTITY_NOT_ACCEPTED_FROM_BODY");
  }
});

test("the API refuses a createdById supplied in the request body", async (t) => {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository, userId: "leader-author-api" });
  t.after(() => app.close());

  for (const url of ["/api/requests", "/api/director/requests"]) {
    const response = await inject({
      method: "POST",
      url,
      payload: { message: "point", createdById: "the-ceo" }
    });

    assert.equal(response.statusCode, 400, `${url} must refuse a body-supplied author`);
  }
});

// End to end through the API, so the approval references a real request and
// plan step and the sensitive tool can actually run once approved.
function createSensitivePlanner() {
  return async ({ request }) => ({
    version: "1",
    requestId: request.id,
    intent: "approval_integrity_test",
    summary: "Approval integrity test plan.",
    planner: "test_integrity",
    agents: ["finance"],
    steps: [
      {
        id: `${request.id}:integrity:1:finance`,
        agentId: "finance",
        sequence: 1,
        actionKind: "execute_action",
        actionType: SENSITIVE_TOOL_ID,
        toolName: SENSITIVE_TOOL_ID,
        resource: `request:${request.id}`,
        reason: "Test sensitive action requires approval.",
        input: { requestId: request.id },
        requiresApproval: false
      }
    ],
    metadata: { planner: "test_integrity" }
  });
}

test("the approval decision through the API is attributed to the authenticated principal", async (t) => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const finance = await repository.getAgent("finance");
  await repository.upsertAgent({
    ...finance,
    permissions: [createPermission({ kind: "execute_action", resource: "request:*" })]
  });

  const calls = [];
  const app = buildApi({
    repository,
    seedAgents: false,
    planner: createSensitivePlanner(),
    toolRegistry: createSensitiveRegistry(calls)
  });
  t.after(() => app.close());

  const author = await createAuthenticatedUser(repository, { id: "operator-http", role: "operator" });
  const approver = await createAuthenticatedUser(repository, { id: "leader-http", role: "approver" });

  const created = await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: { message: "Execute the sensitive action." },
    headers: author.headers
  });
  const pending = JSON.parse(created.body).request.approvals[0];

  assert.equal(pending.status, "pending");
  assert.equal(calls.length, 0, "the tool must not run before approval");

  const response = await app.inject({
    method: "POST",
    url: `/api/approvals/${pending.id}/approve`,
    payload: { decisionReason: "Checked." },
    headers: approver.headers
  });

  assert.equal(response.statusCode, 200);
  // The approver is the caller, not the author, and not anything from the body.
  assert.equal(JSON.parse(response.body).approval.approverId, "leader-http");
  assert.equal(calls.length, 1);

  const granted = (await repository.listAuditEvents()).find((event) => event.type === "approval_granted");
  assert.equal(granted.actorUserId, "leader-http");
});

test("the replay guard still prevents a second execution of the same approval", async () => {
  const repository = new InMemoryRepository();
  await repository.upsertUser({ id: "leader-replay", name: "Leader", role: "leader" });
  const calls = [];
  const { service, pending } = await createPendingApproval({ repository, calls });

  const approved = await approveApprovalRequest({
    repository,
    approvalId: pending.id,
    approverId: "leader-replay"
  });

  const sensitiveInput = {
    agentId: "finance",
    agentPermissions: [createPermission({ kind: "execute_action", resource: "request:*" })],
    toolId: SENSITIVE_TOOL_ID,
    input: { requestId: "req-integrity" },
    requestId: "req-integrity",
    planStepId: "step-integrity",
    approvalId: approved.id
  };

  await service.execute(sensitiveInput);
  assert.equal(calls.length, 1);

  await assert.rejects(
    () => service.execute(sensitiveInput),
    (error) => error instanceof ToolExecutionServiceError && error.code === "APPROVAL_ALREADY_EXECUTED"
  );
  assert.equal(calls.length, 1);
});

test("a second decision on a decided approval is still refused", async () => {
  const repository = new InMemoryRepository();
  await repository.upsertUser({ id: "leader-double", name: "Leader", role: "leader" });
  const { pending } = await createPendingApproval({ repository, calls: [] });

  await approveApprovalRequest({ repository, approvalId: pending.id, approverId: "leader-double" });

  await assert.rejects(
    () => approveApprovalRequest({ repository, approvalId: pending.id, approverId: "leader-double" }),
    (error) => error instanceof ApprovalStateError && error.code === "APPROVAL_ALREADY_APPROVED"
  );
});
