import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryPlatformStore } from "../src/platform/memory-store.js";
import { createPlatformMailer, createTestInbox } from "../src/platform/mailer.js";
import { buildPlatform, readCookie, SESSION_COOKIE } from "../src/platform/server.js";

const BASE_URL = "https://portail.exemple.ma";
const PASSWORD = "example-atelier-26";

function setUp({ rateLimits } = {}) {
  let now = new Date("2026-11-26T09:00:00Z");
  const clock = () => now;
  const store = createMemoryPlatformStore({ clock });
  const inbox = createTestInbox({ clock });
  const mailer = createPlatformMailer({ env: {}, inbox });
  const app = buildPlatform({ store, mailer, baseUrl: BASE_URL, clock, ...(rateLimits ? { rateLimits } : {}) });
  const post = (url, payload, headers = {}) =>
    app.inject({ method: "POST", url, payload, headers: { "content-type": "application/json", origin: BASE_URL, ...headers } });
  const lastMail = async () => (await inbox.messages({ limit: 1 }))[0];
  const tokenOf = (mail) => new URL(mail.text.match(/https:\/\/\S+/)[0].replace("/#/", "/")).searchParams.get("jeton");
  return { app, store, inbox, post, lastMail, tokenOf, advance: (hours) => { now = new Date(now.getTime() + hours * 3600 * 1000); } };
}

async function signedUpAndVerified(context, { name = "Sara Benali", email = "sara@atelier.ma" } = {}) {
  await context.post("/api/auth/signup", { name, email, password: PASSWORD });
  await context.post("/api/auth/verify-email", { token: context.tokenOf(await context.lastMail()) });
}

test("sign-up sends a confirmation link; the account opens only once it is followed, and the link works once", async () => {
  const context = setUp();
  const signup = await context.post("/api/auth/signup", { name: " Sara  Benali ", email: "Sara@Atelier.ma", password: PASSWORD });
  assert.equal(signup.statusCode, 200);

  const mail = await context.lastMail();
  assert.equal(mail.to, "sara@atelier.ma");
  assert.equal(mail.mode, "test");
  assert.match(mail.text, /^Bonjour Sara Benali,/);
  assert.match(mail.text, /https:\/\/portail\.exemple\.ma\/#\/verifier\?jeton=/);

  const early = await context.post("/api/auth/login", { email: "sara@atelier.ma", password: PASSWORD });
  assert.equal(early.statusCode, 403);
  assert.equal(early.json().details.code, "EMAIL_NOT_VERIFIED");

  const token = context.tokenOf(mail);
  const verified = await context.post("/api/auth/verify-email", { token });
  assert.equal(verified.statusCode, 200);
  assert.deepEqual(Object.keys(verified.json().account).sort(), ["email", "emailVerified", "id", "name"]);
  assert.equal((await context.post("/api/auth/verify-email", { token })).json().details.code, "TOKEN_INVALID");

  const login = await context.post("/api/auth/login", { email: "SARA@atelier.ma ", password: PASSWORD });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.equal(login.json().account.passwordHash, undefined);

  const session = readCookie(cookie, SESSION_COOKIE);
  const me = await context.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `${SESSION_COOKIE}=${session}` } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().account.name, "Sara Benali");

  await context.post("/api/auth/logout", {}, { cookie: `${SESSION_COOKIE}=${session}` });
  const after = await context.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `${SESSION_COOKIE}=${session}` } });
  assert.equal(after.statusCode, 401);
});

test("a confirmation link expires after 48 hours, and a new one can be asked with the password", async () => {
  const context = setUp();
  await context.post("/api/auth/signup", { name: "Sara", email: "sara@atelier.ma", password: PASSWORD });
  const old = context.tokenOf(await context.lastMail());
  context.advance(49);
  assert.equal((await context.post("/api/auth/verify-email", { token: old })).json().details.code, "TOKEN_INVALID");

  assert.equal((await context.post("/api/auth/resend-verification", { email: "sara@atelier.ma", password: "pas-le-bon-mot" })).statusCode, 401);
  assert.equal((await context.post("/api/auth/resend-verification", { email: "sara@atelier.ma", password: PASSWORD })).statusCode, 200);
  const fresh = context.tokenOf(await context.lastMail());
  assert.notEqual(fresh, old);
  assert.equal((await context.post("/api/auth/verify-email", { token: fresh })).statusCode, 200);
});

test("signing up with a known address answers the same and warns its owner, without a second account", async () => {
  const context = setUp();
  await signedUpAndVerified(context);
  const again = await context.post("/api/auth/signup", { name: "Quelqu'un", email: "sara@atelier.ma", password: "example-autre-mot" });
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { ok: true });

  const mail = await context.lastMail();
  assert.equal(mail.subject, "Une inscription avec votre adresse");
  assert.doesNotMatch(mail.text, /jeton=/);
  assert.equal((await context.post("/api/auth/login", { email: "sara@atelier.ma", password: "example-autre-mot" })).statusCode, 401);
  assert.equal((await context.post("/api/auth/login", { email: "sara@atelier.ma", password: PASSWORD })).statusCode, 200);
});

test("a wrong password and an unknown e-mail get the same refusal", async () => {
  const context = setUp();
  await signedUpAndVerified(context);
  const wrong = await context.post("/api/auth/login", { email: "sara@atelier.ma", password: "pas-le-bon-mot" });
  const unknown = await context.post("/api/auth/login", { email: "personne@atelier.ma", password: PASSWORD });
  assert.equal(wrong.statusCode, 401);
  assert.deepEqual(wrong.json(), unknown.json());
});

test("sign-up refuses a short password, an invalid address and a missing name", async () => {
  const context = setUp();
  assert.equal((await context.post("/api/auth/signup", { name: "Sara", email: "sara@atelier.ma", password: "court" })).json().details.code, "PASSWORD_TOO_SHORT");
  assert.equal((await context.post("/api/auth/signup", { name: "Sara", email: "pas-une-adresse", password: PASSWORD })).json().details.code, "EMAIL_INVALID");
  assert.equal((await context.post("/api/auth/signup", { name: "  ", email: "sara@atelier.ma", password: PASSWORD })).json().details.code, "NAME_REQUIRED");
  assert.equal((await context.inbox.messages()).length, 0);
});

test("a forgotten password: same answer for any address, a one-hour link, and the old sessions closed", async () => {
  const context = setUp();
  await signedUpAndVerified(context);
  const login = await context.post("/api/auth/login", { email: "sara@atelier.ma", password: PASSWORD });
  const oldSession = readCookie(login.headers["set-cookie"], SESSION_COOKIE);
  const mailsBefore = (await context.inbox.messages({ limit: 50 })).length;

  const unknown = await context.post("/api/auth/forgot-password", { email: "personne@atelier.ma" });
  assert.deepEqual(unknown.json(), { ok: true });
  assert.equal((await context.inbox.messages({ limit: 50 })).length, mailsBefore);

  const known = await context.post("/api/auth/forgot-password", { email: "sara@atelier.ma" });
  assert.deepEqual(known.json(), unknown.json());
  const mail = await context.lastMail();
  assert.match(mail.text, /#\/nouveau-mot-de-passe\?jeton=/);
  const token = context.tokenOf(mail);

  // A refused password does not use the link up.
  assert.equal((await context.post("/api/auth/reset-password", { token, password: "court" })).json().details.code, "PASSWORD_TOO_SHORT");
  assert.equal((await context.post("/api/auth/reset-password", { token, password: "example-nouveau-26" })).statusCode, 200);
  assert.equal((await context.post("/api/auth/reset-password", { token, password: "encore-un-autre" })).json().details.code, "TOKEN_INVALID");

  const me = await context.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `${SESSION_COOKIE}=${oldSession}` } });
  assert.equal(me.statusCode, 401);
  assert.equal((await context.post("/api/auth/login", { email: "sara@atelier.ma", password: PASSWORD })).statusCode, 401);
  assert.equal((await context.post("/api/auth/login", { email: "sara@atelier.ma", password: "example-nouveau-26" })).statusCode, 200);
});

test("a password link older than one hour is refused", async () => {
  const context = setUp();
  await signedUpAndVerified(context);
  await context.post("/api/auth/forgot-password", { email: "sara@atelier.ma" });
  const token = context.tokenOf(await context.lastMail());
  context.advance(1.1);
  assert.equal((await context.post("/api/auth/reset-password", { token, password: "example-nouveau-26" })).json().details.code, "TOKEN_INVALID");
});

test("a request from another site, or not in JSON, changes nothing", async () => {
  const context = setUp();
  const foreign = await context.post("/api/auth/signup", { name: "Sara", email: "sara@atelier.ma", password: PASSWORD }, { origin: "https://ailleurs.example" });
  assert.equal(foreign.statusCode, 403);
  const form = await context.app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: "name=Sara&email=sara%40atelier.ma&password=example-atelier-26",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE_URL }
  });
  assert.equal(form.statusCode, 415);
  assert.equal((await context.inbox.messages()).length, 0);
});

test("sign-in attempts are limited per connection and minute", async () => {
  const context = setUp({ rateLimits: { auth: 3, other: 100 } });
  const codes = [];
  for (let index = 0; index < 4; index += 1) {
    codes.push((await context.post("/api/auth/login", { email: "sara@atelier.ma", password: "x" })).statusCode);
  }
  assert.deepEqual(codes, [401, 401, 401, 429]);
});

test("the pages are served with the protections, the API never cached", async () => {
  const context = setUp();
  const page = await context.app.inject({ method: "GET", url: "/" });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal((await context.app.inject({ method: "GET", url: "/portail.js" })).statusCode, 200);
  const api = await context.app.inject({ method: "GET", url: "/api/config" });
  assert.equal(api.headers["cache-control"], "no-store");
  assert.equal(api.json().mail, "test");
});
