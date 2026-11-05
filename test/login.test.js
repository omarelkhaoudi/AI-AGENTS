import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository, buildApi } from "../src/index.js";
import { createSecurityConfig } from "../src/security/security-config.js";
import { hashPassword, verifyPassword } from "../src/security/password.js";
import { hashApiTokenSecret } from "../src/security/api-token.js";

// The hosted cockpit is opened with an email and a password. Invented accounts
// only.
const PASSWORD = "example-jardin-42";

async function signedUpApp(t, env = {}) {
  const repository = new InMemoryRepository();
  repository.upsertUser({ id: "hiba", name: "Hiba", email: "hiba@exemple.ma", role: "leader" });
  repository.setUserPassword("hiba", await hashPassword(PASSWORD));
  const app = buildApi({ repository, security: createSecurityConfig({ NODE_ENV: "production", ...env }) });
  t.after(() => app.close());
  return { app, repository };
}

const login = (app, body) => app.inject({ method: "POST", url: "/api/auth/login", payload: body });

test("a password is stored as a salted hash and checked against it", async () => {
  const first = await hashPassword(PASSWORD);
  const second = await hashPassword(PASSWORD);
  assert.notEqual(first, second, "each hash has its own salt");
  assert.equal(first.includes(PASSWORD), false);
  assert.equal(await verifyPassword(PASSWORD, first), true);
  assert.equal(await verifyPassword("example-jardin-43", first), false);
  await assert.rejects(hashPassword("court"), { code: "PASSWORD_TOO_SHORT" });
});

test("the right email and password open a session that reaches the API, whatever the case of the email", async (t) => {
  const { app, repository } = await signedUpApp(t);

  const response = await login(app, { email: " Hiba@Exemple.MA ", password: PASSWORD });

  assert.equal(response.statusCode, 200);
  const session = JSON.parse(response.body);
  assert.deepEqual(session.user, { name: "Hiba", role: "leader" });
  const stored = await repository.findApiTokenByHash(hashApiTokenSecret(session.token));
  assert.equal(stored.name, "session");
  assert.ok(Date.parse(stored.expiresAt) > Date.now() + 29 * 24 * 3600 * 1000, "a session lasts 30 days");
  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${session.token}` } });
  assert.deepEqual(JSON.parse(me.body).user, { name: "Hiba", role: "leader" });
  assert.equal(JSON.stringify(JSON.parse(me.body)).includes("scrypt"), false);
});

test("a wrong password and an unknown email get the same answer", async (t) => {
  const { app, repository } = await signedUpApp(t);

  const wrong = await login(app, { email: "hiba@exemple.ma", password: "example-mauvais-mdp" });
  const unknown = await login(app, { email: "personne@exemple.ma", password: PASSWORD });

  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.body, unknown.body);
  assert.equal(repository.listApiTokens().length, 0, "no session is opened");
});

test("signing out revokes the session", async (t) => {
  const { app } = await signedUpApp(t);
  const { token } = JSON.parse((await login(app, { email: "hiba@exemple.ma", password: PASSWORD })).body);
  const headers = { authorization: `Bearer ${token}` };

  assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers })).statusCode, 200);

  assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers })).statusCode, 401);
});

test("password guessing is capped at five tries a minute", async (t) => {
  const { app } = await signedUpApp(t);
  const codes = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    codes.push((await login(app, { email: "hiba@exemple.ma", password: `example-essai-${attempt}` })).statusCode);
  }
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
});
