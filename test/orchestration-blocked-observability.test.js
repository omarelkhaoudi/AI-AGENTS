import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  createMvpAgentPermissions,
  orchestrateRequest,
  seedMvpAgents
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

const MESSAGE = "combien dois-je encaisser cette semaine";

// The drift that made the PostgreSQL Director execute one step out of thirteen:
// the agent keeps the orchestration permission, so the policy layer lets it
// through, and fails deeper on the tool business domain. Two layers of checks,
// and only the first one left a trace on the step.
async function orchestrateWithoutDomainScope() {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const orchestrationOnly = createMvpAgentPermissions("finance").filter(
    (permission) => permission.resource === "request:*" && permission.kind === "read_analyze"
  );
  await repository.upsertAgent({
    ...(await repository.getAgent("finance")),
    permissions: orchestrationOnly
  });
  const request = await repository.createRequest({ title: MESSAGE, payload: { question: MESSAGE } });
  return orchestrateRequest({ repository, requestId: request.id });
}

test("a step refused on a tool domain leaves a blocked execution behind", async () => {
  const result = await orchestrateWithoutDomainScope();

  assert.equal(result.status, "blocked");
  // One execution per planned step: a failure is recorded, not dropped.
  assert.equal(result.executions.length, result.plans[0].steps.length);
  assert.equal(result.executions.every((execution) => execution.status === "blocked"), true);
});

test("the blocked execution says why, in structured fields", async () => {
  const result = await orchestrateWithoutDomainScope();

  assert.deepEqual(
    result.executions.map((execution) => execution.error),
    [
      { code: "DOMAIN_NOT_ALLOWED", toolName: "get_pending_payments", missingDomains: ["payments"] },
      {
        code: "DOMAIN_NOT_ALLOWED",
        toolName: "get_receivables_summary",
        missingDomains: ["payments", "invoices"]
      }
    ]
  );
});

// error.message is free text and redact() masks by key name, not by content, so
// a message carrying a connection string or a token would reach the audit
// untouched. Only values the code itself defines are recorded.
test("no error message, stack or free text is recorded", async () => {
  const result = await orchestrateWithoutDomainScope();
  const serialised = JSON.stringify(result.executions);

  assert.equal(serialised.includes("Agent is not scoped"), false, "the raw message must not be stored");
  assert.equal(serialised.includes('"message"'), false);
  assert.equal(serialised.includes("stack"), false);

  for (const execution of result.executions) {
    assert.deepEqual(
      Object.keys(execution.error).sort(),
      ["code", "missingDomains", "toolName"],
      "only the allow listed fields are kept"
    );
  }
});

test("the failure is auditable step by step, not as a bare count", async () => {
  const result = await orchestrateWithoutDomainScope();
  const failed = result.auditEvents.filter((event) => event.type === "execution_failed");

  assert.equal(failed.length, 2);
  assert.equal(failed.every((event) => typeof event.planStepId === "string"), true, "each one names its step");
  assert.equal(failed.every((event) => typeof event.executionId === "string"), true);
  // The request summary now names the agent that stopped instead of an empty list.
  assert.deepEqual(result.result.summary.agents, ["finance"]);
  assert.equal(result.result.summary.blockedSteps, 2);
});

// A sensitive action is not a failure: it waits for a human, and the approval
// flow already records it. This commit must leave that path exactly as it was.
test("a sensitive request still records no blocked execution", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const request = await repository.createRequest({
    title: "effectue le paiement de cette facture",
    payload: { question: "effectue le paiement de cette facture" }
  });

  const result = await orchestrateRequest({ repository, requestId: request.id });

  assert.equal(result.status, "blocked");
  assert.equal(result.plans[0].steps.length, 1);
  assert.equal(result.executions.length, 0, "an approval must not become a failed execution");
  assert.equal(
    result.auditEvents.some((event) => event.type === "execution_failed"),
    false,
    "waiting for a human is not an execution failure"
  );
  assert.ok(result.auditEvents.some((event) => event.type === "approval_requested"));
});

// The orchestration policy layer already recorded its refusals. It must keep
// behaving identically: this commit adds the second layer, it does not move the
// first one.
test("a step refused by the orchestration policy is unchanged", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  await repository.upsertAgent({ ...(await repository.getAgent("finance")), permissions: [] });
  const request = await repository.createRequest({ title: MESSAGE, payload: { question: MESSAGE } });

  const result = await orchestrateRequest({ repository, requestId: request.id });

  assert.equal(result.status, "blocked");
  assert.equal(result.executions.every((execution) => execution.status === "blocked"), true);
  assert.ok(result.auditEvents.some((event) => event.type === "permission_denied"));
  // Its own error shape, written by the policy path, is untouched.
  assert.deepEqual(Object.keys(result.executions[0].error).sort(), ["decision", "reason"]);
});

test("a successful orchestration records no failure at all", async () => {
  const repository = new InMemoryRepository();
  await seedMvpAgents(repository);
  const request = await repository.createRequest({ title: MESSAGE, payload: { question: MESSAGE } });

  const result = await orchestrateRequest({ repository, requestId: request.id });

  assert.equal(result.status, "orchestrated");
  assert.equal(result.executions.every((execution) => execution.status === "completed"), true);
  assert.equal(result.auditEvents.some((event) => event.type === "execution_failed"), false);
  assert.equal(result.executions.every((execution) => execution.error === null), true);
});

// The cause belongs in the audit and on the execution, not in the API payload.
test("the Director response still exposes no audit metadata", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const response = await inject({
    method: "POST",
    url: "/api/director/requests",
    payload: { message: MESSAGE }
  });
  const body = JSON.parse(response.body);

  assert.ok(body.audit.length > 0);
  assert.equal(
    body.audit.some((event) => "metadata" in event),
    false,
    "audit metadata stays server side"
  );
});
