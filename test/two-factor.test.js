import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository, buildApi } from "../src/index.js";
import { createSecurityConfig } from "../src/security/security-config.js";
import { hashPassword } from "../src/security/password.js";
import { base32Encode, currentStep, totpCode, useRecoveryCode, verifyTotp, hashRecoveryCode, createRecoveryCodes } from "../src/security/two-factor.js";

// Two-step sign-in: after the password, the six-digit code of an authenticator
// app, or a recovery code when the phone is lost. Invented accounts only.
const PASSWORD = "example-jardin-42";

test("codes follow RFC 6238 and are accepted once, one step either side of now", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  assert.equal(totpCode(secret, 1), "287082");
  assert.equal(totpCode(secret, Math.floor(1111111109 / 30)), "081804");

  const now = new Date("2026-11-14T09:00:00Z");
  const step = currentStep(now);
  assert.equal(verifyTotp(secret, totpCode(secret, step), { now }), step);
  assert.equal(verifyTotp(secret, totpCode(secret, step - 1), { now }), step - 1, "a phone 30 seconds late still works");
  assert.equal(verifyTotp(secret, totpCode(secret, step - 3), { now }), null, "an old code does not");
  assert.equal(verifyTotp(secret, totpCode(secret, step), { now, lastStep: step }), null, "a code already used is refused");
  assert.equal(verifyTotp(secret, "12345", { now }), null);
});

test("each recovery code works once", () => {
  const codes = createRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every((code) => /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(code)));
  const hashes = codes.map(hashRecoveryCode);
  const left = useRecoveryCode(hashes, codes[3].toLowerCase().replace("-", ""));
  assert.equal(left.length, 9);
  assert.equal(useRecoveryCode(left, codes[3]), null);
});

async function signedUpApp(t, now) {
  const repository = new InMemoryRepository();
  repository.upsertUser({ id: "hiba", name: "Hiba", email: "hiba@exemple.ma", role: "leader" });
  repository.setUserPassword("hiba", await hashPassword(PASSWORD));
  const app = buildApi({ repository, clock: () => now.value, security: createSecurityConfig({ NODE_ENV: "production", RATE_LIMIT_LOGIN_MAX: "100" }) });
  t.after(() => app.close());
  return { app, repository };
}

const login = (app, body) => app.inject({ method: "POST", url: "/api/auth/login", payload: body });
const call = (app, token, method, url, payload) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } });

test("turned on with a code from the app, two-step sign-in then asks for a code after the password", async (t) => {
  const now = { value: new Date("2026-11-14T09:00:00Z") };
  const { app, repository } = await signedUpApp(t, now);
  const token = JSON.parse((await login(app, { email: "hiba@exemple.ma", password: PASSWORD })).body).token;

  assert.deepEqual(JSON.parse((await call(app, token, "GET", "/api/auth/two-factor")).body), { enabled: false, enabledAt: null, recoveryCodesLeft: 0 });
  const setup = JSON.parse((await call(app, token, "POST", "/api/auth/two-factor/setup")).body);
  assert.match(setup.uri, /^otpauth:\/\/totp\/H-KIDS%20Cockpit%3Ahiba%40exemple\.ma\?secret=[A-Z2-7]{32}&issuer=H-KIDS%20Cockpit/);
  assert.match(setup.qrSvg, /^<svg/);
  const secret = setup.secret.replace(/ /g, "");

  const wrong = await call(app, token, "POST", "/api/auth/two-factor/enable", { code: "000000" });
  assert.equal(wrong.statusCode, 400);
  assert.equal((await login(app, { email: "hiba@exemple.ma", password: PASSWORD })).statusCode, 200, "not on until a code is typed back");

  const enabled = await call(app, token, "POST", "/api/auth/two-factor/enable", { code: totpCode(secret, currentStep(now.value)) });
  assert.equal(enabled.statusCode, 200, enabled.body);
  const { recoveryCodes } = JSON.parse(enabled.body);
  assert.equal(recoveryCodes.length, 10);
  const stored = await repository.getTwoFactor("hiba");
  assert.ok(!JSON.stringify(stored.recoveryCodeHashes).includes(recoveryCodes[0]), "only hashes are kept");

  const passwordOnly = await login(app, { email: "hiba@exemple.ma", password: PASSWORD });
  assert.equal(passwordOnly.statusCode, 401);
  assert.equal(JSON.parse(passwordOnly.body).details.code, "TWO_FACTOR_REQUIRED");
  assert.equal(JSON.parse((await login(app, { email: "hiba@exemple.ma", password: PASSWORD, code: "123456" })).body).details.code, "INVALID_TWO_FACTOR");
  const badPassword = await login(app, { email: "hiba@exemple.ma", password: "example-mauvais-mdp", code: "123456" });
  assert.equal(JSON.parse(badPassword.body).details.code, "INVALID_LOGIN", "the code is asked only after the right password");

  now.value = new Date(now.value.getTime() + 60_000);
  const code = totpCode(secret, currentStep(now.value));
  assert.equal((await login(app, { email: "hiba@exemple.ma", password: PASSWORD, code })).statusCode, 200);
  assert.equal((await login(app, { email: "hiba@exemple.ma", password: PASSWORD, code })).statusCode, 401, "the same code does not open a second session");

  assert.equal((await login(app, { email: "hiba@exemple.ma", password: PASSWORD, code: recoveryCodes[0] })).statusCode, 200, "a recovery code opens a session");
  assert.equal((await login(app, { email: "hiba@exemple.ma", password: PASSWORD, code: recoveryCodes[0] })).statusCode, 401, "once");
  assert.equal(JSON.parse((await call(app, token, "GET", "/api/auth/two-factor")).body).recoveryCodesLeft, 9);
  assert.equal((await call(app, token, "POST", "/api/auth/two-factor/setup")).statusCode, 409, "a second app is not set up over the first");

  const events = repository.listAuditEvents().map((event) => event.type);
  assert.ok(events.includes("two_factor_enabled"));
  assert.ok(events.includes("recovery_code_used"));
});

test("turning it off takes the password and a code", async (t) => {
  const now = { value: new Date("2026-11-14T09:00:00Z") };
  const { app } = await signedUpApp(t, now);
  const token = JSON.parse((await login(app, { email: "hiba@exemple.ma", password: PASSWORD })).body).token;
  const secret = JSON.parse((await call(app, token, "POST", "/api/auth/two-factor/setup")).body).secret.replace(/ /g, "");
  await call(app, token, "POST", "/api/auth/two-factor/enable", { code: totpCode(secret, currentStep(now.value)) });

  now.value = new Date(now.value.getTime() + 30_000);
  const code = totpCode(secret, currentStep(now.value));
  assert.equal((await call(app, token, "POST", "/api/auth/two-factor/disable", { password: "example-mauvais-mdp", code })).statusCode, 400);
  assert.equal((await call(app, token, "POST", "/api/auth/two-factor/disable", { password: PASSWORD, code })).statusCode, 200);
  assert.equal((await login(app, { email: "hiba@exemple.ma", password: PASSWORD })).statusCode, 200, "the password alone opens again");
});
