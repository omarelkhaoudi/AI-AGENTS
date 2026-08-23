import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_N8N_TIMEOUT_MS,
  WorkflowBoundaryError,
  createN8nConfig,
  loadFoundationConfig
} from "../src/index.js";

const SECRET = "token-de-test-jamais-committe";

const FULL_ENV = Object.freeze({
  WORKFLOW_PROVIDER: "n8n",
  WORKFLOW_BASE_URL: "https://example.test",
  WORKFLOW_ENABLED: "true",
  N8N_WEBHOOK_PATH: "delay-alert",
  N8N_API_KEY_HEADER: "X-AI-Agents-Token",
  N8N_API_KEY: SECRET,
  N8N_TIMEOUT_MS: "7000"
});

function expectRefusal(env, options, code) {
  assert.throws(
    () => createN8nConfig(env, options),
    (error) => {
      assert.ok(error instanceof WorkflowBoundaryError, `${code}: wrong error type`);
      assert.equal(error.code, code);
      return true;
    },
    code
  );
}

test("nothing is required while the boundary is off", () => {
  const config = createN8nConfig({});

  assert.equal(config.enabled, false);
  assert.equal(config.webhookPath, null);
  assert.equal(config.apiKeyHeader, null);
  assert.equal(config.hasApiKey, false);
  assert.equal(config.timeoutMs, DEFAULT_N8N_TIMEOUT_MS);
});

test("the timeout defaults to five seconds and is read when given", () => {
  assert.equal(createN8nConfig({}).timeoutMs, DEFAULT_N8N_TIMEOUT_MS);
  assert.equal(createN8nConfig({ N8N_TIMEOUT_MS: "" }).timeoutMs, DEFAULT_N8N_TIMEOUT_MS);
  assert.equal(createN8nConfig({ N8N_TIMEOUT_MS: "2500" }).timeoutMs, 2500);
});

// Silently replacing a wrong value would hide the very thing the operator got
// wrong, and an orchestration step would hang on a timeout nobody chose.
test("a meaningless timeout is refused rather than replaced", () => {
  for (const timeout of ["0", "-1", "abc", "1.5", "1e5x"]) {
    expectRefusal({ N8N_TIMEOUT_MS: timeout }, {}, "N8N_TIMEOUT_INVALID");
  }
});

test("enabling n8n requires the webhook path, the header and the token", () => {
  const enabled = { enabled: true };

  expectRefusal({ ...FULL_ENV, N8N_WEBHOOK_PATH: "" }, enabled, "N8N_SETTING_REQUIRED");
  expectRefusal({ ...FULL_ENV, N8N_API_KEY_HEADER: "  " }, enabled, "N8N_SETTING_REQUIRED");
  expectRefusal({ ...FULL_ENV, N8N_API_KEY: undefined }, enabled, "N8N_SETTING_REQUIRED");
});

test("the refusal names the setting that is missing", () => {
  assert.throws(
    () => createN8nConfig({ ...FULL_ENV, N8N_WEBHOOK_PATH: "" }, { enabled: true }),
    (error) => {
      assert.equal(error.details.setting, "N8N_WEBHOOK_PATH");
      return true;
    }
  );
});

test("an enabled configuration reads what it was given", () => {
  const config = createN8nConfig(FULL_ENV, { enabled: true });

  assert.equal(config.enabled, true);
  assert.equal(config.webhookPath, "delay-alert");
  assert.equal(config.apiKeyHeader, "X-AI-Agents-Token");
  assert.equal(config.timeoutMs, 7000);
});

// This object reaches logs and error payloads, and redact() masks by key name.
// The safest key is one that is never there at all.
test("the token value never leaves the configuration", () => {
  const config = createN8nConfig(FULL_ENV, { enabled: true });

  assert.equal(config.hasApiKey, true);
  assert.equal("apiKey" in config, false);
  assert.equal(Object.values(config).includes(SECRET), false);
  assert.equal(JSON.stringify(config).includes(SECRET), false);
  assert.deepEqual(Object.keys(config).sort(), [
    "apiKeyHeader",
    "enabled",
    "hasApiKey",
    "timeoutMs",
    "webhookPath"
  ]);
});

test("hasApiKey reports absence rather than pretending", () => {
  assert.equal(createN8nConfig({}).hasApiKey, false);
  assert.equal(createN8nConfig({ N8N_API_KEY: "   " }).hasApiKey, false);
  assert.equal(createN8nConfig({ N8N_API_KEY: SECRET }).hasApiKey, true);
});

test("the application starts fully configured for n8n", () => {
  const config = loadFoundationConfig({ NODE_ENV: "test", ...FULL_ENV });

  assert.equal(config.workflow.provider, "n8n");
  assert.equal(config.workflow.enabled, true);
  assert.equal(config.n8n.enabled, true);
  assert.equal(config.n8n.webhookPath, "delay-alert");
  assert.equal(config.n8n.hasApiKey, true);
  assert.equal(JSON.stringify(config).includes(SECRET), false);
});

test("the application refuses to start half configured for n8n", () => {
  assert.throws(
    () => loadFoundationConfig({ NODE_ENV: "test", ...FULL_ENV, N8N_API_KEY: "" }),
    (error) => error instanceof WorkflowBoundaryError && error.code === "N8N_SETTING_REQUIRED"
  );
});

// An application running on the mock provider must start without anyone
// configuring a workflow they do not use.
test("the default configuration needs no n8n setting at all", () => {
  const config = loadFoundationConfig({ NODE_ENV: "test" });

  assert.equal(config.workflow.provider, "mock");
  assert.equal(config.workflow.enabled, false);
  assert.equal(config.n8n.enabled, false);
  assert.equal(config.n8n.hasApiKey, false);
});

// Enabling workflows on the mock provider is refused by the boundary itself,
// and n8n settings stay unnecessary either way.
test("n8n settings stay optional while the provider is not n8n", () => {
  const config = loadFoundationConfig({ NODE_ENV: "test", WORKFLOW_PROVIDER: "mock" });

  assert.equal(config.n8n.enabled, false);
  assert.equal(config.n8n.webhookPath, null);
});
