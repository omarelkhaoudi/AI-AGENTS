import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalStateError,
  InMemoryRepository,
  PrismaRepository,
  ToolExecutionService,
  ToolExecutionServiceError,
  ToolRegistry,
  createPermission,
  createPrismaClient,
  createToolDefinition,
  createToolInputSchema,
  hasValidDatabaseUrl
} from "../src/index.js";

// Deciding an approval and spending one both used to be a read, a decision and
// a write with an await in between. In memory that is atomic, because the read
// and the write happen in the same tick; under PostgreSQL it was not, and
// concurrent callers could all pass a check none of them had won. These tests
// only mean something against a real database, so they are skipped without one.
const skipReason =
  process.env.RUN_POSTGRES_INTEGRATION === "true" && hasValidDatabaseUrl(process.env.DATABASE_URL)
    ? false
    : "Set RUN_POSTGRES_INTEGRATION=true and DATABASE_URL to run PostgreSQL approval atomicity tests.";

const CONCURRENCY = 8;
const TOOL_ID = "execute_sensitive_action";

function sensitiveRegistry(calls = []) {
  const registry = new ToolRegistry();
  registry.register(createToolDefinition({
    id: TOOL_ID,
    name: "Execute Sensitive Action",
    description: "Mock sensitive action used to verify that an approval is spent exactly once.",
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

// Every test owns its own request and approver, and deletes both at the end.
// Approvals and executions cascade from the request, so nothing is left behind.
async function withHarness(run) {
  const prisma = await createPrismaClient();
  const repository = new PrismaRepository({ prisma });
  const request = await repository.createRequest({
    title: "approval atomicity",
    source: "test",
    status: "received",
    payload: {}
  });
  const approver = await repository.upsertUser({
    id: `approver-atomicity-${request.id}`,
    name: "Atomicity Approver",
    role: "leader",
    status: "active"
  });

  try {
    return await run({ prisma, repository, requestId: request.id, approverId: approver.id });
  } finally {
    await prisma.request.delete({ where: { id: request.id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: approver.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

// Each call is deferred to its own microtask, so the repository decides the
// interleaving rather than the order the array happened to be built in.
function concurrently(times, run) {
  return Promise.allSettled(
    Array.from({ length: times }, (_, index) => Promise.resolve().then(() => run(index)))
  );
}

function pendingApprovalInput(requestId, overrides = {}) {
  return {
    requestId,
    requestingAgent: "finance",
    requestedAction: TOOL_ID,
    reason: "Human approval is required before executing the sensitive tool.",
    affectedResource: `request:${requestId}`,
    risk: "high",
    status: "pending",
    metadata: { toolId: TOOL_ID, keepMe: true },
    ...overrides
  };
}

async function approvedApproval(repository, requestId, approverId, overrides = {}) {
  const approval = await repository.createApproval(pendingApprovalInput(requestId, overrides));
  if (overrides.status === undefined) {
    return repository.approveApproval(approval.id, { approverId });
  }
  return approval;
}

// ---------------------------------------------------------------------------
// markApprovalExecuted: spending an approval.
// ---------------------------------------------------------------------------

test("concurrent calls spend an approval exactly once", { skip: skipReason }, () => withHarness(async ({ prisma, repository, requestId, approverId }) => {
  const approval = await approvedApproval(repository, requestId, approverId);

  const results = await concurrently(CONCURRENCY, (index) =>
    repository.markApprovalExecuted(approval.id, { executionId: `exec-${index}` }));

  const winners = results.filter((result) => result.status === "fulfilled");
  const losers = results.filter((result) => result.status === "rejected");

  assert.equal(winners.length, 1, "exactly one caller may spend an approval");
  assert.equal(losers.length, CONCURRENCY - 1);
  for (const loser of losers) {
    assert.ok(loser.reason instanceof ApprovalStateError);
    assert.equal(loser.reason.code, "APPROVAL_ALREADY_EXECUTED");
    assert.equal(loser.reason.details.approvalId, approval.id);
  }

  // One winner is not enough on its own: the database must hold that winner id
  // and no other, or a later write silently overwrote the first.
  const stored = await prisma.approval.findUnique({ where: { id: approval.id } });
  assert.equal(stored.metadata.executionId, winners[0].value.metadata.executionId);
  assert.match(stored.metadata.executionId, /^exec-\d+$/);
  assert.equal(typeof stored.metadata.executedAt, "string");
  assert.equal(stored.metadata.toolId, TOOL_ID, "the existing metadata must survive the update");
}));

// The atomic statement returns the raw row rather than a Prisma mapped object.
// Callers must not be able to tell the difference.
test("a spent row is what the typed client would have returned", { skip: skipReason }, () => withHarness(async ({ prisma, repository, requestId, approverId }) => {
  const approval = await approvedApproval(repository, requestId, approverId);
  const returned = await repository.markApprovalExecuted(approval.id, { executionId: "exec-shape" });
  const typed = await prisma.approval.findUnique({ where: { id: approval.id } });

  assert.deepEqual(Object.keys(returned).sort(), Object.keys(typed).sort());
  for (const key of Object.keys(typed)) {
    assert.deepEqual(returned[key], typed[key], key);
  }
  assert.ok(returned.createdAt instanceof Date);
  assert.ok(returned.updatedAt instanceof Date);
  assert.equal(typeof returned.metadata, "object");
}));

test("the execution guards still answer with the codes they always did", { skip: skipReason }, () => withHarness(async ({ repository, requestId, approverId }) => {
  const pending = await approvedApproval(repository, requestId, approverId, { status: "pending" });
  await assert.rejects(
    () => repository.markApprovalExecuted(pending.id, { executionId: "exec-pending" }),
    (error) => {
      assert.ok(error instanceof ApprovalStateError);
      assert.equal(error.code, "APPROVAL_REQUIRED");
      return true;
    }
  );

  const rejected = await approvedApproval(repository, requestId, approverId, { status: "rejected" });
  await assert.rejects(
    () => repository.markApprovalExecuted(rejected.id, { executionId: "exec-rejected" }),
    (error) => error.code === "APPROVAL_REJECTED"
  );

  await assert.rejects(
    () => repository.markApprovalExecuted("00000000-0000-0000-0000-000000000000", { executionId: "exec-missing" }),
    (error) => error.code === "APPROVAL_NOT_FOUND"
  );
}));

// The guarantee that matters to a caller: one human decision, one real call.
// This is the shape the delay alert runs in, with the tool counting its calls.
test("concurrent executions of one approval call the tool exactly once", { skip: skipReason }, () => withHarness(async ({ prisma, repository, requestId, approverId }) => {
  const approval = await approvedApproval(repository, requestId, approverId);
  const calls = [];
  const service = new ToolExecutionService({ repository, toolRegistry: sensitiveRegistry(calls) });
  const input = {
    agentId: "finance",
    agentPermissions: [createPermission({ kind: "execute_action", resource: "request:*" })],
    toolId: TOOL_ID,
    input: { requestId },
    requestId,
    approvalId: approval.id
  };

  const results = await concurrently(CONCURRENCY, () => service.execute(input));
  const completed = results.filter((result) => result.status === "fulfilled");

  assert.equal(completed.length, 1, "only one execution may go through");
  assert.equal(calls.length, 1, "the tool must run exactly once for one approval");
  for (const loser of results.filter((result) => result.status === "rejected")) {
    assert.ok(loser.reason instanceof ToolExecutionServiceError);
    assert.equal(loser.reason.code, "APPROVAL_ALREADY_EXECUTED");
  }

  // The losers still leave a failed execution row each: the row is created
  // before the approval is spent, and a refusal is recorded rather than hidden.
  const executions = await prisma.execution.findMany({ where: { requestId } });
  assert.equal(executions.filter((execution) => execution.status === "completed").length, 1);
  assert.equal(executions.filter((execution) => execution.status === "failed").length, CONCURRENCY - 1);
}));

// ---------------------------------------------------------------------------
// approveApproval: the same read-then-write shape, one layer earlier.
// ---------------------------------------------------------------------------

test("concurrent decisions approve an approval exactly once", { skip: skipReason }, () => withHarness(async ({ prisma, repository, requestId, approverId }) => {
  const approval = await repository.createApproval(pendingApprovalInput(requestId));

  const results = await concurrently(CONCURRENCY, (index) =>
    repository.approveApproval(approval.id, { approverId, decisionReason: `decision-${index}` }));

  const winners = results.filter((result) => result.status === "fulfilled");
  const losers = results.filter((result) => result.status === "rejected");

  assert.equal(winners.length, 1, "exactly one decision may be recorded");
  assert.equal(losers.length, CONCURRENCY - 1);
  for (const loser of losers) {
    assert.ok(loser.reason instanceof ApprovalStateError);
    assert.equal(loser.reason.code, "APPROVAL_ALREADY_APPROVED");
  }

  // One winner is not enough: the stored decision has to be the winning one,
  // not whichever call happened to write last.
  const stored = await prisma.approval.findUnique({ where: { id: approval.id } });
  assert.equal(stored.status, "approved");
  assert.equal(stored.decisionReason, winners[0].value.decisionReason);
  assert.match(stored.decisionReason, /^decision-\d+$/);
  assert.equal(stored.approverId, approverId);
  assert.ok(stored.decidedAt instanceof Date);
  assert.equal(stored.metadata.keepMe, true, "the existing metadata must survive the decision");
}));

test("an approved row is what the typed client would have returned", { skip: skipReason }, () => withHarness(async ({ prisma, repository, requestId, approverId }) => {
  const approval = await repository.createApproval(pendingApprovalInput(requestId));
  const returned = await repository.approveApproval(approval.id, {
    approverId,
    decisionReason: "shape",
    metadata: { addedByDecision: true }
  });
  const typed = await prisma.approval.findUnique({ where: { id: approval.id } });

  assert.deepEqual(Object.keys(returned).sort(), Object.keys(typed).sort());
  for (const key of Object.keys(typed)) {
    assert.deepEqual(returned[key], typed[key], key);
  }
  // jsonb || jsonb must merge exactly as the object spread it replaces did.
  assert.deepEqual(returned.metadata, { toolId: TOOL_ID, keepMe: true, addedByDecision: true });
}));

test("the decision guards still answer with the codes they always did", { skip: skipReason }, () => withHarness(async ({ repository, requestId, approverId }) => {
  const decided = await repository.createApproval(pendingApprovalInput(requestId));
  await repository.approveApproval(decided.id, { approverId });
  await assert.rejects(
    () => repository.approveApproval(decided.id, { approverId }),
    (error) => {
      assert.ok(error instanceof ApprovalStateError);
      assert.equal(error.code, "APPROVAL_ALREADY_APPROVED");
      return true;
    }
  );

  const rejected = await repository.createApproval(pendingApprovalInput(requestId, { status: "rejected" }));
  await assert.rejects(
    () => repository.approveApproval(rejected.id, { approverId }),
    (error) => error.code === "APPROVAL_ALREADY_REJECTED"
  );

  // Any status outside pending and requested has always been refused. Matching
  // on "not approved and not rejected" would have started accepting this one.
  const processed = await repository.createApproval(pendingApprovalInput(requestId, { status: "cancelled" }));
  await assert.rejects(
    () => repository.approveApproval(processed.id, { approverId }),
    (error) => error.code === "APPROVAL_ALREADY_PROCESSED"
  );

  await assert.rejects(
    () => repository.approveApproval("00000000-0000-0000-0000-000000000000", { approverId }),
    (error) => error.code === "APPROVAL_NOT_FOUND"
  );
}));

// The two repositories reach the same guarantee by different means: PostgreSQL
// through a conditional statement, memory because its read and its write share
// a tick. This states that the guarantee itself does not diverge. It needs no
// database, so it runs everywhere.
test("both repositories refuse a concurrent second decision the same way", async () => {
  const repository = new InMemoryRepository();
  const request = await repository.createRequest({ title: "parity", source: "test", status: "received" });
  const approval = await repository.createApproval(pendingApprovalInput(request.id));

  const results = await concurrently(CONCURRENCY, (index) =>
    repository.approveApproval(approval.id, { approverId: null, decisionReason: `decision-${index}` }));

  const winners = results.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  for (const loser of results.filter((result) => result.status === "rejected")) {
    assert.equal(loser.reason.code, "APPROVAL_ALREADY_APPROVED");
  }

  const stored = await repository.getApproval(approval.id);
  assert.equal(stored.status, "approved");
  assert.equal(stored.decisionReason, winners[0].value.decisionReason);
  assert.equal(stored.metadata.keepMe, true);
});

// ---------------------------------------------------------------------------
// rejectApproval: the mirror, and the reason the mirror matters.
// ---------------------------------------------------------------------------

test("concurrent decisions reject an approval exactly once", { skip: skipReason }, () => withHarness(async ({ prisma, repository, requestId, approverId }) => {
  const approval = await repository.createApproval(pendingApprovalInput(requestId));

  const results = await concurrently(CONCURRENCY, (index) =>
    repository.rejectApproval(approval.id, { approverId, decisionReason: `refusal-${index}` }));

  const winners = results.filter((result) => result.status === "fulfilled");
  const losers = results.filter((result) => result.status === "rejected");

  assert.equal(winners.length, 1, "exactly one refusal may be recorded");
  assert.equal(losers.length, CONCURRENCY - 1);
  for (const loser of losers) {
    assert.ok(loser.reason instanceof ApprovalStateError);
    assert.equal(loser.reason.code, "APPROVAL_ALREADY_REJECTED");
  }

  const stored = await prisma.approval.findUnique({ where: { id: approval.id } });
  assert.equal(stored.status, "rejected");
  assert.equal(stored.decisionReason, winners[0].value.decisionReason);
  assert.match(stored.decisionReason, /^refusal-\d+$/);
  assert.equal(stored.approverId, approverId);
  assert.ok(stored.decidedAt instanceof Date);
  assert.equal(stored.metadata.keepMe, true, "the existing metadata must survive the refusal");
}));

test("a rejected row is what the typed client would have returned", { skip: skipReason }, () => withHarness(async ({ prisma, repository, requestId, approverId }) => {
  const approval = await repository.createApproval(pendingApprovalInput(requestId));
  const returned = await repository.rejectApproval(approval.id, {
    approverId,
    decisionReason: "shape",
    metadata: { addedByDecision: true }
  });
  const typed = await prisma.approval.findUnique({ where: { id: approval.id } });

  assert.deepEqual(Object.keys(returned).sort(), Object.keys(typed).sort());
  for (const key of Object.keys(typed)) {
    assert.deepEqual(returned[key], typed[key], key);
  }
  assert.deepEqual(returned.metadata, { toolId: TOOL_ID, keepMe: true, addedByDecision: true });
}));

test("the refusal guards still answer with the codes they always did", { skip: skipReason }, () => withHarness(async ({ repository, requestId, approverId }) => {
  const decided = await repository.createApproval(pendingApprovalInput(requestId));
  await repository.rejectApproval(decided.id, { approverId });
  await assert.rejects(
    () => repository.rejectApproval(decided.id, { approverId }),
    (error) => {
      assert.ok(error instanceof ApprovalStateError);
      assert.equal(error.code, "APPROVAL_ALREADY_REJECTED");
      return true;
    }
  );

  const approved = await repository.createApproval(pendingApprovalInput(requestId));
  await repository.approveApproval(approved.id, { approverId });
  await assert.rejects(
    () => repository.rejectApproval(approved.id, { approverId }),
    (error) => error.code === "APPROVAL_ALREADY_APPROVED"
  );

  const processed = await repository.createApproval(pendingApprovalInput(requestId, { status: "cancelled" }));
  await assert.rejects(
    () => repository.rejectApproval(processed.id, { approverId }),
    (error) => error.code === "APPROVAL_ALREADY_PROCESSED"
  );

  await assert.rejects(
    () => repository.rejectApproval("00000000-0000-0000-0000-000000000000", { approverId }),
    (error) => error.code === "APPROVAL_NOT_FOUND"
  );
}));

// The case the two conditional statements exist for. Approvals and refusals race
// against each other, not only against their own kind: one decision must win,
// and every loser must be told which decision beat it.
test("mixed concurrent decisions leave exactly one outcome", { skip: skipReason }, () => withHarness(async ({ prisma, repository, requestId, approverId }) => {
  const approval = await repository.createApproval(pendingApprovalInput(requestId));

  const results = await concurrently(CONCURRENCY, (index) =>
    (index % 2 === 0
      ? repository.approveApproval(approval.id, { approverId, decisionReason: `approve-${index}` })
      : repository.rejectApproval(approval.id, { approverId, decisionReason: `reject-${index}` })));

  const winners = results.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1, "an approval and a refusal cannot both win");

  const stored = await prisma.approval.findUnique({ where: { id: approval.id } });
  assert.ok(["approved", "rejected"].includes(stored.status), stored.status);
  assert.equal(stored.status, winners[0].value.status);
  assert.equal(stored.decisionReason, winners[0].value.decisionReason);

  // Every loser is told the decision that actually landed, whichever kind of
  // call it was: the code comes from the stored status, not from the operation.
  const expected = stored.status === "approved" ? "APPROVAL_ALREADY_APPROVED" : "APPROVAL_ALREADY_REJECTED";
  for (const loser of results.filter((result) => result.status === "rejected")) {
    assert.equal(loser.reason.code, expected);
  }

  assert.equal(stored.metadata.keepMe, true);
  assert.equal(stored.metadata.toolId, TOOL_ID);
}));

test("both repositories refuse a concurrent second refusal the same way", async () => {
  const repository = new InMemoryRepository();
  const request = await repository.createRequest({ title: "parity", source: "test", status: "received" });
  const approval = await repository.createApproval(pendingApprovalInput(request.id));

  const results = await concurrently(CONCURRENCY, (index) =>
    repository.rejectApproval(approval.id, { approverId: null, decisionReason: `refusal-${index}` }));

  const winners = results.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  for (const loser of results.filter((result) => result.status === "rejected")) {
    assert.equal(loser.reason.code, "APPROVAL_ALREADY_REJECTED");
  }

  const stored = await repository.getApproval(approval.id);
  assert.equal(stored.status, "rejected");
  assert.equal(stored.decisionReason, winners[0].value.decisionReason);
});

test("both repositories settle a mixed race on a single outcome", async () => {
  const repository = new InMemoryRepository();
  const request = await repository.createRequest({ title: "parity-mixed", source: "test", status: "received" });
  const approval = await repository.createApproval(pendingApprovalInput(request.id));

  const results = await concurrently(CONCURRENCY, (index) =>
    (index % 2 === 0
      ? repository.approveApproval(approval.id, { approverId: null, decisionReason: `approve-${index}` })
      : repository.rejectApproval(approval.id, { approverId: null, decisionReason: `reject-${index}` })));

  const winners = results.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);

  const stored = await repository.getApproval(approval.id);
  assert.equal(stored.status, winners[0].value.status);
  assert.equal(stored.decisionReason, winners[0].value.decisionReason);
});
