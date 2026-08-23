import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_PROVIDER_DOMAIN_ACCESS,
  BUSINESS_DATA_SOURCES,
  BusinessIntegrationContractError,
  BusinessProviderAdapterContractError,
  BusinessProviderBackedAdapter,
  BusinessProviderContractError,
  INTEGRATION_OPERATION_BOUNDARIES,
  INTEGRATION_PROVIDER_PROFILES,
  N8N_TOOL_ADAPTER_INTERFACE,
  WorkflowBoundaryError,
  assertBusinessProviderContract,
  assertIntegrationProviderDescriptor,
  createBusinessMemoryConfig,
  createBusinessProviderDescriptor,
  createBusinessRecord,
  createFutureProviderDescriptorForProfile,
  createWorkflowConfig,
  listIntegrationProviderProfiles,
  validateAgentProviderDomainAccess,
  validateIntegrationOperation
} from "../src/index.js";

test("integration provider profiles cover future real data sources without enabling connections", () => {
  assert.deepEqual(listIntegrationProviderProfiles().map((profile) => profile.id), [
    "crm",
    "accounting",
    "erp",
    "purchasing",
    "hr",
    "after_sales",
    "marketing_community",
    "documents_legal"
  ]);

  for (const profile of listIntegrationProviderProfiles()) {
    const descriptor = createFutureProviderDescriptorForProfile({
      profileId: profile.id,
      sourceId: `future-${profile.id}`
    });

    assert.equal(assertIntegrationProviderDescriptor(descriptor), true, profile.id);
    assert.equal(descriptor.provider, "future_real_data", profile.id);
    assert.equal(descriptor.recordSource, BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA, profile.id);
    assert.equal(descriptor.externalConnectionsEnabled, false, profile.id);
    assert.equal(descriptor.capabilities.readRecords, true, profile.id);
    assert.equal(descriptor.capabilities.writeRecords, false, profile.id);
    assert.deepEqual(descriptor.supportedDomains, profile.supportedDomains, profile.id);
  }
});

test("demo_mock and future_real_data remain strictly separated by configuration", () => {
  const demoConfig = createBusinessMemoryConfig({
    BUSINESS_DATA_PROVIDER: "demo",
    BUSINESS_PROVIDER_ADAPTER: "demo",
    BUSINESS_DATA_SOURCE_ID: "demo"
  });
  const futureConfig = createBusinessMemoryConfig({
    BUSINESS_DATA_PROVIDER: "future_real_data",
    BUSINESS_PROVIDER_ADAPTER: "future_real_data",
    BUSINESS_DATA_SOURCE_ID: "future-provider"
  });

  assert.equal(demoConfig.dataSource.provider, "demo");
  assert.equal(demoConfig.dataSource.externalConnectionsEnabled, false);
  assert.equal(futureConfig.dataSource.provider, "future_real_data");
  assert.equal(futureConfig.dataSource.externalConnectionsEnabled, false);
  assert.notEqual(demoConfig.dataSource.provider, futureConfig.dataSource.provider);
  assert.throws(
    () => createBusinessMemoryConfig({
      BUSINESS_DATA_PROVIDER: "demo",
      BUSINESS_PROVIDER_ADAPTER: "future_real_data"
    }),
    (error) =>
      error instanceof BusinessProviderAdapterContractError &&
      error.code === "INCOMPATIBLE_BUSINESS_PROVIDER_ADAPTER"
  );
});

test("read, analyze, prepare, approval, and execute boundaries are explicit and keep execution disabled", () => {
  assert.deepEqual(Object.keys(INTEGRATION_OPERATION_BOUNDARIES), [
    "read",
    "analyze",
    "prepare",
    "approval",
    "execute"
  ]);

  assert.equal(validateIntegrationOperation({ stage: "read" }).permissionKind, "read_analyze");
  assert.equal(validateIntegrationOperation({ stage: "analyze" }).permissionKind, "read_analyze");
  assert.equal(validateIntegrationOperation({ stage: "prepare" }).permissionKind, "prepare_action");
  assert.equal(validateIntegrationOperation({ stage: "approval" }).requiresHumanApproval, true);
  assert.throws(
    () => validateIntegrationOperation({
      stage: "execute",
      descriptor: createFutureProviderDescriptorForProfile({ profileId: "accounting" })
    }),
    (error) =>
      error instanceof BusinessIntegrationContractError &&
      error.code === "REAL_EXECUTION_DISABLED"
  );
});

test("agent to provider domain access follows CDC boundaries before provider reads", () => {
  assert.equal(validateAgentProviderDomainAccess({ agentId: "commercial", domain: "customers" }), true);
  assert.equal(validateAgentProviderDomainAccess({ agentId: "commercial", domain: "quotes" }), true);
  assert.equal(validateAgentProviderDomainAccess({ agentId: "finance", domain: "payments" }), true);
  assert.equal(validateAgentProviderDomainAccess({ agentId: "production", domain: "production" }), true);
  assert.equal(validateAgentProviderDomainAccess({ agentId: "purchasing", domain: "suppliers" }), true);
  assert.equal(validateAgentProviderDomainAccess({ agentId: "hr", domain: "hr_demo_overview" }), true);
  assert.equal(validateAgentProviderDomainAccess({ agentId: "after_sales", domain: "after_sales_tickets" }), true);

  assert.equal(AGENT_PROVIDER_DOMAIN_ACCESS.community_manager.supervisorAgentId, "marketing");
  assert.equal(AGENT_PROVIDER_DOMAIN_ACCESS.director.orchestratorOnly, true);

  for (const denied of [
    { agentId: "marketing", domain: "payments" },
    { agentId: "community_manager", domain: "payments" },
    { agentId: "community_manager", domain: "hr_demo_overview" },
    { agentId: "legal", domain: "payments" },
    { agentId: "hr", domain: "payments" },
    { agentId: "after_sales", domain: "payments" },
    { agentId: "director", domain: "payments" }
  ]) {
    assert.throws(
      () => validateAgentProviderDomainAccess(denied),
      (error) =>
        error instanceof BusinessIntegrationContractError &&
        error.code === "INTEGRATION_DOMAIN_ACCESS_DENIED",
      `${denied.agentId}:${denied.domain}`
    );
  }
});

test("misconfigured providers and incompatible records are rejected before tool execution", () => {
  assert.throws(
    () => assertIntegrationProviderDescriptor({
      ...createFutureProviderDescriptorForProfile({ profileId: "crm" }),
      provider: "demo",
      recordSource: BUSINESS_DATA_SOURCES.DEMO_MOCK
    }),
    (error) =>
      error instanceof BusinessIntegrationContractError &&
      error.code === "INVALID_INTEGRATION_PROVIDER_SOURCE"
  );

  assert.throws(
    () => createBusinessProviderDescriptor({
      capabilities: { writeRecords: true }
    }),
    (error) =>
      error instanceof BusinessProviderContractError &&
      error.code === "INVALID_BUSINESS_PROVIDER_DESCRIPTOR"
  );

  assert.throws(
    () => assertBusinessProviderContract({
      getProviderDescriptor: () => ({
        ...createFutureProviderDescriptorForProfile({ profileId: "crm" }),
        externalConnectionsEnabled: true
      }),
      listSupportedDomains: () => ["customers", "quotes", "orders"],
      readBusinessRecordsPage: () => ({ records: [] })
    }),
    (error) =>
      error instanceof BusinessProviderContractError &&
      error.code === "BUSINESS_PROVIDER_EXTERNAL_CONNECTION_FORBIDDEN"
  );

  assert.throws(
    () => new BusinessProviderBackedAdapter({
      provider: createWrongDomainProvider()
    }).listBusinessRecords({ domain: "payments" }),
    (error) => error instanceof BusinessProviderContractError && error.code === "INVALID_BUSINESS_PROVIDER_RECORD"
  );
});

// The n8n boundary used to refuse every activation, which meant the whole
// application failed to start with WORKFLOW_ENABLED=true. It can be activated
// now, deliberately and with somewhere to call. What has not changed is that
// activating the configuration connects nothing: no adapter exists, and the
// tool adapter interface stays offline.
test("the n8n boundary is off by default and activates only deliberately", () => {
  const defaultConfig = createWorkflowConfig();
  const preparedConfig = createWorkflowConfig({
    provider: "n8n",
    baseUrl: "http://localhost:5678"
  });

  assert.equal(defaultConfig.provider, "mock");
  assert.equal(defaultConfig.enabled, false);
  assert.equal(defaultConfig.externalConnectionsEnabled, false);
  assert.equal(preparedConfig.status, "contract_prepared_not_connected");
  assert.equal(preparedConfig.enabled, false);
  assert.equal(preparedConfig.externalConnectionsEnabled, false);

  const enabledConfig = createWorkflowConfig({
    provider: "n8n",
    baseUrl: "http://localhost:5678",
    enabled: true
  });

  assert.equal(enabledConfig.enabled, true);
  assert.equal(enabledConfig.externalConnectionsEnabled, true);
  // Enabled is not connected: nothing has been reached yet.
  assert.equal(enabledConfig.status, "enabled_not_verified");

  // The adapter is what would actually call n8n, and it does not exist.
  assert.equal(N8N_TOOL_ADAPTER_INTERFACE.externalConnectionsEnabled, false);
  assert.equal(N8N_TOOL_ADAPTER_INTERFACE.webhookEnabled, false);

  // Enabling n8n without somewhere to call is a configuration mistake.
  assert.throws(
    () => createWorkflowConfig({ provider: "n8n", enabled: true }),
    (error) =>
      error instanceof WorkflowBoundaryError &&
      error.code === "WORKFLOW_BASE_URL_REQUIRED"
  );
});

function createWrongDomainProvider() {
  return {
    getProviderDescriptor: () => createBusinessProviderDescriptor({
      provider: "future_real_data",
      sourceId: "wrong-domain-provider",
      supportedDomains: ["payments"]
    }),
    listSupportedDomains: () => ["payments"],
    readBusinessRecordsPage: () => ({
      records: [
        createBusinessRecord({
          id: "wrong-domain-record",
          domain: "quotes",
          recordType: "quote",
          source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
          data: { id: "wrong-domain-record" }
        })
      ]
    })
  };
}
