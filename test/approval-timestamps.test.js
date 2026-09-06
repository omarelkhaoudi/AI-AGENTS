import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  PrismaRepository,
  createPrismaClient,
  hasValidDatabaseUrl
} from "../src/index.js";

// The atomic approval statements wrote their timestamps with a bare NOW().
// NOW() is a timestamptz; assigned to decidedAt and updatedAt, which are
// TIMESTAMP(3) with no time zone, PostgreSQL casts it through the SESSION time
// zone. On a session in Africa/Casablanca the local wall clock was stored and
// read back as if it were UTC, so every approval decided after that change
// carried a decidedAt one hour in the future while the audit trail, timestamped
// in JavaScript, stayed correct.
const skipReason =
  process.env.RUN_POSTGRES_INTEGRATION === "true" && hasValidDatabaseUrl(process.env.DATABASE_URL)
    ? false
    : "Set RUN_POSTGRES_INTEGRATION=true and DATABASE_URL to run PostgreSQL timestamp tests.";

// Generous enough that a slow machine never fails, far tighter than any real
// time zone offset. The smallest offset in use anywhere is fifteen minutes.
const TOLERANCE_MS = 60_000;
const TOOL_ID = "execute_sensitive_action";

function skew(value) {
  return Math.abs(new Date(value).getTime() - Date.now());
}

async function withHarness(run) {
  const prisma = await createPrismaClient();
  const repository = new PrismaRepository({ prisma });
  const request = await repository.createRequest({
    title: "approval timestamps",
    source: "test",
    status: "received",
    payload: {}
  });
  const approver = await repository.upsertUser({
    id: `approver-timestamps-${request.id}`,
    name: "Timestamp Approver",
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

function pendingApproval(requestId) {
  return {
    requestId,
    requestingAgent: "finance",
    requestedAction: TOOL_ID,
    reason: "Human approval is required before executing the sensitive tool.",
    affectedResource: `request:${requestId}`,
    risk: "high",
    status: "pending",
    metadata: { toolId: TOOL_ID }
  };
}

test("approving writes decidedAt and updatedAt in UTC", { skip: skipReason }, () => withHarness(async ({ prisma, repository, requestId, approverId }) => {
  const approval = await repository.createApproval(pendingApproval(requestId));
  const returned = await repository.approveApproval(approval.id, { approverId });
  const stored = await prisma.approval.findUnique({ where: { id: approval.id } });

  assert.ok(
    skew(stored.decidedAt) < TOLERANCE_MS,
    `decidedAt is ${Math.round(skew(stored.decidedAt) / 60000)} minutes away from now: a time zone offset leaked in`
  );
  assert.ok(skew(stored.updatedAt) < TOLERANCE_MS, "updatedAt carries a time zone offset");
  // What the statement returns and what the row holds must agree.
  assert.equal(returned.decidedAt.getTime(), stored.decidedAt.getTime());
}));

test("rejecting writes decidedAt and updatedAt in UTC", { skip: skipReason }, () => withHarness(async ({ prisma, repository, requestId, approverId }) => {
  const approval = await repository.createApproval(pendingApproval(requestId));
  await repository.rejectApproval(approval.id, { approverId });
  const stored = await prisma.approval.findUnique({ where: { id: approval.id } });

  assert.ok(skew(stored.decidedAt) < TOLERANCE_MS, "decidedAt carries a time zone offset");
  assert.ok(skew(stored.updatedAt) < TOLERANCE_MS, "updatedAt carries a time zone offset");
}));

// The audit trail is timestamped in JavaScript and was always right. It is the
// reference the stored columns are measured against, because that mismatch is
// exactly how the defect surfaced.
test("spending an approval agrees with the clock the audit trail uses", { skip: skipReason }, () => withHarness(async ({ prisma, repository, requestId, approverId }) => {
  const approval = await repository.createApproval(pendingApproval(requestId));
  await repository.approveApproval(approval.id, { approverId });

  const before = new Date().toISOString();
  const spent = await repository.markApprovalExecuted(approval.id, { executionId: "exec-timestamps" });
  const after = new Date().toISOString();
  const stored = await prisma.approval.findUnique({ where: { id: approval.id } });

  assert.ok(skew(stored.updatedAt) < TOLERANCE_MS, "updatedAt carries a time zone offset");

  // executedAt is a JavaScript ISO string and was never affected: it is the
  // control. The column must sit in the same window.
  assert.ok(stored.metadata.executedAt >= before && stored.metadata.executedAt <= after);
  const columnGap = Math.abs(new Date(stored.updatedAt).getTime() - new Date(stored.metadata.executedAt).getTime());
  assert.ok(
    columnGap < TOLERANCE_MS,
    `updatedAt and executedAt are ${Math.round(columnGap / 60000)} minutes apart: the column went through a different clock`
  );
  assert.equal(spent.updatedAt.getTime(), stored.updatedAt.getTime());
}));

// The behavioural tests above only fail where the session time zone is not UTC,
// so on a UTC machine a bare NOW() would slip through unnoticed. This one holds
// everywhere and needs no database.
test("no raw statement writes a timestamp with a bare NOW()", async () => {
  const source = await readFile("src/persistence/prisma-repository.js", "utf8");
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("//"));

  const assignments = code.filter((line) => /"(decidedAt|updatedAt|createdAt)"\s*=/.test(line));
  assert.ok(assignments.length > 0, "the raw statements must still assign timestamps");

  for (const line of assignments) {
    assert.match(
      line,
      /NOW\(\) AT TIME ZONE 'UTC'/,
      `a timestamp is assigned without an explicit UTC conversion: ${line.trim()}`
    );
  }
});
