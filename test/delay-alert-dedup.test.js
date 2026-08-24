import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  InMemoryRepository,
  PrismaRepository,
  REQUEST_IDEMPOTENCY_INDEX,
  createMvpToolRegistry,
  createPrismaClient,
  derivedDelayAlertKey,
  hasValidDatabaseUrl,
  loadFoundationConfig
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// One business event is one request. The guarantee is held by a unique index,
// so it only means something against a real database; the memory repository
// holds the same guarantee by its own means and is tested for parity here.
//
// Nothing reaches the network. The workflow client is a stub that counts the
// events handed to it, so "no second alert" is an assertion, not a hope.
const skipReason =
  process.env.RUN_POSTGRES_INTEGRATION === "true" && hasValidDatabaseUrl(process.env.DATABASE_URL)
    ? false
    : "Set RUN_POSTGRES_INTEGRATION=true and DATABASE_URL to run PostgreSQL deduplication tests.";

const CONCURRENCY = 8;
const DELAY_RISK = "high";
// A fixed instant, so a test never depends on the day it runs, and a second
// instant on the next UTC day.
const DAY_ONE = new Date("2026-08-24T09:15:00.000Z");
const DAY_TWO = new Date("2026-08-25T09:15:00.000Z");

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

function enabledConfig() {
  return loadFoundationConfig({
    NODE_ENV: "test",
    AUTH_MODE: "token",
    WORKFLOW_PROVIDER: "n8n",
    WORKFLOW_ENABLED: "true",
    WORKFLOW_BASE_URL: "https://n8n.example.test",
    N8N_WEBHOOK_PATH: "delay-alert",
    N8N_API_KEY_HEADER: "X-AI-Agents-Token",
    N8N_API_KEY: "token-de-test-jamais-committe"
  });
}

async function buildAlertApi({ repository, client, now = DAY_ONE, userId = "test-leader" }) {
  return buildAuthenticatedApi({
    repository,
    userId,
    config: enabledConfig(),
    toolRegistry: createMvpToolRegistry({ repository, workflowClient: client }),
    clock: () => now
  });
}

function raise(inject, orderId, delayRisk = DELAY_RISK) {
  return inject({
    method: "POST",
    url: "/api/production/delay-alerts",
    payload: { orderId, delayRisk }
  });
}

function body(response) {
  return JSON.parse(response.body);
}

// Each test owns an order id nobody else uses, so its keys cannot collide with
// another run, and deleting by key prefix cleans up plans, steps, approvals,
// executions and audit rows through the existing cascades.
async function withPostgres(run) {
  const prisma = await createPrismaClient();
  const repository = new PrismaRepository({ prisma });
  const orderId = `order-dedup-${randomUUID()}`;

  try {
    return await run({ prisma, repository, orderId });
  } finally {
    await prisma.request
      .deleteMany({ where: { idempotencyKey: { startsWith: `delay_alert:${orderId}` } } })
      .catch(() => undefined);
    await prisma.$disconnect();
  }
}

function concurrently(times, run) {
  return Promise.allSettled(
    Array.from({ length: times }, (_, index) => Promise.resolve().then(() => run(index)))
  );
}

// ---------------------------------------------------------------------------
// The key itself
// ---------------------------------------------------------------------------

test("the derived key is the business event, expressed in UTC days", () => {
  assert.equal(
    derivedDelayAlertKey({ orderId: "order-atlas-001", delayRisk: "high", now: DAY_ONE }),
    "delay_alert:order-atlas-001:high:2026-08-24"
  );

  // A risk that moves is a different event.
  assert.notEqual(
    derivedDelayAlertKey({ orderId: "order-atlas-001", delayRisk: "critical", now: DAY_ONE }),
    derivedDelayAlertKey({ orderId: "order-atlas-001", delayRisk: "high", now: DAY_ONE })
  );

  // A new day is a different event.
  assert.notEqual(
    derivedDelayAlertKey({ orderId: "order-atlas-001", delayRisk: "high", now: DAY_TWO }),
    derivedDelayAlertKey({ orderId: "order-atlas-001", delayRisk: "high", now: DAY_ONE })
  );

  // The day is the UTC day the rest of the application measures lateness
  // against. An instant late enough to be tomorrow locally must not become a
  // second event.
  assert.equal(
    derivedDelayAlertKey({ orderId: "o", delayRisk: "high", now: new Date("2026-08-24T23:59:59.999Z") }),
    derivedDelayAlertKey({ orderId: "o", delayRisk: "high", now: new Date("2026-08-24T00:00:00.000Z") })
  );
});

// ---------------------------------------------------------------------------
// Test 1 - concurrency
// ---------------------------------------------------------------------------

test("concurrent identical triggers create one request and one approval", { skip: skipReason }, () => withPostgres(async ({ prisma, repository, orderId }) => {
  const client = stubClient();
  const { app, inject } = await buildAlertApi({ repository, client });

  try {
    const responses = await concurrently(CONCURRENCY, () => raise(inject, orderId));
    const bodies = responses.map((result) => body(result.value));

    const accepted = bodies.filter((entry) => entry.status === "approval_required");
    const duplicates = bodies.filter((entry) => entry.status === "duplicate_skipped");

    assert.equal(accepted.length, 1, "exactly one trigger may open the event");
    assert.equal(duplicates.length, CONCURRENCY - 1);
    for (const duplicate of duplicates) {
      assert.equal(duplicate.duplicateOf, accepted[0].request.id);
      assert.equal(duplicate.idempotencyKey, `delay_alert:${orderId}:${DELAY_RISK}:2026-08-24`);
      assert.equal(duplicate.execution, null, "a duplicate must never claim an execution");
    }

    // The database is the real assertion: one of everything, and nothing sent.
    const requests = await prisma.request.findMany({
      where: { idempotencyKey: { startsWith: `delay_alert:${orderId}` } }
    });
    assert.equal(requests.length, 1);
    assert.equal(await prisma.plan.count({ where: { requestId: requests[0].id } }), 1);
    assert.equal(await prisma.planStep.count({ where: { plan: { requestId: requests[0].id } } }), 1);
    assert.equal(await prisma.approval.count({ where: { requestId: requests[0].id } }), 1);
    assert.equal(await prisma.execution.count({ where: { requestId: requests[0].id } }), 0);
    assert.equal(client.calls.length, 0, "nothing may be sent before a human decides");

    // The refusals are recorded against the original request, and no second
    // request was created to carry them.
    assert.equal(
      await prisma.auditEvent.count({
        where: { requestId: requests[0].id, type: "request_duplicate_skipped" }
      }),
      CONCURRENCY - 1
    );
  } finally {
    await app.close();
  }
}));

// ---------------------------------------------------------------------------
// Test 2 - one approval, one call, then replays
// ---------------------------------------------------------------------------

test("one approval sends one alert, and replays send none", { skip: skipReason }, () => withPostgres(async ({ prisma, repository, orderId }) => {
  const client = stubClient();
  const { app, inject } = await buildAlertApi({ repository, client });

  try {
    const raised = body(await raise(inject, orderId));
    const approved = await inject({
      method: "POST",
      url: `/api/approvals/${raised.approval.id}/approve`,
      payload: { decisionReason: "Confirmed with the workshop." }
    });

    assert.equal(approved.statusCode, 200);
    assert.equal(client.calls.length, 1);

    const replays = await concurrently(CONCURRENCY, () => raise(inject, orderId));
    for (const replay of replays) {
      assert.equal(replay.value.statusCode, 200);
      assert.equal(body(replay.value).status, "duplicate_skipped");
    }

    assert.equal(client.calls.length, 1, "a replay must never send a second alert");
    assert.equal(
      await prisma.approval.count({ where: { requestId: raised.request.id } }),
      1,
      "a replay must never open a second approval"
    );
    assert.equal(await prisma.execution.count({ where: { requestId: raised.request.id } }), 1);
  } finally {
    await app.close();
  }
}));

// ---------------------------------------------------------------------------
// Test 3 - a risk that moves is a new event
// ---------------------------------------------------------------------------

test("a different risk is a different event", { skip: skipReason }, () => withPostgres(async ({ prisma, repository, orderId }) => {
  const client = stubClient();
  const { app, inject } = await buildAlertApi({ repository, client });

  try {
    const high = body(await raise(inject, orderId, "high"));
    const critical = body(await raise(inject, orderId, "critical"));

    assert.equal(high.status, "approval_required");
    assert.equal(critical.status, "approval_required");
    assert.notEqual(high.request.id, critical.request.id);
    assert.notEqual(high.approval.id, critical.approval.id);

    const requests = await prisma.request.findMany({
      where: { idempotencyKey: { startsWith: `delay_alert:${orderId}` } }
    });
    assert.equal(requests.length, 2);
    assert.equal(client.calls.length, 0);
  } finally {
    await app.close();
  }
}));

// ---------------------------------------------------------------------------
// Test 4 - a new day is a new event
// ---------------------------------------------------------------------------

test("the same alert on a different day is a different event", { skip: skipReason }, () => withPostgres(async ({ prisma, repository, orderId }) => {
  const client = stubClient();
  // Two applications over one database, differing only in what day it is.
  const today = await buildAlertApi({ repository, client, now: DAY_ONE });
  const tomorrow = await buildAlertApi({ repository, client, now: DAY_TWO });

  try {
    const first = body(await raise(today.inject, orderId));
    const sameDay = body(await raise(today.inject, orderId));
    const nextDay = body(await raise(tomorrow.inject, orderId));

    assert.equal(first.status, "approval_required");
    assert.equal(sameDay.status, "duplicate_skipped");
    assert.equal(nextDay.status, "approval_required");
    assert.notEqual(nextDay.request.id, first.request.id);

    const requests = await prisma.request.findMany({
      where: { idempotencyKey: { startsWith: `delay_alert:${orderId}` } },
      orderBy: { idempotencyKey: "asc" }
    });
    assert.deepEqual(requests.map((entry) => entry.idempotencyKey), [
      `delay_alert:${orderId}:${DELAY_RISK}:2026-08-24`,
      `delay_alert:${orderId}:${DELAY_RISK}:2026-08-25`
    ]);
    assert.equal(client.calls.length, 0);
  } finally {
    await today.app.close();
    await tomorrow.app.close();
  }
}));

// ---------------------------------------------------------------------------
// Test 5 - a duplicate after execution
// ---------------------------------------------------------------------------

test("a duplicate after execution reports the terminal state and sends nothing", { skip: skipReason }, () => withPostgres(async ({ prisma, repository, orderId }) => {
  const client = stubClient();
  const { app, inject } = await buildAlertApi({ repository, client });

  try {
    const raised = body(await raise(inject, orderId));
    await inject({
      method: "POST",
      url: `/api/approvals/${raised.approval.id}/approve`,
      payload: {}
    });
    assert.equal(client.calls.length, 1);

    const replay = await raise(inject, orderId);
    const duplicate = body(replay);

    assert.equal(replay.statusCode, 200);
    assert.equal(duplicate.status, "duplicate_skipped");
    assert.equal(duplicate.duplicateOf, raised.request.id);
    assert.equal(duplicate.approval.id, raised.approval.id);
    assert.equal(duplicate.approval.status, "approved");
    // The execution it reports is the original one, not a new one.
    assert.equal(duplicate.execution.status, "completed");

    assert.equal(client.calls.length, 1);
    assert.equal(await prisma.approval.count({ where: { requestId: raised.request.id } }), 1);
    assert.equal(await prisma.execution.count({ where: { requestId: raised.request.id } }), 1);
  } finally {
    await app.close();
  }
}));

// ---------------------------------------------------------------------------
// Test 6 - a duplicate after a refusal
// ---------------------------------------------------------------------------

test("a human refusal is final for the key", { skip: skipReason }, () => withPostgres(async ({ prisma, repository, orderId }) => {
  const client = stubClient();
  const { app, inject } = await buildAlertApi({ repository, client });

  try {
    const raised = body(await raise(inject, orderId));
    await inject({
      method: "POST",
      url: `/api/approvals/${raised.approval.id}/reject`,
      payload: { decisionReason: "Customer already warned." }
    });

    const replay = await raise(inject, orderId);
    const duplicate = body(replay);

    assert.equal(replay.statusCode, 200);
    assert.equal(duplicate.status, "duplicate_skipped");
    assert.equal(duplicate.approval.id, raised.approval.id);
    assert.equal(duplicate.approval.status, "rejected");
    assert.equal(duplicate.execution, null);

    assert.equal(client.calls.length, 0, "a refused alert stays unsent");
    assert.equal(await prisma.approval.count({ where: { requestId: raised.request.id } }), 1);
    assert.equal(await prisma.execution.count({ where: { requestId: raised.request.id } }), 0);
  } finally {
    await app.close();
  }
}));

// ---------------------------------------------------------------------------
// Test 7 - parity
// ---------------------------------------------------------------------------

test("the memory repository gives the same guarantee", async () => {
  const repository = new InMemoryRepository();
  const client = stubClient();
  const orderId = "order-dedup-memory";
  const { app, inject } = await buildAlertApi({ repository, client });

  try {
    const responses = await concurrently(CONCURRENCY, () => raise(inject, orderId));
    const bodies = responses.map((result) => body(result.value));

    const accepted = bodies.filter((entry) => entry.status === "approval_required");
    const duplicates = bodies.filter((entry) => entry.status === "duplicate_skipped");

    assert.equal(accepted.length, 1);
    assert.equal(duplicates.length, CONCURRENCY - 1);
    for (const duplicate of duplicates) {
      assert.equal(duplicate.duplicateOf, accepted[0].request.id);
      assert.equal(duplicate.execution, null);
    }

    const stored = await repository.getRequest(accepted[0].request.id);
    assert.equal(stored.approvals.length, 1);
    assert.equal(stored.executions.length, 0);
    assert.equal(stored.plans.length, 1);
    assert.equal(client.calls.length, 0);

    // No request was created for a duplicate, in either repository.
    const audits = await repository.listAuditEvents({ requestId: accepted[0].request.id });
    assert.equal(audits.filter((entry) => entry.type === "request_duplicate_skipped").length, CONCURRENCY - 1);
    assert.equal(audits.filter((entry) => entry.type === "request_created").length, 1);
  } finally {
    await app.close();
  }
});

test("the memory repository refuses a replay after execution the same way", async () => {
  const repository = new InMemoryRepository();
  const client = stubClient();
  const orderId = "order-dedup-memory-executed";
  const { app, inject } = await buildAlertApi({ repository, client });

  try {
    const raised = body(await raise(inject, orderId));
    await inject({ method: "POST", url: `/api/approvals/${raised.approval.id}/approve`, payload: {} });
    assert.equal(client.calls.length, 1);

    const duplicate = body(await raise(inject, orderId));
    assert.equal(duplicate.status, "duplicate_skipped");
    assert.equal(duplicate.approval.status, "approved");
    assert.equal(duplicate.execution.status, "completed");
    assert.equal(client.calls.length, 1);

    const stored = await repository.getRequest(raised.request.id);
    assert.equal(stored.approvals.length, 1);
    assert.equal(stored.executions.length, 1);
  } finally {
    await app.close();
  }
});

// The PostgreSQL conflict is recognised by the index NAME, because the driver
// message that carries it is localised by the database. If the migration ever
// names the index differently, a duplicate would surface as a 500 instead of a
// duplicate_skipped, and only this test would notice.
test("the index name the conflict is recognised by is the one the migration creates", async () => {
  const { readFile } = await import("node:fs/promises");
  const migration = await readFile(
    "prisma/migrations/20260824000000_add_request_idempotency_key/migration.sql",
    "utf8"
  );

  assert.equal(REQUEST_IDEMPOTENCY_INDEX, "Request_idempotencyKey_key");
  assert.match(migration, /ADD COLUMN "idempotencyKey" TEXT/);
  assert.ok(
    migration.includes(`CREATE UNIQUE INDEX "${REQUEST_IDEMPOTENCY_INDEX}" ON "Request"("idempotencyKey")`),
    "the migration must create the index the repository matches on"
  );
  // Additive only. Scanning the file for destructive verbs would trip over the
  // comment header, which uses the words dropped and renamed to promise the
  // opposite, so the file is pinned to the two statements it should contain.
  const statements = migration.split(";").filter((part) => part.trim().length > 0);
  assert.equal(statements.length, 2, "the migration must be exactly two statements");
  assert.equal(statements.filter((part) => part.includes("ALTER TABLE")).length, 1);
  assert.equal(statements.filter((part) => part.includes("CREATE UNIQUE INDEX")).length, 1);
});
