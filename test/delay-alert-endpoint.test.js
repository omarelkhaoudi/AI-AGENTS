import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  createMvpToolRegistry,
  createN8nClientFromConfig,
  loadFoundationConfig
} from "../src/index.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

// No network. The client is a stub that records the events it is handed, so a
// refusal can be proved to have refused before anything left the process.
const ORDER_ID = "order-atlas-001";
const DELAY_RISK = "high";

function stubClient() {
  const calls = [];
  return {
    calls,
    postWorkflowEvent: async (event) => {
      calls.push(event);
      return { httpStatus: 200, body: { status: "received" }, durationMs: 3 };
    }
  };
}

// A configuration that says the bridge is on, without any real endpoint behind
// it: the registry below is built from the stub, never from this.
function enabledConfig() {
  return loadFoundationConfig({
    NODE_ENV: "test",
    WORKFLOW_PROVIDER: "n8n",
    WORKFLOW_ENABLED: "true",
    WORKFLOW_BASE_URL: "https://n8n.example.test",
    N8N_WEBHOOK_PATH: "delay-alert",
    N8N_API_KEY_HEADER: "X-AI-Agents-Token",
    N8N_API_KEY: "token-de-test-jamais-committe"
  });
}

async function bridgeOn({ role = "leader" } = {}) {
  const repository = new InMemoryRepository();
  const client = stubClient();
  const api = await buildAuthenticatedApi({
    repository,
    role,
    config: enabledConfig(),
    toolRegistry: createMvpToolRegistry({ repository, workflowClient: client })
  });
  return { ...api, repository, client };
}

async function bridgeOff() {
  const repository = new InMemoryRepository();
  const api = await buildAuthenticatedApi({ repository });
  return { ...api, repository };
}

function raise(inject, body = { orderId: ORDER_ID, delayRisk: DELAY_RISK }) {
  return inject({ method: "POST", url: "/api/production/delay-alerts", payload: body });
}

test("with the bridge off the endpoint refuses and nothing is registered", async (t) => {
  const { app, inject, repository } = await bridgeOff();
  t.after(() => app.close());

  const response = await raise(inject);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 409);
  assert.equal(body.details.code, "WORKFLOW_NOT_ENABLED");
  assert.equal(createMvpToolRegistry({ repository }).list().length, 21);
  assert.equal((await repository.listExecutions()).length, 0);
  assert.equal((await repository.listApprovals()).length, 0);
});

// The offline default must survive a client being available in the process.
test("no client is built while the boundary is disabled", () => {
  assert.equal(createN8nClientFromConfig(loadFoundationConfig({ NODE_ENV: "test" })), null);
  assert.equal(
    createN8nClientFromConfig(loadFoundationConfig({ NODE_ENV: "test", WORKFLOW_PROVIDER: "mock" })),
    null
  );

  const client = createN8nClientFromConfig(enabledConfig(), { N8N_API_KEY: "token-de-test" });
  assert.deepEqual(Object.keys(client), ["postWorkflowEvent"]);
});

// The token must not be reachable from the configuration object, whatever the
// caller does with it.
test("the configuration never carries the token", () => {
  const config = enabledConfig();

  assert.equal(config.n8n.hasApiKey, true);
  assert.equal("apiKey" in config.n8n, false);
  assert.equal(JSON.stringify(config).includes("token-de-test-jamais-committe"), false);
});

test("raising an alert opens an approval and sends nothing", async (t) => {
  const { app, inject, repository, client } = await bridgeOn();
  t.after(() => app.close());

  const response = await raise(inject);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 202);
  assert.equal(body.status, "approval_required");
  assert.equal(body.approval.requestedAction, "notify_delay_alert");
  assert.equal(body.approval.status, "pending");
  assert.equal(body.approval.risk, "high");
  assert.equal(client.calls.length, 0, "nothing may be sent before a human decides");

  const audit = await repository.listAuditEvents({ requestId: body.request.id });
  assert.ok(audit.some((event) => event.type === "approval_requested"));
  assert.equal(audit.some((event) => event.type === "tool_completed"), false);
});

test("approving the alert sends it once, correlated to its execution", async (t) => {
  const { app, inject, client } = await bridgeOn();
  t.after(() => app.close());

  const raised = JSON.parse((await raise(inject)).body);
  const response = await inject({
    method: "POST",
    url: `/api/approvals/${raised.approval.id}/approve`,
    payload: { decisionReason: "Confirmed with the workshop." }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.approval.status, "approved");
  assert.equal(body.execution.status, "completed");
  assert.equal(client.calls.length, 1);

  const [event] = client.calls;
  assert.equal(event.type, "delay_alert");
  assert.equal(event.agentId, "production");
  assert.equal(event.payload.orderId, ORDER_ID);
  assert.equal(event.payload.delayRisk, DELAY_RISK);
  assert.equal(event.correlationId, body.execution.execution.id);
  assert.equal(body.execution.output.result.provider, "n8n");
  assert.equal(body.execution.output.result.httpStatus, 200);
});

test("rejecting the alert sends nothing", async (t) => {
  const { app, inject, client } = await bridgeOn();
  t.after(() => app.close());

  const raised = JSON.parse((await raise(inject)).body);
  const response = await inject({
    method: "POST",
    url: `/api/approvals/${raised.approval.id}/reject`,
    payload: { decisionReason: "Customer already warned." }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).approval.status, "rejected");
  assert.equal(client.calls.length, 0);
});

test("an approval cannot be replayed to send a second alert", async (t) => {
  const { app, inject, client } = await bridgeOn();
  t.after(() => app.close());

  const raised = JSON.parse((await raise(inject)).body);
  const url = `/api/approvals/${raised.approval.id}/approve`;

  assert.equal((await inject({ method: "POST", url, payload: {} })).statusCode, 200);
  const replay = await inject({ method: "POST", url, payload: {} });

  assert.equal(replay.statusCode, 409);
  assert.equal(client.calls.length, 1, "a replayed approval must not send a second alert");
});

test("only a role allowed to decide can send the alert", async (t) => {
  const { app, inject, repository, client } = await bridgeOn();
  t.after(() => app.close());

  const raised = JSON.parse((await raise(inject)).body);
  const operator = await createAuthenticatedUser(repository, { id: "test-operator", role: "operator" });

  const response = await app.inject({
    method: "POST",
    url: `/api/approvals/${raised.approval.id}/approve`,
    headers: operator.headers,
    payload: {}
  });

  assert.equal(response.statusCode, 403);
  assert.equal(client.calls.length, 0);
});

test("an incomplete alert is refused before anything is written", async (t) => {
  const { app, inject, repository, client } = await bridgeOn();
  t.after(() => app.close());

  for (const payload of [
    {},
    { orderId: ORDER_ID },
    { delayRisk: DELAY_RISK },
    { orderId: "   ", delayRisk: DELAY_RISK },
    { orderId: ORDER_ID, delayRisk: "", createdById: "someone-else" }
  ]) {
    const response = await raise(inject, payload);
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }

  assert.equal(client.calls.length, 0);
  assert.equal((await repository.listApprovals()).length, 0);
  assert.equal((await repository.listExecutions()).length, 0);
});

// The endpoint is the only way in. No planner may produce this step, whether the
// outbound tool is registered or not.
test("no planner can reach the alert, even with the bridge on", async (t) => {
  const { app, inject, client } = await bridgeOn();
  t.after(() => app.close());

  for (const message of [
    "Alerte retard sur la commande atlas, previens le client.",
    "Fais le point complet sur l entreprise.",
    "Quels sont les retards de production ?"
  ]) {
    const response = await inject({
      method: "POST",
      url: "/api/director/requests",
      payload: { message }
    });
    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, 201, message);
    assert.equal(body.results.some((result) => result.tool === "notify_delay_alert"), false, message);
  }

  assert.equal(client.calls.length, 0, "an ordinary request must never send an alert");
});
