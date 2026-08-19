import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository, buildApi, createSecurityConfig } from "../src/index.js";
import { createAuthenticatedUser } from "../test-support/api-auth.js";

function tightSecurity(overrides = {}) {
  return createSecurityConfig({
    RATE_LIMIT_READ_MAX: "3",
    RATE_LIMIT_WRITE_MAX: "2",
    RATE_LIMIT_DECISION_MAX: "2",
    ...overrides
  });
}

test("rate limits are configurable and have conservative defaults", () => {
  const defaults = createSecurityConfig({});

  assert.equal(defaults.rateLimits.read.max, 240);
  assert.equal(defaults.rateLimits.write.max, 60);
  assert.equal(defaults.rateLimits.decision.max, 20);
  // The most sensitive endpoint must never be the most permissive one.
  assert.ok(defaults.rateLimits.decision.max < defaults.rateLimits.write.max);
  assert.ok(defaults.rateLimits.write.max < defaults.rateLimits.read.max);

  assert.equal(tightSecurity().rateLimits.read.max, 3);
});

test("a read endpoint starts returning 429 past its limit", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository, security: tightSecurity() });
  t.after(() => app.close());
  const principal = await createAuthenticatedUser(repository, { id: "leader-read-limit" });

  const codes = [];
  for (let index = 0; index < 5; index += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/api/approvals",
      headers: principal.headers
    });
    codes.push(response.statusCode);
  }

  assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
  assert.equal(codes[3], 429);
  assert.equal(codes[4], 429);
});

test("the approval decision endpoint is rate limited", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository, security: tightSecurity() });
  t.after(() => app.close());
  const principal = await createAuthenticatedUser(repository, { id: "leader-decision-limit", role: "approver" });

  const codes = [];
  for (let index = 0; index < 4; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/api/approvals/unknown-id/approve",
      payload: {},
      headers: principal.headers
    });
    codes.push(response.statusCode);
  }

  // The first calls reach the handler (404 on an unknown approval), then the
  // limiter takes over.
  assert.equal(codes.filter((code) => code === 429).length, 2);
  assert.equal(codes[3], 429);
});

// Buckets key on the presented credential, since the limiter runs before the
// principal is resolved. One credential per user keeps this per-user in practice.
test("rate limit buckets are partitioned per credential", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository, security: tightSecurity() });
  t.after(() => app.close());
  const first = await createAuthenticatedUser(repository, { id: "leader-bucket-a" });
  const second = await createAuthenticatedUser(repository, { id: "leader-bucket-b" });

  for (let index = 0; index < 4; index += 1) {
    await app.inject({ method: "GET", url: "/api/approvals", headers: first.headers });
  }

  const firstBlocked = await app.inject({ method: "GET", url: "/api/approvals", headers: first.headers });
  const secondAllowed = await app.inject({ method: "GET", url: "/api/approvals", headers: second.headers });

  assert.equal(firstBlocked.statusCode, 429);
  assert.equal(secondAllowed.statusCode, 200, "a second credential must not inherit the first bucket");
});

test("exceeding the limit is audited", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository, security: tightSecurity() });
  t.after(() => app.close());
  const principal = await createAuthenticatedUser(repository, { id: "leader-audit-limit" });

  for (let index = 0; index < 5; index += 1) {
    await app.inject({ method: "GET", url: "/api/approvals", headers: principal.headers });
  }

  const exceeded = (await repository.listAuditEvents()).filter((event) => event.type === "rate_limit_exceeded");

  assert.ok(exceeded.length > 0, "exceeding a rate limit must leave an audit trail");
  assert.equal(exceeded[0].resourceId, "/api/approvals");
});

// The limiter must run BEFORE authentication. Without that, an anonymous flood
// reaches the credential lookup on every request and is never capped.
test("an anonymous flood is rate limited before authentication", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository, security: tightSecurity() });
  t.after(() => app.close());

  const codes = [];
  for (let index = 0; index < 12; index += 1) {
    codes.push((await app.inject({ method: "GET", url: "/api/approvals" })).statusCode);
  }

  const limited = codes.filter((code) => code === 429).length;
  const unauthenticated = codes.filter((code) => code === 401).length;

  assert.ok(limited > 0, `an anonymous flood must be rate limited, got ${codes.join(",")}`);
  // Read limit is 3, so at most 3 requests may reach the credential lookup.
  assert.equal(unauthenticated, 3, `only the first 3 anonymous calls may reach authentication, got ${codes.join(",")}`);
  assert.equal(limited, codes.length - 3);
  // Nothing is ever served: being limited must not become a way in.
  assert.equal(codes.some((code) => code === 200), false);
});

test("an anonymous flood cannot amplify audit writes", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository, security: tightSecurity() });
  t.after(() => app.close());

  const floodSize = 30;
  for (let index = 0; index < floodSize; index += 1) {
    await app.inject({ method: "GET", url: "/api/approvals" });
  }

  const events = await repository.listAuditEvents();

  // One audit row per anonymous request would let an unauthenticated caller
  // grow the audit table without bound.
  assert.ok(
    events.length < floodSize,
    `audit writes must not scale with an anonymous flood: ${events.length} rows for ${floodSize} requests`
  );
  assert.equal(events.filter((event) => event.type === "authentication_failed").length, 3);
  assert.equal(events.filter((event) => event.type === "rate_limit_exceeded").length, 1);
});

test("a flood of unrouted paths cannot allocate unbounded limiter state", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository, security: tightSecurity() });
  t.after(() => app.close());

  const codes = [];
  for (let index = 0; index < 10; index += 1) {
    codes.push((await app.inject({ method: "GET", url: `/api/unrouted-${index}` })).statusCode);
  }

  // All unrouted paths share a single bucket, so random URLs cannot each get
  // their own fresh budget.
  assert.ok(codes.includes(429), `unrouted paths must share one bucket, got ${codes.join(",")}`);
  assert.equal(codes.filter((code) => code === 401).length, 3);
});

test("an authenticated principal keeps its own budget after an anonymous flood", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository, security: tightSecurity() });
  t.after(() => app.close());
  const principal = await createAuthenticatedUser(repository, { id: "leader-after-flood" });

  for (let index = 0; index < 10; index += 1) {
    await app.inject({ method: "GET", url: "/api/approvals" });
  }

  const authorized = await app.inject({ method: "GET", url: "/api/approvals", headers: principal.headers });

  assert.equal(authorized.statusCode, 200, "an anonymous flood must not consume an authenticated budget");
});
