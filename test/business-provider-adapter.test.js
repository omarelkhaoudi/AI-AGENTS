import assert from "node:assert/strict";
import test from "node:test";
import {
  createMvpAgentPermissions,
  BUSINESS_DATA_SOURCES,
  BUSINESS_DOMAINS,
  BusinessMemoryError,
  BusinessProviderAdapterContractError,
  BusinessSourceContractError,
  DemoBusinessProviderAdapter,
  FutureRealDataProviderAdapter,
  InMemoryRepository,
  ToolExecutionService,
  assertBusinessProviderAdapterContract,
  buildApi,
  createBusinessDataSourceDescriptor,
  createBusinessMemoryRepository,
  createBusinessProviderDescriptor,
  createBusinessProviderAdapter,
  createBusinessRecord,
  createBusinessSource,
  createMvpToolRegistry,
  normalizeBusinessProviderAdapter,
  createPermission
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

test("BusinessProviderAdapter contract accepts valid adapters and rejects invalid ones", () => {
  const adapter = new DemoBusinessProviderAdapter();

  assert.equal(assertBusinessProviderAdapterContract(adapter), true);
  assert.throws(
    () => assertBusinessProviderAdapterContract({ listBusinessDomains: () => [] }),
    (error) =>
      error instanceof BusinessProviderAdapterContractError &&
      error.code === "INVALID_BUSINESS_PROVIDER_ADAPTER"
  );
});

test("BusinessProviderAdapter factory is configurable but only exposes offline adapters", () => {
  const demo = createBusinessProviderAdapter({
    adapter: "demo",
    provider: "demo",
    sourceId: "demo"
  });
  const future = createBusinessProviderAdapter({
    adapter: "future_real_data",
    provider: "future_real_data",
    sourceId: "future-configured"
  });

  assert.ok(demo instanceof DemoBusinessProviderAdapter);
  assert.ok(future instanceof FutureRealDataProviderAdapter);
  assert.equal(normalizeBusinessProviderAdapter("demo"), "demo");
  assert.equal(future.getProviderDescriptor().adapter, "future_real_data");
  assert.equal(future.getProviderDescriptor().adapterStatus, "offline_configured");
  assert.equal(future.getProviderDescriptor().externalConnectionsEnabled, false);
  assert.deepEqual(future.listBusinessRecords({ domain: "payments" }), []);
  assert.throws(
    () => createBusinessProviderAdapter({ adapter: "real_crm", provider: "future_real_data" }),
    (error) =>
      error instanceof BusinessProviderAdapterContractError &&
      error.code === "INVALID_BUSINESS_PROVIDER_ADAPTER"
  );
  assert.throws(
    () => createBusinessProviderAdapter({ adapter: "future_real_data", provider: "demo" }),
    (error) =>
      error instanceof BusinessProviderAdapterContractError &&
      error.code === "INCOMPATIBLE_BUSINESS_PROVIDER_ADAPTER"
  );
  assert.throws(
    () => createBusinessProviderAdapter({ adapter: "demo", provider: "future_real_data" }),
    (error) =>
      error instanceof BusinessProviderAdapterContractError &&
      error.code === "INCOMPATIBLE_BUSINESS_PROVIDER_ADAPTER"
  );
});

test("DemoBusinessProviderAdapter exposes provider descriptor, domains, and normalized records", () => {
  const adapter = new DemoBusinessProviderAdapter();
  const descriptor = adapter.getProviderDescriptor();
  const payments = adapter.listBusinessRecords({ domain: "payments" });

  assert.equal(descriptor.provider, "demo");
  assert.equal(descriptor.sourceId, "demo");
  assert.equal(descriptor.adapter, "demo");
  assert.equal(descriptor.adapterStatus, "offline_configured");
  assert.equal(descriptor.recordSource, BUSINESS_DATA_SOURCES.DEMO_MOCK);
  assert.equal(descriptor.externalConnectionsEnabled, false);
  assert.deepEqual(adapter.listBusinessDomains(), BUSINESS_DOMAINS);
  assert.deepEqual(payments.map((record) => record.id), ["payment-atlas-deposit", "payment-nova-balance"]);
  assert.equal(payments.every((record) =>
    record.domain === "payments" &&
    record.source === BUSINESS_DATA_SOURCES.DEMO_MOCK &&
    record.data.invoiceId &&
    record.metadata.draft === true
  ), true);
  assert.deepEqual(adapter.listBusinessRecordsByDomain().quotes.map((record) => record.id), [
    "quote-atlas-001",
    "quote-solar-002"
  ]);
});

test("FutureRealDataProviderAdapter is valid, offline, empty, and does not expose demo data", () => {
  const adapter = new FutureRealDataProviderAdapter({
    descriptor: createBusinessDataSourceDescriptor({
      provider: "future_real_data",
      sourceId: "future-provider"
    })
  });
  const descriptor = adapter.getProviderDescriptor();

  assert.equal(assertBusinessProviderAdapterContract(adapter), true);
  assert.equal(descriptor.provider, "future_real_data");
  assert.equal(descriptor.sourceId, "future-provider");
  assert.equal(descriptor.recordSource, BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA);
  assert.equal(descriptor.externalConnectionsEnabled, false);
  assert.deepEqual(adapter.listBusinessDomains(), BUSINESS_DOMAINS);
  assert.deepEqual(adapter.listBusinessRecords({ domain: "payments" }), []);
  assert.deepEqual(adapter.listBusinessRecordsByDomain().payments, []);
});

test("BusinessSource can read through an injected BusinessProviderAdapter", () => {
  const adapter = createSingleRecordAdapter();
  const source = createBusinessSource({ adapter });

  assert.equal(source.getSourceDescriptor().sourceId, "adapter-test");
  assert.deepEqual(source.listBusinessRecords({ domain: "payments" }).map((record) => record.id), ["adapter-payment-001"]);
  assert.deepEqual(source.listBusinessRecords({
    domain: "payments",
    source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
    filters: { data: { invoiceId: "adapter-invoice-001" } }
  }).map((record) => record.id), ["adapter-payment-001"]);
  assert.deepEqual(source.listBusinessRecords({ domain: "payments", source: BUSINESS_DATA_SOURCES.DEMO_MOCK }), []);
});

test("BusinessSource respects adapter-supported domains and rejects unsupported reads", () => {
  const source = createBusinessSource({ adapter: createSingleRecordAdapter({ supportedDomains: ["payments"] }) });

  assert.deepEqual(source.listBusinessDomains(), ["payments"]);
  assert.deepEqual(Object.keys(source.listBusinessRecordsByDomain()), ["payments"]);
  assert.deepEqual(source.listBusinessRecords({ domain: "payments" }).map((record) => record.id), ["adapter-payment-001"]);
  assert.throws(
    () => source.listBusinessRecords({ domain: "quotes" }),
    (error) =>
      error instanceof BusinessSourceContractError &&
      error.code === "UNSUPPORTED_BUSINESS_SOURCE_DOMAIN"
  );
});

test("BusinessMemoryRepository uses provider adapters without exposing them to MVP tools", async () => {
  const businessMemory = createBusinessMemoryRepository({
    businessProviderAdapter: createSingleRecordAdapter()
  });
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository, businessMemory })
  });

  const result = await service.execute({
    agentId: "finance",
    agentPermissions: createMvpAgentPermissions("finance"),
    toolId: "get_pending_payments",
    input: { requestId: "req-provider-adapter-tool" },
    requestId: "req-provider-adapter-tool"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.output.result.dataSource, BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA);
  assert.equal(result.output.result.sourceId, "adapter-test");
  assert.deepEqual(result.output.result.items.map((item) => item.id), ["adapter-payment-001"]);
});

test("provider adapters cannot bypass BusinessMemory domain permissions", () => {
  const memory = createBusinessMemoryRepository({
    businessProviderAdapter: createSingleRecordAdapter()
  });

  assert.throws(
    () => memory.listBusinessRecords({ domain: "payments", agentId: "marketing", source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA }),
    (error) => error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED"
  );
  assert.deepEqual(
    memory.listBusinessRecords({ domain: "payments", agentId: "finance", source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA }).map((record) => record.id),
    ["adapter-payment-001"]
  );
});

test("MVP demo tools keep existing behavior through DemoBusinessProviderAdapter", async () => {
  const businessMemory = createBusinessMemoryRepository({
    businessProviderAdapter: new DemoBusinessProviderAdapter()
  });
  const registry = createMvpToolRegistry({
    repository: new InMemoryRepository(),
    businessMemory
  });

  const overview = await executeReadTool(registry, "get_company_overview", "finance");
  const payments = await executeReadTool(registry, "get_pending_payments", "finance");
  const quotes = await executeReadTool(registry, "get_pending_quotes", "commercial");

  assert.deepEqual(overview.output.items.map((item) => item.label), [
    "Cash collection attention",
    "Commercial follow-ups",
    "Production delay risk",
    "Urgent purchase need",
    "Open after-sales case",
    "Legal attention"
  ]);
  assert.deepEqual(payments.output.items.map((item) => item.id), ["payment-atlas-deposit", "payment-nova-balance"]);
  assert.deepEqual(quotes.output.items.map((item) => item.id), ["quote-atlas-001", "quote-solar-002"]);
  assert.equal([overview, payments, quotes].every((result) => result.output.demo === true), true);
});

test("Director still completes the company overview request with adapter-backed demo data", async (t) => {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository });
  t.after(() => app.close());

  const response = await inject({
    method: "POST",
    url: "/api/director/requests",
    payload: {
      message: "Fais-moi le point complet de l'entreprise aujourd'hui."
    }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "completed");
  // finance, commercial, production and purchasing each contribute two steps
  // since Lot 2C commit 4: the historical tool then the computing one.
  assert.deepEqual(
    body.results.map((result) => result.agent),
    [
      "finance",
      "finance",
      "finance",
      "commercial",
      "commercial",
      "commercial",
      "production",
      "production",
      "purchasing",
      "purchasing",
      "hr",
      "after_sales",
      "marketing",
      "community_manager",
      "legal"
    ]
  );
  assert.deepEqual(
    [...new Set(body.results.map((result) => result.agent))],
    [
      "finance",
      "commercial",
      "production",
      "purchasing",
      "hr",
      "after_sales",
      "marketing",
      "community_manager",
      "legal"
    ]
  );
  assert.equal(body.results.every((result) => result.result?.demo === true), true);
});

test("Director payment request still creates approval and never calls payment tool", async (t) => {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository });
  t.after(() => app.close());

  const response = await inject({
    method: "POST",
    url: "/api/director/requests",
    payload: {
      message: "Effectue le paiement de cette facture."
    }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "requires_approval");
  assert.deepEqual(body.results.map((result) => result.tool), ["execute_invoice_payment"]);
  assert.equal(body.results[0].status, "not_executed");
  assert.equal(body.results[0].result, null);
  assert.equal(body.audit.some((event) => event.type === "approval_requested"), true);
  assert.equal(body.audit.some((event) => event.type === "tool_called"), false);
});

function createSingleRecordAdapter({ supportedDomains = BUSINESS_DOMAINS } = {}) {
  const descriptor = createBusinessProviderDescriptor({
    provider: "future_real_data",
    sourceId: "adapter-test",
    supportedDomains
  });
  const records = Object.freeze([
    createBusinessRecord({
      id: "adapter-payment-001",
      domain: "payments",
      recordType: "payment",
      status: "expected",
      source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
      data: {
        id: "adapter-payment-001",
        invoiceId: "adapter-invoice-001",
        status: "expected",
        amount: 42,
        currency: "MAD",
        providerPayload: {
          keptInsideData: true
        }
      },
      relations: {
        invoiceId: "adapter-invoice-001"
      },
      dates: {
        dueAt: "2026-08-20"
      },
      metadata: {
        adapter: "test",
        draft: true
      }
    })
  ]);

  return Object.freeze({
    getProviderDescriptor: () => descriptor,
    listBusinessDomains: () => [...supportedDomains],
    listBusinessRecords: ({ domain, filters = null } = {}) => records.filter((record) =>
      record.domain === domain &&
      (!filters?.data?.invoiceId || record.data.invoiceId === filters.data.invoiceId)
    ),
    listBusinessRecordsByDomain: ({ filters = null } = {}) => Object.freeze(Object.fromEntries(
      BUSINESS_DOMAINS.map((domain) => [
        domain,
        domain === "payments" ? records.filter((record) =>
          !filters?.data?.invoiceId || record.data.invoiceId === filters.data.invoiceId
        ) : Object.freeze([])
      ])
    ))
  });
}

async function executeReadTool(registry, toolId, agentId) {
  return registry.execute(toolId, {
    agentId,
    agentPermissions: createMvpAgentPermissions(agentId),
    requestId: `req-${toolId}`,
    audit: false
  }, {
    requestId: `req-${toolId}`
  });
}
