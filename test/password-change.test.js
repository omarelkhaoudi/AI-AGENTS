import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository, buildApi } from "../src/index.js";
import { createSecurityConfig } from "../src/security/security-config.js";
import { hashPassword } from "../src/security/password.js";

// Each person changes their own password; an account created with a temporary
// one opens nothing else until its owner has chosen their own. Invented
// accounts and passwords only.
const TEMPORARY = "provisoire-exemple-1";
const CHOSEN = "jardin-exemple-2026";

async function appWith(t, { mustChangePassword = false } = {}) {
  const repository = new InMemoryRepository();
  repository.upsertUser({ id: "sara", name: "Sara", email: "sara@exemple.ma", role: "leader", metadata: mustChangePassword ? { mustChangePassword: true } : {} });
  repository.setUserPassword("sara", await hashPassword(TEMPORARY));
  const app = buildApi({ repository, security: createSecurityConfig({ NODE_ENV: "production", RATE_LIMIT_LOGIN_MAX: "100" }) });
  t.after(() => app.close());
  return { app, repository };
}

const login = async (app, password) => JSON.parse((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "sara@exemple.ma", password } })).body);
const call = (app, token, method, url, payload) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });

test("a temporary password opens only the change of password, then the cockpit opens with the chosen one", async (t) => {
  const { app, repository } = await appWith(t, { mustChangePassword: true });
  const session = await login(app, TEMPORARY);
  assert.equal(session.mustChangePassword, true);
  assert.equal(JSON.parse((await call(app, session.token, "GET", "/api/auth/me")).body).mustChangePassword, true);
  assert.equal((await call(app, session.token, "GET", "/api/company")).statusCode, 200, "the page can still show the company's name");

  const blocked = await call(app, session.token, "GET", "/api/hr");
  assert.equal(blocked.statusCode, 403);
  assert.equal(JSON.parse(blocked.body).details.code, "PASSWORD_CHANGE_REQUIRED");

  const unchanged = await call(app, session.token, "POST", "/api/auth/password", { current: TEMPORARY, next: TEMPORARY });
  assert.equal(JSON.parse(unchanged.body).details.code, "PASSWORD_UNCHANGED");
  const short = await call(app, session.token, "POST", "/api/auth/password", { current: TEMPORARY, next: "court" });
  assert.equal(JSON.parse(short.body).details.code, "PASSWORD_TOO_SHORT");

  const done = await call(app, session.token, "POST", "/api/auth/password", { current: TEMPORARY, next: CHOSEN });
  assert.equal(done.statusCode, 200);
  assert.equal((await call(app, session.token, "GET", "/api/hr")).statusCode, 200, "the same session now opens the cockpit");
  assert.equal(repository.getUser("sara").metadata.mustChangePassword, undefined);
  assert.equal((await login(app, TEMPORARY)).token, undefined, "the temporary password no longer signs in");
  assert.equal((await login(app, CHOSEN)).mustChangePassword, false);
});

test("a change needs the current password, signs the other devices out and is audited", async (t) => {
  const { app, repository } = await appWith(t);
  const phone = (await login(app, TEMPORARY)).token;
  const laptop = (await login(app, TEMPORARY)).token;

  const wrong = await call(app, laptop, "POST", "/api/auth/password", { current: "pas-le-bon-mot", next: CHOSEN });
  assert.equal(wrong.statusCode, 400);
  assert.equal(JSON.parse(wrong.body).details.code, "INVALID_PASSWORD");

  const done = JSON.parse((await call(app, laptop, "POST", "/api/auth/password", { current: TEMPORARY, next: CHOSEN })).body);
  assert.deepEqual(done, { ok: true, otherSessionsClosed: 1 });
  assert.equal((await call(app, phone, "GET", "/api/auth/me")).statusCode, 401, "the other device is signed out");
  assert.equal((await call(app, laptop, "GET", "/api/auth/me")).statusCode, 200, "the device that changed it stays signed in");
  const events = (await repository.listAuditEvents()).map((event) => event.type);
  assert.ok(events.includes("password_changed"));
});
