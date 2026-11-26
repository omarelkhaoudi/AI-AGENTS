import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository, buildApi } from "../src/index.js";
import { createSecurityConfig } from "../src/security/security-config.js";
import { hashPassword } from "../src/security/password.js";
import { currentStep, totpCode } from "../src/security/two-factor.js";
import { generatePortalKeys, signPortalTicket, verifyPortalTicket } from "../src/security/portal-token.js";

// Entry into a company's cockpit from the platform's portal: a ticket signed by
// the portal, for that company, a minute old at most and used once. Invented
// accounts and keys only.
const PASSWORD = "example-jardin-42";
const PORTAL_URL = "https://portail.exemple.ma";
const keys = generatePortalKeys();
const SARA = Object.freeze({ id: "compte-sara", email: "sara@exemple.ma", name: "Sara" });

function ticket({ account = SARA, company = "hkids", role = "sales", now = new Date(), key = keys.privateKey } = {}) {
  return signPortalTicket({ account, company, role, now }, key);
}

async function cockpit(t, { now = { value: new Date() }, subscription = null, publicKey = keys.publicKey, env = {} } = {}) {
  const repository = new InMemoryRepository();
  const app = buildApi({
    repository,
    subscription,
    portalPublicKey: publicKey,
    portalUrl: PORTAL_URL,
    clock: () => now.value,
    security: createSecurityConfig({ NODE_ENV: "production", RATE_LIMIT_LOGIN_MAX: "100", DIRECTION_TWO_FACTOR: "off", ...env })
  });
  t.after(() => app.close());
  const enter = async (body) => {
    const response = await app.inject({ method: "POST", url: "/api/auth/portal", payload: body });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  return { app, repository, enter, now };
}

test("a ticket opens a session, with the role the company gave in the portal", async (t) => {
  const { app, repository, enter } = await cockpit(t);
  const entered = await enter({ token: ticket() });
  assert.equal(entered.status, 200);
  assert.deepEqual(entered.body.user, { name: "Sara", role: "operator" });
  assert.equal(entered.body.portalUrl, PORTAL_URL);

  const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${entered.body.token}` } });
  assert.equal(me.statusCode, 200);
  assert.equal(JSON.parse(me.body).portalUrl, PORTAL_URL);

  const user = await repository.getUser("portail-compte-sara");
  assert.equal(user.email, "sara@exemple.ma");
  assert.deepEqual(user.metadata, { companyId: "hkids", portalAccountId: "compte-sara" });
  assert.equal(repository.countSignInUsers(), 1, "the person takes a seat");
});

test("the person who entered from the portal has no password of their own", async (t) => {
  const { app, enter } = await cockpit(t);
  await enter({ token: ticket() });
  for (const password of ["portail$sans-mot-de-passe", "", PASSWORD]) {
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "sara@exemple.ma", password } });
    assert.equal(login.statusCode, 401);
  }
});

test("a ticket for another company, expired, replayed, altered or signed by another key is refused", async (t) => {
  const now = { value: new Date("2026-11-26T09:00:00Z") };
  const { enter } = await cockpit(t, { now });
  const code = async (body) => (await enter(body)).body.details.code;

  assert.equal(await code({ token: ticket({ company: "atelier-elan", now: now.value }) }), "PORTAL_TOKEN_OTHER_COMPANY");
  assert.equal(await code({ token: ticket({ now: new Date(now.value.getTime() - 61_000) }) }), "PORTAL_TOKEN_EXPIRED");
  assert.equal(await code({ token: ticket({ now: now.value, key: generatePortalKeys().privateKey }) }), "PORTAL_TOKEN_INVALID");
  assert.equal(await code({ token: "pas.un.ticket" }), "PORTAL_TOKEN_INVALID");
  assert.equal(await code({}), "PORTAL_TOKEN_INVALID");

  const good = ticket({ now: now.value });
  const [header, payload, signature] = good.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  const promoted = Buffer.from(JSON.stringify({ ...claims, role: "owner" })).toString("base64url");
  assert.equal(await code({ token: `${header}.${promoted}.${signature}` }), "PORTAL_TOKEN_INVALID", "a role changed by hand breaks the signature");

  assert.equal((await enter({ token: good })).status, 200);
  assert.equal(await code({ token: good }), "PORTAL_TOKEN_USED");
});

test("the role follows the portal at each entry; an account of another company is refused", async (t) => {
  const { repository, enter } = await cockpit(t);
  assert.equal((await enter({ token: ticket({ role: "viewer" }) })).body.user.role, "viewer");
  assert.equal((await enter({ token: ticket({ role: "finance" }) })).body.user.role, "approver");

  repository.upsertUser({ id: "karim", email: "karim@exemple.ma", name: "Karim", role: "operator", metadata: { companyId: "atelier-elan" } });
  repository.setUserPassword("karim", await hashPassword(PASSWORD));
  const refused = await enter({ token: ticket({ account: { id: "compte-karim", email: "karim@exemple.ma", name: "Karim" } }) });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.details.code, "OTHER_COMPANY");

  repository.upsertUser({ id: "nadia", email: "nadia@exemple.ma", name: "Nadia", role: "operator", status: "disabled" });
  repository.setUserPassword("nadia", await hashPassword(PASSWORD));
  const disabled = await enter({ token: ticket({ account: { id: "compte-nadia", email: "nadia@exemple.ma", name: "Nadia" } }) });
  assert.equal(disabled.body.details.code, "ACCOUNT_DISABLED");
});

test("an account of the cockpit keeps its password and its two-step sign-in when it comes from the portal", async (t) => {
  const now = { value: new Date("2026-11-26T09:00:00Z") };
  const { app, repository, enter } = await cockpit(t, { now });
  repository.upsertUser({ id: "hiba", email: "hiba@exemple.ma", name: "Hiba", role: "leader" });
  repository.setUserPassword("hiba", await hashPassword(PASSWORD));
  const signIn = JSON.parse((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "hiba@exemple.ma", password: PASSWORD } })).body);
  const headers = { authorization: `Bearer ${signIn.token}` };
  const setup = JSON.parse((await app.inject({ method: "POST", url: "/api/auth/two-factor/setup", headers })).body);
  const secret = setup.secret.replace(/ /g, "");
  assert.equal((await app.inject({ method: "POST", url: "/api/auth/two-factor/enable", headers, payload: { code: totpCode(secret, currentStep(now.value)) } })).statusCode, 200);

  now.value = new Date(now.value.getTime() + 90_000);
  const hiba = { id: "compte-hiba", email: "hiba@exemple.ma", name: "Hiba" };
  const token = ticket({ account: hiba, role: "owner", now: now.value });
  assert.equal((await enter({ token })).body.details.code, "TWO_FACTOR_REQUIRED");
  assert.equal((await enter({ token, code: "000000" })).body.details.code, "INVALID_TWO_FACTOR");
  const entered = await enter({ token, code: totpCode(secret, currentStep(now.value)) });
  assert.equal(entered.status, 200, "the ticket is spent only once the code is right");
  assert.equal(entered.body.user.role, "leader");
  assert.equal(entered.body.mustEnableTwoFactor, false);

  const user = await repository.getUser("hiba");
  assert.equal(user.metadata.portalAccountId, "compte-hiba");
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "hiba@exemple.ma", password: PASSWORD } });
  assert.equal(JSON.parse(login.body).details.code, "TWO_FACTOR_REQUIRED", "her password still works, with her code");
});

test("a full subscription refuses a new person from the portal", async (t) => {
  const { repository, enter } = await cockpit(t, { subscription: { label: "Essai", maxUsers: 1 } });
  repository.upsertUser({ id: "hiba", email: "hiba@exemple.ma", name: "Hiba", role: "leader" });
  repository.setUserPassword("hiba", await hashPassword(PASSWORD));
  const refused = await enter({ token: ticket() });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.details.code, "PLAN_USERS_FULL");
});

test("without the portal's key the cockpit does not open from it", async (t) => {
  const { enter } = await cockpit(t, { publicKey: null });
  const refused = await enter({ token: ticket() });
  assert.equal(refused.status, 404);
  assert.equal(refused.body.details.code, "PORTAL_DISABLED");
});

test("a ticket is checked to the second: signed by the portal, for one company, sixty seconds", () => {
  const now = new Date("2026-11-26T09:00:00Z");
  const token = ticket({ now });
  const claims = verifyPortalTicket(token, { publicKey: keys.publicKey, audience: "hkids", now: new Date(now.getTime() + 59_000) });
  assert.equal(claims.sub, "compte-sara");
  assert.equal(claims.role, "sales");
  assert.throws(() => verifyPortalTicket(token, { publicKey: keys.publicKey, audience: "hkids", now: new Date(now.getTime() + 60_000) }), { code: "PORTAL_TOKEN_EXPIRED" });
});
