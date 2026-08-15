import assert from "node:assert/strict";
import test from "node:test";
import {
  BUSINESS_DATA_SOURCES,
  BUSINESS_DOMAINS,
  BUSINESS_DOMAIN_DEFINITIONS,
  BusinessMemoryError,
  InMemoryRepository,
  ToolExecutionService,
  createDemoBusinessMemoryRepository,
  createMvpToolRegistry,
  createPermission
} from "../src/index.js";

test("business memory exposes the MVP structured domains from demo_mock data", () => {
  const memory = createDemoBusinessMemoryRepository();

  assert.deepEqual(memory.listBusinessDomains(), [
    "customers",
    "quotes",
    "invoices",
    "payments",
    "orders",
    "production",
    "purchase_needs",
    "suppliers",
    "after_sales_tickets"
  ]);

  for (const domain of BUSINESS_DOMAINS) {
    const records = memory.listBusinessRecords({ domain, agentId: "director" });
    assert.equal(records.length > 0, true, domain);
    assert.equal(records.every((record) => record.source === BUSINESS_DATA_SOURCES.DEMO_MOCK), true, domain);
    assert.equal(records.every((record) => record.metadata.draft === true), true, domain);
    assert.equal(records.every((record) => record.domain === domain), true, domain);
  }
});

test("business memory records keep essential relations and dates explicit", () => {
  const memory = createDemoBusinessMemoryRepository();

  const quote = memory.getBusinessRecord({ domain: "quotes", id: "quote-atlas-001", agentId: "commercial" });
  const invoice = memory.getBusinessRecord({ domain: "invoices", id: "invoice-atlas-deposit", agentId: "finance" });
  const payment = memory.getBusinessRecord({ domain: "payments", id: "payment-atlas-deposit", agentId: "finance" });
  const production = memory.getBusinessRecord({ domain: "production", id: "order-atlas-001", agentId: "production" });
  const purchaseNeed = memory.getBusinessRecord({ domain: "purchase_needs", id: "purchase-aluminum-a", agentId: "purchasing" });
  const ticket = memory.getBusinessRecord({ domain: "after_sales_tickets", id: "case-sav-001", agentId: "after_sales" });

  assert.equal(quote.relations.customerId, "customer-atlas");
  assert.equal(invoice.relations.orderId, "order-atlas-001");
  assert.equal(invoice.dates.dueAt, "2026-08-16");
  assert.equal(payment.relations.invoiceId, "invoice-atlas-deposit");
  assert.equal(production.relations.orderId, "order-atlas-001");
  assert.equal(purchaseNeed.relations.supplierId, "supplier-metal-one");
  assert.equal(ticket.relations.customerId, "customer-atlas");
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
    agentPermissions: [createPermission({ kind: "read_analyze", resource: "request:*" })],
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

test("business memory domain definitions keep MVP agent compatibility explicit", () => {
  assert.deepEqual(BUSINESS_DOMAIN_DEFINITIONS.payments.allowedAgents, ["director", "finance"]);
  assert.deepEqual(BUSINESS_DOMAIN_DEFINITIONS.quotes.allowedAgents, ["director", "commercial"]);
  assert.deepEqual(BUSINESS_DOMAIN_DEFINITIONS.production.allowedAgents, ["director", "production"]);
  assert.deepEqual(BUSINESS_DOMAIN_DEFINITIONS.purchase_needs.allowedAgents, ["director", "purchasing"]);
  assert.deepEqual(BUSINESS_DOMAIN_DEFINITIONS.after_sales_tickets.allowedAgents, ["director", "after_sales"]);
});
