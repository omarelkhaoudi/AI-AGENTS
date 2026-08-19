import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_SECRET_LENGTH,
  containsPotentialSecret,
  findPotentialSecrets,
  isLikelySecretValue,
  runSecretScan
} from "../scripts/scan-secrets.mjs";

// Secret-looking values are assembled at runtime so this test file never
// contains a literal that the scanner would legitimately flag.
const OPENAI_STYLE_KEY = ["sk", "aBcD3fGh1jKlMn0pQrStUvWxYz123456"].join("-");
const AWS_STYLE_KEY = "AKIA" + "J7QK4XZ2NM8PLW3R";
const HIGH_ENTROPY_VALUE = ["a7Kd93", "Lm2Qp8", "Xz51Vb", "6Nt4Rc"].join("");
const PRIVATE_KEY_HEADER = ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" ");

test("scan does not flag short business identifiers used by the sync contract", () => {
  assert.equal(containsPotentialSecret('syncToken: "sync-001"'), false);
  assert.equal(containsPotentialSecret('syncToken: "sync-002"'), false);
  assert.equal(containsPotentialSecret('{ "token": "abc-123" }'), false);
  assert.equal(containsPotentialSecret("const requestToken = 'req-42';"), false);
});

test("scan does not flag references, placeholders, or prose", () => {
  assert.equal(containsPotentialSecret("apiKey: process.env.OPENAI_API_KEY"), false);
  assert.equal(containsPotentialSecret('apiKey: "${OPENAI_API_KEY}"'), false);
  assert.equal(containsPotentialSecret('OPENAI_API_KEY=""'), false);
  assert.equal(containsPotentialSecret('password: "your-password-here"'), false);
  assert.equal(containsPotentialSecret('apiKey: "example-api-key-value"'), false);
  assert.equal(containsPotentialSecret('secret: "replace this with a real value"'), false);
});

test("scan still flags high-confidence credential formats", () => {
  assert.equal(containsPotentialSecret(`const key = "${OPENAI_STYLE_KEY}";`), true);
  assert.equal(containsPotentialSecret(`const key = "${AWS_STYLE_KEY}";`), true);
  assert.equal(containsPotentialSecret(PRIVATE_KEY_HEADER), true);
});

test("scan still flags realistic hardcoded secret assignments", () => {
  assert.equal(containsPotentialSecret(`apiKey: "${HIGH_ENTROPY_VALUE}"`), true);
  assert.equal(containsPotentialSecret(`password = '${HIGH_ENTROPY_VALUE}'`), true);
  assert.equal(containsPotentialSecret(`OPENAI_API_KEY="${HIGH_ENTROPY_VALUE}"`), true);
  assert.equal(containsPotentialSecret(`clientSecret: \`${HIGH_ENTROPY_VALUE}\``), true);
});

test("secret scoring requires credential length and entropy", () => {
  assert.equal(isLikelySecretValue("sync-001"), false);
  assert.equal(isLikelySecretValue("a".repeat(MIN_SECRET_LENGTH)), false);
  assert.equal(isLikelySecretValue("1234567890123456"), false);
  assert.equal(isLikelySecretValue(HIGH_ENTROPY_VALUE), true);
});

test("findings describe why a value was reported", () => {
  const findings = findPotentialSecrets(`apiKey: "${HIGH_ENTROPY_VALUE}"`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "secret_assignment");
  assert.equal(findings[0].name, "apiKey");
});

test("the repository itself contains no detected secret", async () => {
  const findings = await runSecretScan();

  assert.deepEqual(findings, []);
});
