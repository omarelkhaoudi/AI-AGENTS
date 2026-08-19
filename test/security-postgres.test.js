import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalStateError,
  AuthenticationError,
  PrismaRepository,
  approveApprovalRequest,
  authenticatePrincipal,
  buildApi,
  createApiTokenMaterial,
  createApprovalRequest,
  createPrismaClient,
  hasValidDatabaseUrl,
  hashApiTokenSecret
} from "../src/index.js";

const postgresIntegrationEnabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const postgresUrlAvailable = hasValidDatabaseUrl(process.env.DATABASE_URL);
const skipReason =
  postgresIntegrationEnabled && postgresUrlAvailable
    ? false
    : "Set RUN_POSTGRES_INTEGRATION=true and DATABASE_URL to run PostgreSQL security tests.";

const TEST_USER_ID = "pg-security-leader";

test("PostgreSQL stores only the API token hash and authenticates from it", {
  skip: skipReason
}, async () => {
  const prisma = await createPrismaClient();
  const repository = new PrismaRepository({ prisma });

  try {
    const user = await repository.upsertUser({
      id: TEST_USER_ID,
      name: "PG Security Leader",
      role: "leader",
      status: "active"
    });
    const material = createApiTokenMaterial({ userId: user.id, name: "pg-security" });
    const stored = await repository.createApiToken(material.record);

    assert.equal(stored.tokenHash, hashApiTokenSecret(material.secret));
    assert.equal(JSON.stringify(stored).includes(material.secret), false);

    const principal = await authenticatePrincipal({
      repository,
      authorizationHeader: `Bearer ${material.secret}`
    });
    assert.equal(principal.userId, user.id);
    assert.equal(principal.role, "leader");

    await repository.revokeApiToken(stored.id);
    await assert.rejects(
      () => authenticatePrincipal({ repository, authorizationHeader: `Bearer ${material.secret}` }),
      (error) => error instanceof AuthenticationError && error.code === "INVALID_CREDENTIALS"
    );
  } finally {
    await prisma.apiToken.deleteMany({ where: { userId: TEST_USER_ID } });
    await prisma.user.deleteMany({ where: { id: TEST_USER_ID } });
    await repository.disconnect();
  }
});

test("PostgreSQL refuses an approval decision from an approver that is not a stored user", {
  skip: skipReason
}, async () => {
  const prisma = await createPrismaClient();
  const repository = new PrismaRepository({ prisma });
  let approvalId = null;

  try {
    const approval = await repository.createApproval(createApprovalRequest({
      requestingAgent: "finance",
      requestedAction: "execute_invoice_payment",
      reason: "PostgreSQL approver integrity check.",
      affectedResource: "request:pg-security",
      risk: "high",
      status: "pending"
    }));
    approvalId = approval.id;

    await assert.rejects(
      () => approveApprovalRequest({ repository, approvalId, approverId: "pg-ghost-approver" }),
      (error) => error instanceof ApprovalStateError && error.code === "APPROVER_UNKNOWN"
    );

    await assert.rejects(
      () => approveApprovalRequest({ repository, approvalId }),
      (error) => error instanceof ApprovalStateError && error.code === "APPROVER_REQUIRED"
    );

    const untouched = await repository.getApproval(approvalId);
    assert.equal(untouched.status, "pending");
    assert.equal(untouched.approverId, null);
  } finally {
    if (approvalId) {
      await prisma.approval.deleteMany({ where: { id: approvalId } });
    }
    await repository.disconnect();
  }
});

test("PostgreSQL API refuses anonymous callers on sensitive routes", {
  skip: skipReason
}, async (t) => {
  const prisma = await createPrismaClient();
  const repository = new PrismaRepository({ prisma });
  const app = buildApi({ repository, seedAgents: false });
  t.after(async () => {
    await app.close();
  });

  assert.equal((await app.inject({ method: "GET", url: "/api/approvals" })).statusCode, 401);
  assert.equal((await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: { message: "point" }
  })).statusCode, 401);
});
