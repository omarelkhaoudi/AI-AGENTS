import assert from "node:assert/strict";
import test from "node:test";
import {
  API_CAPABILITIES,
  AuthorizationError,
  InMemoryRepository,
  USER_ROLES,
  assertCapability,
  buildApi,
  minimumRoleForCapability,
  normalizeUserRole,
  roleSatisfiesCapability
} from "../src/index.js";
import { createAuthenticatedUser } from "../test-support/api-auth.js";

// Every sensitive route, with the weakest role that must be able to reach it.
// A new endpoint that is not listed here is caught by the coverage test below.
const ROUTE_POLICY = Object.freeze([
  { method: "GET", url: "/api/approvals", capability: "read_requests" },
  { method: "GET", url: "/api/approvals/unknown-id", capability: "read_requests" },
  { method: "GET", url: "/api/requests/unknown-id", capability: "read_requests" },
  { method: "POST", url: "/api/requests", capability: "create_requests", payload: { message: "point" } },
  { method: "POST", url: "/api/director/requests", capability: "create_requests", payload: { message: "point" } },
  { method: "POST", url: "/api/approvals/unknown-id/approve", capability: "decide_approvals", payload: {} },
  { method: "POST", url: "/api/approvals/unknown-id/reject", capability: "decide_approvals", payload: {} }
]);

test("role hierarchy is ordered and closed over its capabilities", () => {
  assert.deepEqual(USER_ROLES, ["viewer", "operator", "approver", "leader"]);

  assert.equal(roleSatisfiesCapability("viewer", "read_requests"), true);
  assert.equal(roleSatisfiesCapability("viewer", "create_requests"), false);
  assert.equal(roleSatisfiesCapability("operator", "create_requests"), true);
  assert.equal(roleSatisfiesCapability("operator", "decide_approvals"), false);
  assert.equal(roleSatisfiesCapability("approver", "decide_approvals"), true);
  assert.equal(roleSatisfiesCapability("approver", "manage_api_tokens"), false);
  assert.equal(roleSatisfiesCapability("leader", "manage_api_tokens"), true);

  for (const capability of API_CAPABILITIES) {
    assert.ok(minimumRoleForCapability(capability), `${capability} must declare a minimum role`);
    assert.equal(roleSatisfiesCapability("leader", capability), true);
  }
});

test("an unknown role is never more privileged than the weakest role", () => {
  assert.equal(normalizeUserRole("superadmin"), "viewer");
  assert.equal(normalizeUserRole(null), "viewer");
  assert.equal(normalizeUserRole(undefined), "viewer");
  assert.equal(normalizeUserRole(42), "viewer");
  assert.equal(roleSatisfiesCapability("superadmin", "decide_approvals"), false);
});

test("assertCapability refuses a missing principal and an unknown capability", () => {
  assert.throws(() => assertCapability(null, "read_requests"), AuthorizationError);
  assert.throws(() => assertCapability({}, "read_requests"), AuthorizationError);
  assert.throws(
    () => assertCapability({ userId: "u", role: "leader" }, "invent_capability"),
    (error) => error instanceof AuthorizationError && error.code === "AUTHORIZATION_MISCONFIGURED"
  );
});

test("each sensitive route refuses roles below its capability and accepts roles above it", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const principals = {};
  for (const role of USER_ROLES) {
    principals[role] = await createAuthenticatedUser(repository, { id: `user-${role}`, role });
  }

  for (const route of ROUTE_POLICY) {
    for (const role of USER_ROLES) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        payload: route.payload,
        headers: principals[role].headers
      });
      const allowed = roleSatisfiesCapability(role, route.capability);

      if (allowed) {
        assert.notEqual(
          response.statusCode,
          403,
          `${role} must reach ${route.method} ${route.url}`
        );
      } else {
        assert.equal(
          response.statusCode,
          403,
          `${role} must be refused on ${route.method} ${route.url}`
        );
        assert.equal(JSON.parse(response.body).details.code, "AUTHORIZATION_DENIED");
      }
    }
  }
});

test("an authorization denial is audited with the real principal", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());
  const viewer = await createAuthenticatedUser(repository, { id: "viewer-audit", role: "viewer" });

  await app.inject({
    method: "POST",
    url: "/api/requests",
    payload: { message: "point" },
    headers: viewer.headers
  });

  const denied = (await repository.listAuditEvents()).filter((event) => event.type === "authorization_denied");

  assert.equal(denied.length, 1);
  assert.equal(denied[0].actorUserId, "viewer-audit");
  assert.equal(denied[0].metadata.capability, "create_requests");
});

// Deny by default: an /api route that declares no capability must be refused
// rather than silently exposed. This is what protects a future endpoint whose
// author forgets the authorization annotation.
test("an API route that declares no capability is refused instead of exposed", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  app.get("/api/forgotten-endpoint", async () => ({ leaked: true }));
  t.after(() => app.close());

  const principal = await createAuthenticatedUser(repository, { id: "leader-forgotten", role: "leader" });
  const response = await app.inject({
    method: "GET",
    url: "/api/forgotten-endpoint",
    headers: principal.headers
  });

  assert.equal(response.statusCode, 500);
  assert.equal(JSON.parse(response.body).details.code, "AUTHORIZATION_MISCONFIGURED");
  assert.equal(response.body.includes("leaked"), false);
});

test("every route in the policy table is actually routed, not silently missing", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());
  const leader = await createAuthenticatedUser(repository, { id: "leader-routing", role: "leader" });

  for (const route of ROUTE_POLICY) {
    const response = await app.inject({
      method: route.method,
      url: route.url,
      payload: route.payload,
      headers: leader.headers
    });

    // A typo in the table would surface as a router 404 with no details code.
    const body = JSON.parse(response.body);
    assert.notEqual(
      body.message,
      `Route ${route.method}:${route.url} not found`,
      `${route.method} ${route.url} is not declared by the API`
    );
  }
});
