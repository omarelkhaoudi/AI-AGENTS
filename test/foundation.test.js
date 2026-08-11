import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentContractError,
  AgentRegistry,
  AiProviderClient,
  AiProviderError,
  DirectorExecutionError,
  DirectorOrchestrator,
  PERMISSION_KINDS,
  WorkflowBoundaryError,
  WorkflowClient,
  createAgentDefinition,
  createApprovalRequest,
  createDefaultAgentRegistry,
  createDirectorRequest,
  createPermission,
  createWorkflowConfig,
  loadFoundationConfig,
  redact,
  requiresHumanApproval,
  validateDelegationPlan
} from "../src/index.js";

test("validates the agent contract", () => {
  const agent = createAgentDefinition({
    id: "technical",
    name: "Technical",
    description: "Technical placeholder.",
    capabilities: [],
    tools: [],
    permissions: []
  });

  assert.equal(agent.id, "technical");
  assert.throws(
    () => createAgentDefinition({ id: "", name: "", description: "" }),
    AgentContractError
  );
});

test("registers and discovers the five MVP agent identities", () => {
  const registry = createDefaultAgentRegistry();
  assert.deepEqual(
    registry.list().map((agent) => agent.id),
    ["director", "commercial", "finance", "production", "purchasing"]
  );
  assert.equal(registry.has("finance"), true);
  assert.equal(registry.get("commercial").capabilities.length, 0);
});

test("rejects duplicate agent registration", () => {
  const registry = new AgentRegistry();
  const agent = createAgentDefinition({
    id: "director",
    name: "Director",
    description: "Placeholder."
  });
  registry.register(agent);
  assert.throws(() => registry.register(agent), /already registered/);
});

test("keeps director delegation and aggregation as technical contracts", async () => {
  const registry = createDefaultAgentRegistry();
  const director = new DirectorOrchestrator({
    registry,
    planner: async () => ({ steps: [{ stepId: "step-1", agentId: "finance" }] }),
    delegate: async ({ agent }) => ({
      agentId: agent.id,
      status: "completed",
      output: { acknowledged: true },
      metadata: { deterministic: true }
    }),
    logger: { info() {}, error() {} }
  });

  const result = await director.execute(createDirectorRequest({ requestId: "req-1" }));
  assert.equal(result.response.status, "completed");
  assert.equal(result.results[0].agentId, "finance");
  assert.equal(result.metadata.status, "completed");
});

test("validates director error boundaries", async () => {
  validateDelegationPlan({ steps: [] });
  assert.throws(() => validateDelegationPlan({}), DirectorExecutionError);

  const director = new DirectorOrchestrator({
    registry: createDefaultAgentRegistry(),
    planner: async () => ({ steps: [{ agentId: "missing" }] }),
    logger: { info() {}, error() {} }
  });

  await assert.rejects(
    () => director.execute(createDirectorRequest({ requestId: "req-error" })),
    /not registered/
  );
});

test("models technical permission kinds without final business grants", () => {
  assert.ok(PERMISSION_KINDS.includes("read_analyze"));
  const approvalPermission = createPermission({
    kind: "human_approval_required",
    resource: "technical-resource"
  });
  assert.equal(requiresHumanApproval(approvalPermission), true);
  assert.throws(() => createPermission({ kind: "pay_invoice" }), /Unknown permission kind/);
});

test("models human approval requests", () => {
  const approval = createApprovalRequest({
    requestedAction: "prepare technical action",
    requestingAgent: "director",
    reason: "Phase 0 approval boundary validation",
    affectedResource: "technical-resource",
    risk: "medium"
  });

  assert.equal(approval.status, "requested");
  assert.equal(approval.approver, null);
  assert.throws(
    () => createApprovalRequest({ requestedAction: "", requestingAgent: "director", reason: "x", affectedResource: "x" }),
    /requestedAction/
  );
});

test("validates workflow configuration and blocks invocation in Phase 0", async () => {
  assert.throws(() => createWorkflowConfig({ enabled: true }), WorkflowBoundaryError);
  const client = new WorkflowClient(createWorkflowConfig({ enabled: false }));
  await assert.rejects(() => client.invoke(), /not implemented in Phase 0/);
});

test("validates AI provider configuration and blocks external calls in Phase 0", async () => {
  assert.equal(loadFoundationConfig({ NODE_ENV: "test" }).aiProvider.enabled, false);
  assert.throws(
    () => loadFoundationConfig({ AI_PROVIDER_ENABLED: "true" }),
    AiProviderError
  );
  const client = new AiProviderClient();
  await assert.rejects(() => client.generate(), /not implemented in Phase 0/);
});

test("redacts sensitive fields from logs", () => {
  const cleaned = redact({
    apiKey: "x",
    nested: { password: "x", visible: "ok" }
  });

  assert.equal(cleaned.apiKey, "[REDACTED]");
  assert.equal(cleaned.nested.password, "[REDACTED]");
  assert.equal(cleaned.nested.visible, "ok");
});
