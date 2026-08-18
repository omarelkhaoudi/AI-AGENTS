import assert from "node:assert/strict";
import test from "node:test";
import {
  BUSINESS_DATA_SOURCES,
  BUSINESS_DOMAIN_ALIASES,
  BusinessMemoryError,
  InMemoryRepository,
  ToolExecutionService,
  assertBusinessRecordContract,
  buildApi,
  createBusinessMemoryRepository,
  createBusinessRecord,
  createBusinessSource,
  createDemoBusinessMemoryRepository,
  createMvpToolRegistry,
  createPermission,
  normalizeBusinessDomain
} from "../src/index.js";

test("business domain aliases expose stable business names without changing stored domains", () => {
  assert.deepEqual(BUSINESS_DOMAIN_ALIASES, {
    purchasing: "purchase_needs",
    after_sales: "after_sales_tickets"
  });
  assert.equal(normalizeBusinessDomain("purchasing"), "purchase_needs");
  assert.equal(normalizeBusinessDomain("after_sales"), "after_sales_tickets");

  const memory = createDemoBusinessMemoryRepository();
  const purchasingRecords = memory.listBusinessRecords({ domain: "purchasing", agentId: "purchasing" });
  const afterSalesRecords = memory.listBusinessRecords({ domain: "after_sales", agentId: "after_sales" });

  assert.equal(purchasingRecords.length, 2);
  assert.equal(afterSalesRecords.length, 3);
  assert.equal(purchasingRecords.every((record) => record.domain === "purchase_needs"), true);
  assert.equal(afterSalesRecords.every((record) => record.domain === "after_sales_tickets"), true);
});

test("business record contract keeps provider-specific shapes inside data", () => {
  const record = createBusinessRecord({
    id: "record-contract-001",
    domain: "purchasing",
    recordType: "purchase_need",
    source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
    status: "open",
    data: {
      providerSpecificPayload: {
        nested: true
      }
    },
    metadata: {
      provider: "offline-test"
    }
  });

  assert.equal(assertBusinessRecordContract(record), true);
  assert.deepEqual(Object.keys(record), ["id", "domain", "recordType", "status", "source", "data", "relations", "dates", "metadata"]);
  assert.equal(record.id, "record-contract-001");
  assert.equal(record.domain, "purchase_needs");
  assert.equal(record.source, BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA);
  assert.deepEqual(record.data.providerSpecificPayload, { nested: true });
  assert.equal(record.metadata.provider, "offline-test");
  assert.throws(
    () => assertBusinessRecordContract({ id: "missing-fields" }),
    (error) => error instanceof BusinessMemoryError && error.code === "UNKNOWN_BUSINESS_DOMAIN"
  );
});

test("business source contract reads normalized demo records by domain and generic filters", () => {
  const source = createBusinessSource();

  assert.equal(source.getSourceDescriptor().provider, "demo");
  assert.equal(source.listBusinessRecords({ domain: "payments" }).length, 2);
  assert.equal(source.listBusinessRecords({ domain: "payments", filters: { status: "expected" } }).length, 2);
  assert.deepEqual(source.listBusinessRecords({
    domain: "payments",
    filters: {
      data: { invoiceId: "invoice-atlas-deposit" },
      metadata: { draft: true }
    }
  }).map((record) => record.id), ["payment-atlas-deposit"]);
  assert.deepEqual(source.listBusinessRecords({ domain: "purchasing" }).map((record) => record.id), [
    "purchase-aluminum-a",
    "purchase-packaging-b"
  ]);
});

test("business memory filters by agentId and source before generic MVP filters", () => {
  const memory = createDemoBusinessMemoryRepository();

  assert.deepEqual(
    memory.listBusinessRecords({
      domain: "payments",
      agentId: "finance",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      filters: {
        ids: ["payment-nova-balance"],
        status: "expected",
        data: { currency: "MAD" },
        metadata: { draft: true }
      }
    }).map((record) => record.id),
    ["payment-nova-balance"]
  );
  assert.deepEqual(
    memory.listBusinessRecordsByDomain({
      agentId: "finance",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      filters: { status: "expected" }
    }).payments.map((record) => record.id),
    ["payment-atlas-deposit", "payment-nova-balance"]
  );
  assert.throws(
    () => memory.listBusinessRecords({
      domain: "payments",
      agentId: "marketing",
      filters: { ids: ["payment-atlas-deposit"] }
    }),
    (error) => error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED"
  );
});

test("future real data remains offline and separated from demo data", () => {
  const memory = createBusinessMemoryRepository({
    env: {
      BUSINESS_DATA_PROVIDER: "future_real_data",
      BUSINESS_DATA_SOURCE_ID: "future-read-contract"
    }
  });

  assert.equal(memory.getBusinessDataSource().provider, "future_real_data");
  assert.equal(memory.getBusinessDataSource().externalConnectionsEnabled, false);
  assert.deepEqual(memory.listBusinessRecords({ domain: "payments", agentId: "finance", source: "future_real_data" }), []);
  assert.deepEqual(memory.listBusinessRecords({ domain: "payments", agentId: "finance", source: "demo_mock" }), []);
});

test("MVP overview, finance, and commercial tools keep current demo outputs", async () => {
  const repository = new InMemoryRepository();
  const registry = createMvpToolRegistry({ repository });

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
  assert.equal([overview, payments, quotes].every((result) => result.output.dataSource === BUSINESS_DATA_SOURCES.DEMO_MOCK), true);
});

test("Director still completes the company overview request through demo tools", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/director/requests",
    payload: {
      message: "Fais-moi le point complet de l'entreprise aujourd'hui."
    }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 201);
  assert.equal(body.status, "completed");
  assert.deepEqual(body.results.map((result) => result.agent), ["finance", "commercial", "production", "purchasing", "after_sales"]);
  assert.equal(body.results.every((result) => result.result?.demo === true), true);
  assert.equal(body.audit.filter((event) => event.type === "tool_called").length, 5);
});

test("Director payment request creates approval and never auto-executes payment", async (t) => {
  const repository = new InMemoryRepository();
  const app = buildApi({ repository });
  t.after(() => app.close());

  const response = await app.inject({
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
  assert.equal(body.decisionsRequired[0].type, "approval");
  assert.equal(body.audit.some((event) => event.type === "approval_requested"), true);
  assert.equal(body.audit.some((event) => event.type === "tool_called"), false);
});

async function executeReadTool(registry, toolId, agentId) {
  return registry.execute(toolId, {
    agentId,
    agentPermissions: [createPermission({ kind: "read_analyze", resource: "request:*" })],
    requestId: `req-${toolId}`,
    audit: false
  }, {
    requestId: `req-${toolId}`
  });
}
