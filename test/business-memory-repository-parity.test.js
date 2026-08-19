import assert from "node:assert/strict";
import test from "node:test";
import {
  BUSINESS_DATA_SOURCES,
  BUSINESS_DOMAINS,
  BusinessMemoryError,
  InMemoryBusinessMemoryRepository,
  PrismaBusinessMemoryRepository,
  DOMAIN_MODEL_MAP
} from "../src/index.js";

test("InMemory and Prisma business memory expose the same domains and aliases", async () => {
  const { memory, prisma } = await createParityRepositories();

  assert.deepEqual(memory.listBusinessDomains(), await prisma.listBusinessDomains());
  assert.deepEqual(
    memory.listBusinessRecords({ domain: "purchasing", agentId: "purchasing" }).map(normalizeRecord),
    (await prisma.listBusinessRecords({ domain: "purchasing", agentId: "purchasing" })).map(normalizeRecord)
  );
  assert.deepEqual(
    memory.listBusinessRecords({ domain: "after_sales", agentId: "after_sales" }).map(normalizeRecord),
    (await prisma.listBusinessRecords({ domain: "after_sales", agentId: "after_sales" })).map(normalizeRecord)
  );
});

test("InMemory and Prisma business memory return the same records, relations, and dates by domain", async () => {
  const { memory, prisma } = await createParityRepositories();

  for (const domain of BUSINESS_DOMAINS) {
    assert.deepEqual(
      memory.listBusinessRecords({ domain, agentId: "director" }).map(normalizeRecord),
      (await prisma.listBusinessRecords({ domain, agentId: "director" })).map(normalizeRecord),
      domain
    );
  }

  assert.deepEqual(
    normalizeRecord(memory.getBusinessRecord({ domain: "payments", id: "parity-payment-001", agentId: "finance" })),
    normalizeRecord(await prisma.getBusinessRecord({ domain: "payments", id: "parity-payment-001", agentId: "finance" }))
  );
});

test("InMemory and Prisma business memory apply source and generic filters consistently", async () => {
  const { memory, prisma } = await createParityRepositories();
  const filters = {
    ids: ["parity-payment-001"],
    status: "expected",
    data: { invoiceId: "parity-invoice-001" },
    metadata: { draft: true }
  };

  assert.deepEqual(
    memory.listBusinessRecords({
      domain: "payments",
      agentId: "finance",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      filters
    }).map(normalizeRecord),
    (await prisma.listBusinessRecords({
      domain: "payments",
      agentId: "finance",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      filters
    })).map(normalizeRecord)
  );
  assert.deepEqual(
    memory.listBusinessRecords({
      domain: "payments",
      agentId: "finance",
      source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA
    }).map((record) => record.id),
    (await prisma.listBusinessRecords({
      domain: "payments",
      agentId: "finance",
      source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA
    })).map((record) => record.id)
  );
  assert.deepEqual(
    memory.listBusinessRecordsByDomain({
      agentId: "finance",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      filters: { status: "expected" }
    }).payments.map((record) => record.id),
    (await prisma.listBusinessRecordsByDomain({
      agentId: "finance",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      filters: { status: "expected" }
    })).payments.map((record) => record.id)
  );
});

test("InMemory and Prisma business memory enforce permissions and errors consistently", async () => {
  const { memory, prisma } = await createParityRepositories();

  assert.throws(
    () => memory.listBusinessRecords({
      domain: "payments",
      agentId: "marketing",
      filters: { ids: ["parity-payment-001"] }
    }),
    (error) => error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED"
  );
  await assert.rejects(
    () => prisma.listBusinessRecords({
      domain: "payments",
      agentId: "marketing",
      filters: { ids: ["parity-payment-001"] }
    }),
    (error) => error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED"
  );

  assert.throws(
    () => memory.listBusinessRecords({ domain: "missing_domain", agentId: "director" }),
    (error) => error instanceof BusinessMemoryError && error.code === "UNKNOWN_BUSINESS_DOMAIN"
  );
  await assert.rejects(
    () => prisma.listBusinessRecords({ domain: "missing_domain", agentId: "director" }),
    (error) => error instanceof BusinessMemoryError && error.code === "UNKNOWN_BUSINESS_DOMAIN"
  );

  assert.throws(
    () => memory.listBusinessRecords({ domain: "payments", agentId: "finance", filters: "bad-filter" }),
    (error) => error instanceof BusinessMemoryError && error.code === "INVALID_BUSINESS_FILTER"
  );
  await assert.rejects(
    () => prisma.listBusinessRecords({ domain: "payments", agentId: "finance", filters: "bad-filter" }),
    (error) => error instanceof BusinessMemoryError && error.code === "INVALID_BUSINESS_FILTER"
  );
});

test("InMemory and Prisma business memory reject non-canonical records consistently", async () => {
  const memory = new InMemoryBusinessMemoryRepository();
  const prisma = new PrismaBusinessMemoryRepository({ prisma: createFakeBusinessMemoryPrisma() });
  const contaminatedRecord = {
    id: "contaminated-payment-001",
    domain: "payments",
    recordType: "payment",
    status: "expected",
    source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
    data: {
      id: "contaminated-payment-001",
      invoiceId: "contaminated-invoice-001"
    },
    relations: {
      customerId: null,
      invoiceId: "contaminated-invoice-001",
      quoteId: null,
      orderId: null
    },
    dates: {
      dueAt: "2026-08-20"
    },
    metadata: {
      provider: "offline-fake"
    },
    externalId: "provider-top-level-id"
  };
  const wrongRecordType = {
    id: "wrong-type-payment-001",
    domain: "payments",
    recordType: "invoice",
    status: "expected",
    source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
    data: {
      id: "wrong-type-payment-001",
      invoiceId: "wrong-type-invoice-001"
    }
  };

  assert.throws(
    () => memory.saveBusinessRecord(contaminatedRecord),
    (error) => error instanceof BusinessMemoryError && error.code === "INVALID_BUSINESS_RECORD"
  );
  await assert.rejects(
    () => prisma.saveBusinessRecord(contaminatedRecord),
    (error) => error instanceof BusinessMemoryError && error.code === "INVALID_BUSINESS_RECORD"
  );
  assert.throws(
    () => memory.saveBusinessRecord(wrongRecordType),
    (error) => error instanceof BusinessMemoryError && error.code === "INVALID_BUSINESS_RECORD"
  );
  await assert.rejects(
    () => prisma.saveBusinessRecord(wrongRecordType),
    (error) => error instanceof BusinessMemoryError && error.code === "INVALID_BUSINESS_RECORD"
  );
});

async function createParityRepositories() {
  const records = createParityRecords();
  const memory = new InMemoryBusinessMemoryRepository({ records });
  const prisma = new PrismaBusinessMemoryRepository({ prisma: createFakeBusinessMemoryPrisma() });

  for (const record of records) {
    await prisma.saveBusinessRecord(record);
  }

  return { memory, prisma };
}

function createParityRecords() {
  const base = {
    source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
    metadata: { test: "business-memory-parity", draft: true }
  };
  return [
    {
      ...base,
      id: "parity-customer-001",
      domain: "customers",
      recordType: "customer",
      status: "active",
      data: { id: "parity-customer-001", name: "Parity Customer", segment: "test" },
      dates: { createdAt: "2026-08-01", updatedAt: "2026-08-02" }
    },
    {
      ...base,
      id: "parity-quote-001",
      domain: "quotes",
      recordType: "quote",
      status: "pending_customer_reply",
      data: { id: "parity-quote-001", customerId: "parity-customer-001", linkedOrderId: "parity-order-001" },
      relations: { customerId: "parity-customer-001", linkedOrderId: "parity-order-001" },
      dates: { issuedAt: "2026-08-03", validUntil: "2026-08-30" }
    },
    {
      ...base,
      id: "parity-invoice-001",
      domain: "invoices",
      recordType: "invoice",
      status: "issued",
      data: { id: "parity-invoice-001", customerId: "parity-customer-001", quoteId: "parity-quote-001", orderId: "parity-order-001", amount: 1000, currency: "MAD" },
      relations: { customerId: "parity-customer-001", quoteId: "parity-quote-001", orderId: "parity-order-001" },
      dates: { issuedAt: "2026-08-04", dueAt: "2026-08-20" }
    },
    {
      ...base,
      id: "parity-payment-001",
      domain: "payments",
      recordType: "payment",
      status: "expected",
      data: { id: "parity-payment-001", customerId: "parity-customer-001", invoiceId: "parity-invoice-001", amount: 1000, currency: "MAD", status: "expected" },
      relations: { customerId: "parity-customer-001", invoiceId: "parity-invoice-001" },
      dates: { dueAt: "2026-08-20" }
    },
    {
      ...base,
      id: "parity-order-001",
      domain: "orders",
      recordType: "order",
      status: "in_production",
      data: { id: "parity-order-001", customerId: "parity-customer-001", quoteId: "parity-quote-001", risk: "medium" },
      relations: { customerId: "parity-customer-001", quoteId: "parity-quote-001" },
      dates: { dueAt: "2026-08-22" }
    },
    {
      ...base,
      id: "parity-production-001",
      domain: "production",
      recordType: "production_signal",
      status: "watch",
      data: { id: "parity-production-001", orderId: "parity-order-001", delayRisk: "medium" },
      relations: { orderId: "parity-order-001" },
      dates: { dueAt: "2026-08-22" }
    },
    {
      ...base,
      id: "parity-supplier-001",
      domain: "suppliers",
      recordType: "supplier",
      status: "active",
      data: { id: "parity-supplier-001", name: "Parity Supplier", leadTimeDays: 3 },
      dates: { createdAt: "2026-08-01", updatedAt: "2026-08-02" }
    },
    {
      ...base,
      id: "parity-purchase-001",
      domain: "purchase_needs",
      recordType: "purchase_need",
      status: "medium",
      data: { id: "parity-purchase-001", supplierId: "parity-supplier-001", linkedOrderId: "parity-order-001", urgency: "medium" },
      relations: { supplierId: "parity-supplier-001", linkedOrderId: "parity-order-001" },
      dates: { neededAt: "2026-08-18" }
    },
    {
      ...base,
      id: "parity-hr-001",
      domain: "hr_demo_overview",
      recordType: "hr_signal",
      status: "watch",
      data: { id: "parity-hr-001", category: "leave", employeeId: "employee-parity-001", departmentId: "production", priority: "medium" },
      relations: { employeeId: "employee-parity-001", departmentId: "production" },
      dates: { observedAt: "2026-08-18", dueAt: "2026-08-21" }
    },
    {
      ...base,
      id: "parity-ticket-001",
      domain: "after_sales_tickets",
      recordType: "after_sales_ticket",
      status: "open",
      data: { id: "parity-ticket-001", customerId: "parity-customer-001", orderId: "parity-order-001", priority: "medium" },
      relations: { customerId: "parity-customer-001", orderId: "parity-order-001" },
      dates: { openedAt: "2026-08-15" }
    },
    {
      id: "parity-payment-001",
      domain: "payments",
      recordType: "payment",
      status: "expected",
      source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
      data: { id: "parity-payment-001", invoiceId: "future-invoice-001", amount: 2000, currency: "MAD", status: "expected" },
      relations: { invoiceId: "future-invoice-001" },
      dates: { dueAt: "2026-08-25" },
      metadata: { test: "business-memory-parity", draft: false }
    },
    {
      ...base,
      id: "parity-product-001",
      domain: "products",
      recordType: "product",
      status: "active",
      data: { id: "parity-product-001", name: "Parity Product", reference: "REF-001", category: "panels" },
      dates: { createdAt: "2026-08-01", updatedAt: "2026-08-02" }
    },
    {
      ...base,
      id: "parity-price-001",
      domain: "prices",
      recordType: "price_entry",
      status: "active",
      data: { id: "parity-price-001", amount: 125.5, currency: "EUR" },
      relations: { productId: "parity-product-001" },
      dates: { validFrom: "2026-08-01", validUntil: "2026-12-31" }
    },
    {
      ...base,
      id: "parity-stock-001",
      domain: "stock",
      recordType: "stock_item",
      status: "available",
      data: { id: "parity-stock-001", quantity: 42, unit: "unit" },
      relations: { productId: "parity-product-001", supplierId: "parity-supplier-001" },
      dates: { countedAt: "2026-08-03" }
    },
    {
      ...base,
      id: "parity-bom-001",
      domain: "bills_of_material",
      recordType: "bill_of_material",
      status: "active",
      data: { id: "parity-bom-001", lines: [{ lineId: "line-1", productId: "parity-product-001", quantity: 2 }] },
      relations: { productId: "parity-product-001", orderId: "parity-order-001" },
      dates: { validFrom: "2026-08-01" }
    },
    {
      ...base,
      id: "parity-payment-term-001",
      domain: "payment_terms",
      recordType: "payment_term",
      status: "active",
      data: { id: "parity-payment-term-001", netDays: 30, label: "30 jours net" },
      relations: { customerId: "parity-customer-001" }
    }
  ];
}

function normalizeRecord(record) {
  return record === null ? null : {
    id: record.id,
    domain: record.domain,
    recordType: record.recordType,
    status: record.status,
    source: record.source,
    data: record.data,
    relations: record.relations,
    dates: record.dates,
    metadata: record.metadata
  };
}

// Delegates are derived from the real domain mapping so a newly declared
// business domain cannot silently escape the parity check.
function createFakeBusinessMemoryPrisma() {
  const delegates = [...new Set(Object.values(DOMAIN_MODEL_MAP).map((config) => config.delegate))];
  const state = new Map(delegates.map((delegate) => [delegate, []]));

  return Object.fromEntries([...state.keys()].map((delegate) => [
    delegate,
    createFakeDelegate(state.get(delegate))
  ]));
}

function createFakeDelegate(rows) {
  return {
    async upsert({ where, create, update }) {
      const key = where.source_businessId;
      const index = rows.findIndex((row) => row.source === key.source && row.businessId === key.businessId);
      if (index === -1) {
        const row = normalizeFakeRow({ ...create, id: `fake-${rows.length + 1}` });
        rows.push(row);
        return row;
      }
      rows[index] = normalizeFakeRow({ ...rows[index], ...update });
      return rows[index];
    },
    async findUnique({ where }) {
      const key = where.source_businessId;
      return rows.find((row) => row.source === key.source && row.businessId === key.businessId) ?? null;
    },
    async findFirst({ where }) {
      return rows
        .filter((row) => row.businessId === where.businessId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0] ?? null;
    },
    async findMany({ where = {} }) {
      return rows
        .filter((row) => where.source === undefined || row.source === where.source)
        .sort((left, right) => left.businessId.localeCompare(right.businessId));
    }
  };
}

function normalizeFakeRow(row) {
  return {
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    ...row
  };
}
