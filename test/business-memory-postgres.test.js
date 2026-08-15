import assert from "node:assert/strict";
import test from "node:test";
import {
  BUSINESS_DATA_SOURCES,
  BusinessMemoryError,
  PrismaBusinessMemoryRepository,
  createPrismaClient,
  hasValidDatabaseUrl
} from "../src/index.js";

const postgresIntegrationEnabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const postgresUrlAvailable = hasValidDatabaseUrl(process.env.DATABASE_URL);
const skipReason =
  postgresIntegrationEnabled && postgresUrlAvailable
    ? false
    : "Set RUN_POSTGRES_INTEGRATION=true and DATABASE_URL to run PostgreSQL business memory tests.";

test("PostgreSQL business memory persists MVP domains with explicit sources and relations", {
  skip: skipReason
}, async () => {
  const prisma = await createPrismaClient();
  const memory = new PrismaBusinessMemoryRepository({ prisma });
  const source = BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA;

  try {
    await saveTestGraph(memory, source);

    const domains = await memory.listBusinessRecordsByDomain({ agentId: "director", source });
    assert.equal(domains.customers.length, 1);
    assert.equal(domains.quotes.length, 1);
    assert.equal(domains.invoices.length, 1);
    assert.equal(domains.payments.length, 1);
    assert.equal(domains.orders.length, 1);
    assert.equal(domains.production.length, 1);
    assert.equal(domains.purchase_needs.length, 1);
    assert.equal(domains.suppliers.length, 1);
    assert.equal(domains.after_sales_tickets.length, 1);

    const payment = await memory.getBusinessRecord({
      domain: "payments",
      id: "test-bm-payment-001",
      agentId: "finance",
      source
    });
    assert.equal(payment.source, source);
    assert.equal(payment.relations.customerId, "test-bm-customer-001");
    assert.equal(payment.relations.invoiceId, "test-bm-invoice-001");
    assert.equal(payment.dates.dueAt, "2026-08-20");

    assert.deepEqual(
      await memory.listBusinessRecords({ domain: "payments", agentId: "finance", source: BUSINESS_DATA_SOURCES.DEMO_MOCK }),
      []
    );
    await assert.rejects(
      () => memory.listBusinessRecords({ domain: "payments", agentId: "marketing", source }),
      (error) => error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED"
    );
  } finally {
    await cleanupTestGraph(prisma, source);
    await prisma.$disconnect();
  }
});

async function saveTestGraph(memory, source) {
  const base = { source, metadata: { test: "business-memory-postgres", draft: true } };
  await memory.saveBusinessRecord({
    ...base,
    id: "test-bm-customer-001",
    domain: "customers",
    recordType: "customer",
    status: "active",
    data: { id: "test-bm-customer-001", name: "Test Business Memory Customer", segment: "test" }
  });
  await memory.saveBusinessRecord({
    ...base,
    id: "test-bm-quote-001",
    domain: "quotes",
    recordType: "quote",
    status: "pending_customer_reply",
    data: { id: "test-bm-quote-001", customerId: "test-bm-customer-001" },
    relations: { customerId: "test-bm-customer-001" },
    dates: { issuedAt: "2026-08-15" }
  });
  await memory.saveBusinessRecord({
    ...base,
    id: "test-bm-order-001",
    domain: "orders",
    recordType: "order",
    status: "in_production",
    data: { id: "test-bm-order-001", customerId: "test-bm-customer-001", quoteId: "test-bm-quote-001", risk: "medium" },
    relations: { customerId: "test-bm-customer-001", quoteId: "test-bm-quote-001" },
    dates: { dueAt: "2026-08-22" }
  });
  await memory.saveBusinessRecord({
    ...base,
    id: "test-bm-invoice-001",
    domain: "invoices",
    recordType: "invoice",
    status: "issued",
    data: { id: "test-bm-invoice-001", customerId: "test-bm-customer-001", quoteId: "test-bm-quote-001", orderId: "test-bm-order-001", amount: 1000, currency: "MAD" },
    relations: { customerId: "test-bm-customer-001", quoteId: "test-bm-quote-001", orderId: "test-bm-order-001" },
    dates: { issuedAt: "2026-08-15", dueAt: "2026-08-20" }
  });
  await memory.saveBusinessRecord({
    ...base,
    id: "test-bm-payment-001",
    domain: "payments",
    recordType: "payment",
    status: "expected",
    data: { id: "test-bm-payment-001", customerId: "test-bm-customer-001", invoiceId: "test-bm-invoice-001", orderId: "test-bm-order-001", amount: 1000, currency: "MAD" },
    relations: { customerId: "test-bm-customer-001", invoiceId: "test-bm-invoice-001", orderId: "test-bm-order-001" },
    dates: { dueAt: "2026-08-20" }
  });
  await memory.saveBusinessRecord({
    ...base,
    id: "test-bm-production-001",
    domain: "production",
    recordType: "production_signal",
    status: "watch",
    data: { id: "test-bm-production-001", orderId: "test-bm-order-001", delayRisk: "medium" },
    relations: { orderId: "test-bm-order-001" },
    dates: { dueAt: "2026-08-22" }
  });
  await memory.saveBusinessRecord({
    ...base,
    id: "test-bm-supplier-001",
    domain: "suppliers",
    recordType: "supplier",
    status: "active",
    data: { id: "test-bm-supplier-001", name: "Test Business Memory Supplier", leadTimeDays: 3 }
  });
  await memory.saveBusinessRecord({
    ...base,
    id: "test-bm-purchase-001",
    domain: "purchase_needs",
    recordType: "purchase_need",
    status: "medium",
    data: { id: "test-bm-purchase-001", supplierId: "test-bm-supplier-001", linkedOrderId: "test-bm-order-001", urgency: "medium" },
    relations: { supplierId: "test-bm-supplier-001", linkedOrderId: "test-bm-order-001" },
    dates: { neededAt: "2026-08-18" }
  });
  await memory.saveBusinessRecord({
    ...base,
    id: "test-bm-ticket-001",
    domain: "after_sales_tickets",
    recordType: "after_sales_ticket",
    status: "open",
    data: { id: "test-bm-ticket-001", customerId: "test-bm-customer-001", orderId: "test-bm-order-001", priority: "medium" },
    relations: { customerId: "test-bm-customer-001", orderId: "test-bm-order-001" },
    dates: { openedAt: "2026-08-15" }
  });
}

async function cleanupTestGraph(prisma, source) {
  const where = { source, businessId: { startsWith: "test-bm-" } };
  await prisma.afterSalesTicket.deleteMany({ where });
  await prisma.purchaseNeed.deleteMany({ where });
  await prisma.supplier.deleteMany({ where });
  await prisma.productionRecord.deleteMany({ where });
  await prisma.payment.deleteMany({ where });
  await prisma.invoice.deleteMany({ where });
  await prisma.businessOrder.deleteMany({ where });
  await prisma.quote.deleteMany({ where });
  await prisma.customer.deleteMany({ where });
}
