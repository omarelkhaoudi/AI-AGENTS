import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthenticationError,
  InMemoryRepository,
  apiTokenHashesMatch,
  authenticatePrincipal,
  buildApi,
  createApiTokenMaterial,
  createSecurityConfig,
  extractBearerToken,
  generateApiTokenSecret,
  hashApiTokenSecret
} from "../src/index.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

const SENSITIVE_ROUTES = Object.freeze([
  { method: "POST", url: "/api/requests", payload: { message: "point" } },
  { method: "POST", url: "/api/director/requests", payload: { message: "point" } },
  { method: "GET", url: "/api/approvals" },
  { method: "GET", url: "/api/approvals/some-id" },
  { method: "POST", url: "/api/approvals/some-id/approve", payload: {} },
  { method: "POST", url: "/api/approvals/some-id/reject", payload: {} },
  { method: "GET", url: "/api/requests/some-id" }
]);

test("every sensitive API route refuses an anonymous caller", async (t) => {
  const app = buildApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  for (const route of SENSITIVE_ROUTES) {
    const response = await app.inject(route);
    assert.equal(response.statusCode, 401, `${route.method} ${route.url} must require authentication`);
    assert.equal(JSON.parse(response.body).details.code, "AUTHENTICATION_REQUIRED");
  }
});

test("public routes stay reachable without a token", async (t) => {
  const app = buildApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  assert.equal((await app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/app/" })).statusCode, 200);
});

test("a malformed or unknown token is refused", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const headers = [undefined, "", "Basic abcdef", "Bearer", `Bearer ${generateApiTokenSecret()}`];

  for (const authorization of headers) {
    const response = await app.inject({
      method: "GET",
      url: "/api/approvals",
      headers: authorization === undefined ? {} : { authorization }
    });
    assert.equal(response.statusCode, 401, `header ${JSON.stringify(authorization)} must be refused`);
  }
});

test("a revoked token stops working immediately", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());
  const principal = await createAuthenticatedUser(repository, { id: "leader-revoke" });

  assert.equal((await app.inject({
    method: "GET",
    url: "/api/approvals",
    headers: principal.headers
  })).statusCode, 200);

  await repository.revokeApiToken(principal.token.id);

  assert.equal((await app.inject({
    method: "GET",
    url: "/api/approvals",
    headers: principal.headers
  })).statusCode, 401);
});

test("an expired token is refused", async () => {
  const repository = new InMemoryRepository();
  const user = await repository.upsertUser({ id: "leader-expired", name: "Expired", role: "leader" });
  const material = createApiTokenMaterial({ userId: user.id, name: "expired" });
  await repository.createApiToken({
    ...material.record,
    expiresAt: new Date(Date.now() - 1000).toISOString()
  });

  await assert.rejects(
    () => authenticatePrincipal({ repository, authorizationHeader: `Bearer ${material.secret}` }),
    (error) => error instanceof AuthenticationError && error.code === "INVALID_CREDENTIALS"
  );
});

test("a disabled user cannot authenticate even with a valid token", async () => {
  const repository = new InMemoryRepository();
  const principal = await createAuthenticatedUser(repository, { id: "leader-disabled" });

  await repository.upsertUser({ id: "leader-disabled", name: "Disabled", role: "leader", status: "disabled" });

  await assert.rejects(
    () => authenticatePrincipal({ repository, authorizationHeader: `Bearer ${principal.secret}` }),
    (error) => error instanceof AuthenticationError && error.code === "INVALID_CREDENTIALS"
  );
});

test("the token secret is never stored, only its hash", async () => {
  const repository = new InMemoryRepository();
  const principal = await createAuthenticatedUser(repository, { id: "leader-hash" });
  const stored = await repository.listApiTokens({ userId: "leader-hash" });

  assert.equal(stored.length, 1);
  assert.equal(stored[0].tokenHash, hashApiTokenSecret(principal.secret));
  assert.equal(JSON.stringify(stored).includes(principal.secret), false);
});

test("token hash comparison rejects malformed and mismatched hashes", () => {
  const hash = hashApiTokenSecret("some-value");

  assert.equal(apiTokenHashesMatch(hash, hash), true);
  assert.equal(apiTokenHashesMatch(hash, hashApiTokenSecret("other-value")), false);
  assert.equal(apiTokenHashesMatch(hash, "tooshort"), false);
  assert.equal(apiTokenHashesMatch(hash, null), false);
  assert.equal(apiTokenHashesMatch(undefined, hash), false);
});

test("bearer extraction accepts only the Bearer scheme", () => {
  assert.equal(extractBearerToken("Bearer abc123"), "abc123");
  assert.throws(() => extractBearerToken("bearer abc123"), AuthenticationError);
  assert.throws(() => extractBearerToken("Token abc123"), AuthenticationError);
  assert.throws(() => extractBearerToken(""), AuthenticationError);
  assert.throws(() => extractBearerToken(null), AuthenticationError);
});

test("authentication failures are audited without leaking the presented token", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());
  const secret = generateApiTokenSecret();

  await app.inject({
    method: "GET",
    url: "/api/approvals",
    headers: { authorization: `Bearer ${secret}` }
  });

  const events = await repository.listAuditEvents();
  const failures = events.filter((event) => event.type === "authentication_failed");

  assert.equal(failures.length, 1);
  assert.equal(failures[0].resourceId, "/api/approvals");
  assert.equal(JSON.stringify(failures[0]).includes(secret), false);
});

test("demo mode distributes a real token and never bypasses verification", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository, security: createSecurityConfig({ AUTH_MODE: "demo" }) });
  t.after(() => app.close());

  // Even in demo mode an anonymous call is refused: only distribution is automated.
  assert.equal((await app.inject({ method: "GET", url: "/api/approvals" })).statusCode, 401);

  const session = JSON.parse((await app.inject({ method: "GET", url: "/api/auth/demo-session" })).body);
  assert.equal(session.user.role, "leader");
  assert.ok(session.token.length > 0);

  const authorized = await app.inject({
    method: "GET",
    url: "/api/approvals",
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(authorized.statusCode, 200);

  // The demo token is a real stored credential, not a magic value.
  const stored = await repository.findApiTokenByHash(hashApiTokenSecret(session.token));
  assert.ok(stored);
  assert.equal(stored.userId, session.user.id);
});

// The configuration is built from an empty environment, not from the one this
// process happens to carry. Reading process.env made the test assert a default
// while depending on a setting: on a machine whose .env sets AUTH_MODE=demo,
// "the default token mode" was demo mode and the test failed on a correct build.
// An empty environment is the only way to state what the default actually is.
test("demo mode endpoint does not exist under the default token mode", async (t) => {
  const security = createSecurityConfig({});
  assert.equal(security.authMode, "token", "an unset AUTH_MODE must mean token");
  assert.equal(security.demoModeEnabled, false);

  const app = buildApi({ repository: new InMemoryRepository(), security });
  t.after(() => app.close());

  assert.equal((await app.inject({ method: "GET", url: "/api/auth/demo-session" })).statusCode, 404);
});

test("demo mode is refused when NODE_ENV is production", () => {
  assert.throws(
    () => createSecurityConfig({ AUTH_MODE: "demo", NODE_ENV: "production" }),
    (error) => error.name === "SecurityConfigurationError" && /NODE_ENV=production/.test(error.message)
  );

  assert.equal(createSecurityConfig({ AUTH_MODE: "demo", NODE_ENV: "development" }).demoModeEnabled, true);
  assert.equal(createSecurityConfig({ AUTH_MODE: "token", NODE_ENV: "production" }).demoModeEnabled, false);
});

test("an authenticated principal reaches the API and is recorded as the author", async (t) => {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository, userId: "leader-author" });
  t.after(() => app.close());

  const response = await inject({
    method: "POST",
    url: "/api/requests",
    payload: { message: "Fais-moi le point sur mon entreprise." }
  });

  assert.equal(response.statusCode, 201);
  assert.equal(JSON.parse(response.body).request.createdById, "leader-author");
});
