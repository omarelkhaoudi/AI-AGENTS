import assert from "node:assert/strict";
import test from "node:test";
import {
  createMvpAgentPermissions,
  BUSINESS_DATA_SOURCES,
  BUSINESS_DOMAINS,
  BUSINESS_DOMAIN_DEFINITIONS,
  BUSINESS_RECORD_CANONICAL_FIELDS,
  BusinessSourceContractError,
  FutureRealDataBusinessSource,
  BusinessMemoryError,
  demoDate,
  InMemoryRepository,
  ToolExecutionService,
  assertBusinessSourceContract,
  createBusinessSource,
  createBusinessMemoryRepository,
  createDemoBusinessMemoryRepository,
  createMvpToolRegistry,
  createPermission
} from "../src/index.js";

// Reference domains that are modelled and persistable but deliberately carry no
// demo record. Every other domain must carry demo records.
//
// Lot 2A.1 introduced five such domains.
// Lot 2B.2 populates products, stock and bills_of_material with synthetic data.
// The datasheet lot populates prices too: a quote cannot be prepared from a
// price list nobody filled. payment_terms stays a persistence foundation no
// tool reads, and listing it keeps that gap visible.
const REFERENCE_DOMAINS_WITHOUT_DEMO_DATA = Object.freeze([
  "payment_terms"
]);

test("business memory exposes the MVP structured domains from demo_mock data", () => {
  const memory = createDemoBusinessMemoryRepository();
  const descriptor = memory.getBusinessDataSource();

  assert.equal(descriptor.provider, "demo");
  assert.equal(descriptor.sourceId, "demo");
  assert.equal(descriptor.recordSource, BUSINESS_DATA_SOURCES.DEMO_MOCK);
  assert.equal(descriptor.demo, true);

  assert.deepEqual(memory.listBusinessDomains(), [
    "customers",
    "quotes",
    "invoices",
    "payments",
    "orders",
    "production",
    "purchase_needs",
    "suppliers",
    "hr_demo_overview",
    "after_sales_tickets",
    "products",
    "prices",
    "stock",
    "bills_of_material",
    "payment_terms"
  ]);

  for (const domain of BUSINESS_DOMAINS) {
    const records = memory.listBusinessRecords({ domain, agentId: "director" });

    if (REFERENCE_DOMAINS_WITHOUT_DEMO_DATA.includes(domain)) {
      // Reference domains are persistence foundations: they carry no demo data
      // and no tool reads them yet. Listing them explicitly keeps the gap
      // visible instead of letting a future domain silently ship empty.
      assert.equal(records.length, 0, domain);
      continue;
    }

    assert.equal(records.length > 0, true, domain);
    assert.equal(records.every((record) => record.source === BUSINESS_DATA_SOURCES.DEMO_MOCK), true, domain);
    assert.equal(records.every((record) => record.metadata.draft === true), true, domain);
    assert.equal(records.every((record) => record.domain === domain), true, domain);
  }
});

test("business source contract exposes demo data by domain before repository access rules", () => {
  const source = createBusinessSource();

  assert.equal(assertBusinessSourceContract(source), true);
  assert.deepEqual(source.listBusinessDomains(), BUSINESS_DOMAINS);
  assert.equal(source.getSourceDescriptor().provider, "demo");
  assert.equal(source.getSourceDescriptor().recordSource, BUSINESS_DATA_SOURCES.DEMO_MOCK);
  assert.equal(source.listBusinessRecords({ domain: "payments" }).length, 2);
  assert.equal(source.listBusinessRecordsByDomain().invoices.length, 2);
  assert.throws(
    () => assertBusinessSourceContract({ listBusinessDomains: () => [] }),
    (error) => error instanceof BusinessSourceContractError && error.code === "INVALID_BUSINESS_SOURCE"
  );
});

test("future real data source is explicit, offline, and does not mix with demo records", () => {
  const source = createBusinessSource({
    provider: "future_real_data",
    sourceId: "crm-placeholder"
  });

  assert.ok(source instanceof FutureRealDataBusinessSource);
  assert.equal(source.getSourceDescriptor().provider, "future_real_data");
  assert.equal(source.getSourceDescriptor().sourceId, "crm-placeholder");
  assert.equal(source.getSourceDescriptor().recordSource, BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA);
  assert.equal(source.getSourceDescriptor().externalConnectionsEnabled, false);
  assert.deepEqual(source.listBusinessRecords({ domain: "customers" }), []);
  assert.deepEqual(source.listBusinessRecordsByDomain().payments, []);
});

test("business memory records keep essential relations and dates explicit", () => {
  const memory = createDemoBusinessMemoryRepository();

  const quote = memory.getBusinessRecord({ domain: "quotes", id: "quote-atlas-001", agentId: "commercial" });
  const invoice = memory.getBusinessRecord({ domain: "invoices", id: "invoice-atlas-deposit", agentId: "finance" });
  const payment = memory.getBusinessRecord({ domain: "payments", id: "payment-atlas-deposit", agentId: "finance" });
  const production = memory.getBusinessRecord({ domain: "production", id: "order-atlas-001", agentId: "production" });
  const purchaseNeed = memory.getBusinessRecord({ domain: "purchase_needs", id: "purchase-aluminum-a", agentId: "purchasing" });
  const hrSignal = memory.getBusinessRecord({ domain: "hr_demo_overview", id: "hr-leave-demo-001", agentId: "hr" });
  const ticket = memory.getBusinessRecord({ domain: "after_sales_tickets", id: "case-sav-001", agentId: "after_sales" });

  assert.equal(quote.relations.customerId, "customer-atlas");
  assert.equal(invoice.relations.orderId, "order-atlas-001");
  // Two days ago: the payment it belongs to states daysLate 2.
  assert.equal(invoice.dates.dueAt, demoDate(-2));
  assert.equal(payment.relations.invoiceId, "invoice-atlas-deposit");
  assert.equal(production.relations.orderId, "order-atlas-001");
  assert.equal(purchaseNeed.relations.supplierId, "supplier-metal-one");
  assert.equal(hrSignal.relations.employeeId, "employee-demo-002");
  assert.equal(hrSignal.dates.observedAt, demoDate(5));
  assert.equal(ticket.relations.customerId, "customer-atlas");
  assert.equal(ticket.dates.resolvedAt, null);
});

test("priority MVP agent records expose commercial, finance, production, and purchasing capabilities", () => {
  const memory = createDemoBusinessMemoryRepository();

  const quotes = memory.listBusinessRecords({ domain: "quotes", agentId: "commercial" }).map((record) => record.data);
  const orders = memory.listBusinessRecords({ domain: "orders", agentId: "commercial" }).map((record) => record.data);
  const payments = memory.listBusinessRecords({ domain: "payments", agentId: "finance" }).map((record) => record.data);
  const production = memory.listBusinessRecords({ domain: "production", agentId: "production" }).map((record) => record.data);
  const purchaseNeeds = memory.listBusinessRecords({ domain: "purchase_needs", agentId: "purchasing" }).map((record) => record.data);
  const hrSignals = memory.listBusinessRecords({ domain: "hr_demo_overview", agentId: "hr" }).map((record) => record.data);
  const afterSales = memory.listBusinessRecords({ domain: "after_sales_tickets", agentId: "after_sales" }).map((record) => record.data);

  assert.equal(quotes.some((quote) => quote.followUpReason === "quote_without_reply" && quote.noResponseDays >= 5), true);
  assert.equal(quotes.some((quote) => quote.depositRequired === true && quote.depositPaymentId), true);
  assert.equal(orders.some((order) => order.commercialAttention === true && order.attentionReason), true);
  assert.equal(payments.some((payment) => payment.receivable === true && payment.dueStatus === "overdue" && payment.daysLate > 0), true);
  assert.equal(payments.every((payment) => payment.currency === "MAD" && payment.expectedPaymentDate), true);
  assert.deepEqual([...new Set(production.map((entry) => entry.classification))].sort(), ["AT_RISK", "IN_DANGER", "ON_TIME"]);
  assert.equal(production.every((entry) => entry.plannedStep && entry.responsible && entry.plannedDate), true);
  assert.equal(purchaseNeeds.every((need) =>
    typeof need.stockOnHand === "number" &&
    typeof need.missingQuantity === "number" &&
    typeof need.unitPrice === "number" &&
    typeof need.supplierLeadTimeDays === "number" &&
    need.availability
  ), true);
  assert.equal(purchaseNeeds.some((need) => need.linkedOrderId === "order-atlas-001" && need.missingQuantity > 0), true);
  assert.equal(hrSignals.some((entry) => entry.category === "leave" && entry.coverageRisk === "high"), true);
  assert.equal(hrSignals.some((entry) => entry.category === "recruitment" && entry.staffingNeed === true), true);
  assert.equal(afterSales.some((entry) => entry.status === "OPEN" && entry.overdue === true), true);
  assert.equal(afterSales.some((entry) => entry.warrantyStatus === "under_warranty"), true);
  assert.equal(afterSales.every((entry) => ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(entry.priority)), true);
});

test("priority business records expose only the canonical top-level contract", () => {
  const memory = createDemoBusinessMemoryRepository();
  const priorityDomains = [
    "customers",
    "quotes",
    "orders",
    "invoices",
    "payments",
    "production",
    "purchase_needs",
    "suppliers",
    "hr_demo_overview",
    "after_sales_tickets"
  ];

  for (const domain of priorityDomains) {
    const records = memory.listBusinessRecords({ domain, agentId: "director" });
    const definition = BUSINESS_DOMAIN_DEFINITIONS[domain];
    assert.equal(records.length > 0, true, domain);

    for (const record of records) {
      assert.deepEqual(Object.keys(record), BUSINESS_RECORD_CANONICAL_FIELDS, record.id);
      assert.equal(record.recordType, definition.recordType, record.id);
      assert.equal(typeof record.status, "string", record.id);
      assert.equal(record.source, BUSINESS_DATA_SOURCES.DEMO_MOCK, record.id);
      assert.equal(typeof record.data, "object", record.id);
      assert.equal(typeof record.relations, "object", record.id);
      assert.equal(typeof record.dates, "object", record.id);
      assert.equal(typeof record.metadata, "object", record.id);
      assert.equal(Object.hasOwn(record, "providerPayload"), false, record.id);
      assert.equal(Object.hasOwn(record, "externalId"), false, record.id);
    }
  }
});

test("business memory isolates domains by authorized agent", () => {
  const memory = createDemoBusinessMemoryRepository();

  assert.throws(
    () => memory.listBusinessRecords({ domain: "payments", agentId: "marketing" }),
    (error) => error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED"
  );
  assert.throws(
    () => memory.listBusinessRecords({ domain: "payments", agentId: "hr" }),
    (error) => error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED"
  );
  assert.throws(
    () => memory.listBusinessRecords({ domain: "production", agentId: "hr" }),
    (error) => error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED"
  );
  assert.throws(
    () => memory.listBusinessRecords({ domain: "customers", agentId: "community_manager" }),
    (error) => error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED"
  );
  assert.throws(
    () => memory.listBusinessRecords({ domain: "hr_demo_overview", agentId: "marketing" }),
    (error) => error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED"
  );
  assert.throws(
    () => memory.listBusinessRecords({ domain: "hr_demo_overview", agentId: "after_sales" }),
    (error) => error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED"
  );
  assert.throws(
    () => memory.listBusinessRecords({ domain: "after_sales_tickets", agentId: "hr" }),
    (error) => error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED"
  );
});

test("business memory never silently mixes demo and future real data", () => {
  const memory = createDemoBusinessMemoryRepository();

  assert.equal(memory.listBusinessRecords({ domain: "payments", agentId: "finance" }).length, 2);
  assert.deepEqual(
    memory.listBusinessRecords({
      domain: "payments",
      agentId: "finance",
      source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA
    }),
    []
  );
  assert.throws(
    () => memory.listBusinessRecords({ domain: "payments", agentId: "finance", source: "real" }),
    /Unsupported business data source/
  );
});

test("MVP tools read current demo data through business memory without changing outputs", async () => {
  const businessMemory = createDemoBusinessMemoryRepository();
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository, businessMemory })
  });

  const result = await service.execute({
    agentId: "finance",
    agentPermissions: createMvpAgentPermissions("finance"),
    toolId: "get_pending_payments",
    input: { requestId: "req-business-memory" },
    requestId: "req-business-memory"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.output.result.demo, true);
  assert.equal(result.output.result.dataSource, BUSINESS_DATA_SOURCES.DEMO_MOCK);
  assert.deepEqual(result.output.result.items.map((item) => item.id), ["payment-atlas-deposit", "payment-nova-balance"]);
  assert.equal(result.output.result.items[0].invoiceId, "invoice-atlas-deposit");
});

test("MVP tools can read an explicit future source through business memory without executing external actions", async () => {
  const businessMemory = createBusinessMemoryRepository({
    env: {
      BUSINESS_DATA_PROVIDER: "future_real_data",
      BUSINESS_DATA_SOURCE_ID: "future-finance"
    }
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
    input: { requestId: "req-business-memory-future" },
    requestId: "req-business-memory-future"
  });
  const events = await repository.listAuditEvents({ requestId: "req-business-memory-future" });

  assert.equal(result.status, "completed");
  assert.equal(result.output.result.demo, false);
  assert.equal(result.output.result.dataSource, BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA);
  assert.equal(result.output.result.sourceProvider, "future_real_data");
  assert.equal(result.output.result.sourceId, "future-finance");
  assert.deepEqual(result.output.result.items, []);
  assert.equal(events.some((event) => event.type === "tool_called"), true);
  assert.equal(events.some((event) => event.type === "approval_requested"), false);
});

test("business memory domain definitions keep MVP agent compatibility explicit", () => {
  assert.deepEqual(BUSINESS_DOMAIN_DEFINITIONS.payments.allowedAgents, ["director", "finance"]);
  assert.deepEqual(BUSINESS_DOMAIN_DEFINITIONS.quotes.allowedAgents, ["director", "commercial"]);
  assert.deepEqual(BUSINESS_DOMAIN_DEFINITIONS.production.allowedAgents, ["director", "production"]);
  assert.deepEqual(BUSINESS_DOMAIN_DEFINITIONS.purchase_needs.allowedAgents, ["director", "purchasing"]);
  assert.deepEqual(BUSINESS_DOMAIN_DEFINITIONS.hr_demo_overview.allowedAgents, ["director", "hr"]);
  assert.deepEqual(BUSINESS_DOMAIN_DEFINITIONS.after_sales_tickets.allowedAgents, ["director", "after_sales"]);
});
