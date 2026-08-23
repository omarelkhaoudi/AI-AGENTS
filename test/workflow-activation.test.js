import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKFLOW_PROVIDERS,
  WorkflowBoundaryError,
  WorkflowClient,
  createWorkflowConfig,
  loadFoundationConfig
} from "../src/index.js";

// The workflow boundary refused every activation, so the application could not
// even start with WORKFLOW_ENABLED=true. Activation is possible now, and these
// tests pin what it costs: the mock provider stays offline, n8n needs somewhere
// to call, and enabling the configuration opens no connection at all.

const N8N_BASE_URL = "http://localhost:5678";

function expectRefusal(options, code) {
  assert.throws(
    () => createWorkflowConfig(options),
    (error) => {
      assert.ok(error instanceof WorkflowBoundaryError, `${code}: wrong error type`);
      assert.equal(error.code, code);
      return true;
    },
    code
  );
}

test("everything is off by default, without anyone asking for it", () => {
  const config = createWorkflowConfig();

  assert.equal(config.provider, "mock");
  assert.equal(config.enabled, false);
  assert.equal(config.externalConnectionsEnabled, false);
  assert.equal(config.status, "offline_mock");
});

test("the mock provider cannot be enabled, whatever the caller asks", () => {
  expectRefusal({ enabled: true }, "WORKFLOW_PROVIDER_CANNOT_BE_ENABLED");
  expectRefusal({ provider: "mock", enabled: true }, "WORKFLOW_PROVIDER_CANNOT_BE_ENABLED");
  expectRefusal({ provider: "mock", baseUrl: N8N_BASE_URL, enabled: true }, "WORKFLOW_PROVIDER_CANNOT_BE_ENABLED");
});

test("n8n activates when it is given somewhere to call", () => {
  const config = createWorkflowConfig({ provider: "n8n", baseUrl: N8N_BASE_URL, enabled: true });

  assert.equal(config.provider, "n8n");
  assert.equal(config.enabled, true);
  assert.equal(config.externalConnectionsEnabled, true);
  assert.equal(config.baseUrl, N8N_BASE_URL);
});

// Enabled is a configuration state, not a connection. Calling it connected
// would claim something no code has verified.
test("an enabled boundary reports that nothing has been verified", () => {
  const enabled = createWorkflowConfig({ provider: "n8n", baseUrl: N8N_BASE_URL, enabled: true });
  const prepared = createWorkflowConfig({ provider: "n8n", baseUrl: N8N_BASE_URL });

  assert.equal(enabled.status, "enabled_not_verified");
  assert.equal(prepared.status, "contract_prepared_not_connected");
  assert.equal(prepared.enabled, false);
});

test("n8n cannot be enabled without a base url", () => {
  expectRefusal({ provider: "n8n", enabled: true }, "WORKFLOW_BASE_URL_REQUIRED");
  expectRefusal({ provider: "n8n", baseUrl: null, enabled: true }, "WORKFLOW_BASE_URL_REQUIRED");
  expectRefusal({ provider: "n8n", baseUrl: "", enabled: true }, "WORKFLOW_BASE_URL_REQUIRED");
  expectRefusal({ provider: "n8n", baseUrl: "   ", enabled: true }, "WORKFLOW_BASE_URL_REQUIRED");
});

test("a base url that cannot be called is refused, not stored", () => {
  for (const baseUrl of ["ftp://localhost:5678", "localhost:5678", "not a url", "file:///etc/passwd", 5678]) {
    expectRefusal({ provider: "n8n", baseUrl, enabled: true }, "WORKFLOW_BASE_URL_REQUIRED");
  }

  assert.equal(createWorkflowConfig({ provider: "n8n", baseUrl: "https://example.test", enabled: true }).enabled, true);
});

// Reading an environment variable is the caller's job. A half-parsed flag must
// never be enough to open a door.
test("a non boolean enabled flag is refused rather than coerced", () => {
  for (const enabled of ["true", "false", 1, 0, "yes", {}]) {
    expectRefusal({ provider: "n8n", baseUrl: N8N_BASE_URL, enabled }, "WORKFLOW_ENABLED_INVALID");
  }
});

test("an unsupported provider is still refused", () => {
  expectRefusal({ provider: "zapier" }, "WORKFLOW_PROVIDER_UNSUPPORTED");
  assert.deepEqual([...WORKFLOW_PROVIDERS], ["mock", "n8n"]);
});

// The reason this lot exists: WORKFLOW_ENABLED=true used to crash startup.
test("the application starts with the workflow boundary enabled", () => {
  const config = loadFoundationConfig({
    NODE_ENV: "test",
    WORKFLOW_PROVIDER: "n8n",
    WORKFLOW_BASE_URL: N8N_BASE_URL,
    WORKFLOW_ENABLED: "true",
    // Enabling n8n also requires its own settings, checked by createN8nConfig.
    N8N_WEBHOOK_PATH: "delay-alert",
    N8N_API_KEY_HEADER: "X-AI-Agents-Token",
    N8N_API_KEY: "token-de-test"
  });

  assert.equal(config.workflow.provider, "n8n");
  assert.equal(config.workflow.enabled, true);
  assert.equal(config.workflow.status, "enabled_not_verified");
});

test("the application refuses to start when n8n is enabled with nowhere to call", () => {
  assert.throws(
    () => loadFoundationConfig({ NODE_ENV: "test", WORKFLOW_PROVIDER: "n8n", WORKFLOW_ENABLED: "true" }),
    (error) => error instanceof WorkflowBoundaryError && error.code === "WORKFLOW_BASE_URL_REQUIRED"
  );
});

test("the application still starts with everything off, which is the default", () => {
  const config = loadFoundationConfig({ NODE_ENV: "test" });

  assert.equal(config.workflow.provider, "mock");
  assert.equal(config.workflow.enabled, false);
  assert.equal(config.workflow.externalConnectionsEnabled, false);
});

// The point of this commit: activation is expressible, and nothing calls out.
test("enabling the boundary opens no outbound call", async () => {
  const client = new WorkflowClient(
    createWorkflowConfig({ provider: "n8n", baseUrl: N8N_BASE_URL, enabled: true })
  );

  await assert.rejects(() => client.invoke(), /not implemented in Phase 0/);
});
