import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  buildApi,
  canExecuteAction,
  createApprovalRequest,
  createPermission,
  evaluateActionPolicy,
  seedMvpAgents
} from "../src/index.js";

test("creates and reads a request through the in-memory repository", async () => {
  const repository = new InMemoryRepository();
  await repository.upsertUser({
    id: "user-1",
    name: "Leader Test",
    role: "leader"
  });

  const created = await repository.createRequest({
    id: "req-memory-1",
    createdById: "user-1",
    title: "Analyze daily priorities",
    payload: { objective: "prepare overview" },
    metadata: { channel: "test" }
  });

  const saved = await repository.getRequest("req-memory-1");
  assert.equal(created.status, "received");
  assert.equal((await repository.getUser("user-1")).name, "Leader Test");
  assert.equal(saved.createdById, "user-1");
  assert.deepEqual(saved.payload, { objective: "prepare overview" });
});

test("evaluates direct execution, proposal-only, and approval-required policies", () => {
  const executeDecision = evaluateActionPolicy({
    permissions: [createPermission({ kind: "execute_action", resource: "request:*" })],
    actionKind: "execute_action",
    resource: "request:123"
  });
  assert.equal(executeDecision.decision, "execute_directly");
  assert.equal(canExecuteAction(executeDecision), true);

  const prepareDecision = evaluateActionPolicy({
    permissions: [createPermission({ kind: "prepare_action", resource: "request:*" })],
    actionKind: "execute_action",
    resource: "request:123"
  });
  assert.equal(prepareDecision.decision, "prepare_only");
  assert.equal(prepareDecision.canPrepare, true);
  assert.equal(prepareDecision.allowed, false);

  const approvalDecision = evaluateActionPolicy({
    permissions: [
      createPermission({ kind: "execute_action", resource: "request:*" }),
      createPermission({ kind: "human_approval_required", resource: "request:123" })
    ],
    actionKind: "execute_action",
    resource: "request:123"
  });
  assert.equal(approvalDecision.decision, "requires_human_approval");
  assert.equal(approvalDecision.requiresApproval, true);
});

test("saves approval requests in the in-memory repository", async () => {
  const repository = new InMemoryRepository();
  const approval = createApprovalRequest({
    id: "approval-1",
    requestedAction: "execute prepared finance action",
    requestingAgent: "finance",
    reason: "Execution requires explicit approval in MVP policy.",
    affectedResource: "request:req-approval-1",
    risk: "high"
  });

  const saved = await repository.saveApproval({ ...approval, requestId: "req-approval-1" });
  assert.equal(saved.status, "requested");
  assert.equal((await repository.getApproval("approval-1")).requestingAgent, "finance");
});

test("creates redacted audit events in the in-memory repository", async () => {
  const repository = new InMemoryRepository();

  const event = await repository.createAuditEvent({
    type: "tool_called",
    requestId: "req-audit-1",
    agentId: "director",
    resourceType: "tool",
    resourceId: "n8n.workflow.prepare",
    metadata: {
      visible: "kept",
      apiKey: "x"
    }
  });

  assert.equal(event.type, "tool_called");
  assert.equal(event.metadata.visible, "kept");
  assert.equal(event.metadata.apiKey, "[REDACTED]");
});

test("GET /health reports service status", async (t) => {
  const app = buildApi();
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/health" });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.service, "ai-agents");
});

test("POST /api/requests creates a leader request", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: {
      title: "Prepare management overview",
      payload: { question: "What needs attention today?" },
      metadata: { channel: "api-test" }
    }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 201);
  assert.equal(body.request.status, "orchestrated");
  assert.equal(body.request.title, "Prepare management overview");
  assert.deepEqual(body.request.payload, { question: "What needs attention today?" });

  const events = await repository.listAuditEvents({ requestId: body.request.id });
  assert.ok(events.some((event) => event.type === "request_created"));
  assert.ok(events.some((event) => event.type === "plan_created"));
});

test("GET /api/requests/:id returns a persisted request", async (t) => {
  const repository = new InMemoryRepository();
  const created = await repository.createRequest({
    id: "req-api-get-1",
    title: "Retrieve me",
    payload: { ok: true }
  });
  const app = buildApi({ repository });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: `/api/requests/${created.id}` });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.request.id, "req-api-get-1");
  assert.deepEqual(body.request.payload, { ok: true });
});

test("POST /api/requests rejects an empty request body", async (t) => {
  const app = buildApi();
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: {}
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 400);
  assert.equal(body.error, "message, title, or payload is required.");
});

test("GET /api/requests/:id returns 404 for unknown requests", async (t) => {
  const app = buildApi();
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/requests/missing-request" });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 404);
  assert.equal(body.error, "Request not found.");
});

test("POST /api/requests returns a clean response when the repository fails", async (t) => {
  class FailingRepository extends InMemoryRepository {
    createRequest() {
      const error = new Error("database unavailable");
      error.name = "DatabaseError";
      throw error;
    }
  }

  const app = buildApi({ repository: new FailingRepository(), seedAgents: false });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: {
      message: "fais-moi le point sur mon entreprise"
    }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 500);
  assert.equal(body.error, "Request orchestration failed.");
  assert.deepEqual(body.details, { name: "DatabaseError" });
});

test("GET /api/requests/:id returns a clean response when the repository fails", async (t) => {
  class FailingRepository extends InMemoryRepository {
    getRequest() {
      const error = new Error("database unavailable");
      error.name = "DatabaseError";
      throw error;
    }
  }

  const app = buildApi({ repository: new FailingRepository(), seedAgents: false });
  t.after(() => app.close());

  const response = await app.inject({ method: "GET", url: "/api/requests/any-request" });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 500);
  assert.equal(body.error, "Request retrieval failed.");
  assert.deepEqual(body.details, { name: "DatabaseError" });
});

test("POST /api/requests rejects an invalid plan when the planner selects an unknown agent", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({
    repository,
    planner: async ({ request }) => ({
      version: "1",
      requestId: request.id,
      intent: "unknown_agent_test",
      summary: "Unknown agent test plan.",
      planner: "unknown-agent-test",
      agents: ["unknown-agent"],
      steps: [
        {
          id: `${request.id}:unknown-agent-test:1:unknown-agent`,
          agentId: "unknown-agent",
          sequence: 1,
          actionKind: "read_analyze",
          actionType: "analyze_request",
          toolName: "get_company_overview",
          resource: `request:${request.id}`,
          input: { requestId: request.id },
          requiresApproval: false,
          reason: "Unknown agent validation test."
        }
      ],
      metadata: { test: true }
    })
  });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: {
      message: "route this to an unknown agent"
    }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 400);
  assert.equal(body.error, "Request orchestration failed.");
  assert.equal(body.details.name, "PlannerContractError");
  assert.equal(body.details.code, "PLAN_INVALID");
});

test("POST /api/requests returns a blocked request when an agent is inactive", async (t) => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  await repository.upsertAgent({
    ...(await repository.getAgent("finance")),
    status: "disabled"
  });
  const app = buildApi({ repository, seedAgents: false });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: {
      message: "combien dois-je encaisser cette semaine"
    }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 201);
  assert.equal(body.request.status, "blocked");
  assert.equal(body.request.plans[0].steps[0].agentId, "finance");
  assert.equal(body.request.executions[0].status, "blocked");
  assert.ok(body.request.auditEvents.some((event) => event.type === "permission_denied"));
});

test("closing the API closes the repository", async () => {
  const repository = new InMemoryRepository();
  let disconnected = false;
  repository.disconnect = async () => {
    disconnected = true;
  };
  const app = buildApi({ repository });

  await app.close();

  assert.equal(disconnected, true);
});
