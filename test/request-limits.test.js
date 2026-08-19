import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository, buildApi, createSecurityConfig } from "../src/index.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

test("the body limit is declared explicitly and not inherited from the framework default", () => {
  const config = createSecurityConfig({});

  assert.equal(config.bodyLimitBytes, 65536);
  assert.notEqual(config.bodyLimitBytes, 1048576);
  assert.equal(createSecurityConfig({ API_BODY_LIMIT_BYTES: "4096" }).bodyLimitBytes, 4096);
  // An invalid value falls back to the safe default instead of disabling the limit.
  assert.equal(createSecurityConfig({ API_BODY_LIMIT_BYTES: "0" }).bodyLimitBytes, 65536);
  assert.equal(createSecurityConfig({ API_BODY_LIMIT_BYTES: "not-a-number" }).bodyLimitBytes, 65536);
});

test("a request body over the limit is refused with 413", async (t) => {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository });
  t.after(() => app.close());

  const oversized = "x".repeat(80 * 1024);
  const response = await inject({
    method: "POST",
    url: "/api/requests",
    payload: { message: "point", payload: { blob: oversized } }
  });

  assert.equal(response.statusCode, 413);
});

test("a request body under the limit is still accepted", async (t) => {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository });
  t.after(() => app.close());

  const response = await inject({
    method: "POST",
    url: "/api/requests",
    payload: { message: "point", payload: { blob: "x".repeat(8 * 1024) } }
  });

  assert.equal(response.statusCode, 201);
});

test("the configured limit is the one actually enforced", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({
    repository,
    security: createSecurityConfig({ API_BODY_LIMIT_BYTES: "2048" })
  });
  t.after(() => app.close());
  const principal = await createAuthenticatedUser(repository, { id: "leader-limit" });

  const response = await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: { message: "point", payload: { blob: "x".repeat(4096) } },
    headers: principal.headers
  });

  assert.equal(response.statusCode, 413);
});

test("an oversized body is rejected before authentication succeeds", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: { message: "point", payload: { blob: "x".repeat(80 * 1024) } }
  });

  // Either outcome is safe: what must never happen is the oversized payload
  // being parsed and processed.
  assert.ok([401, 413].includes(response.statusCode), `unexpected status ${response.statusCode}`);
  const requests = await repository.listAuditEvents();
  assert.equal(requests.some((event) => event.type === "request_created"), false);
});
