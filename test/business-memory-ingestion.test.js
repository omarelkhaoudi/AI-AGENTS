import assert from "node:assert/strict";
import test from "node:test";
import {
  BUSINESS_DATA_SOURCES,
  BUSINESS_DOMAINS,
  BusinessIngestionError,
  InMemoryBusinessMemoryRepository,
  ingestBusinessRecords,
  listIngestableDomains,
  requireIngestionSource,
  validateIngestionBatch
} from "../src/index.js";

function createMemory() {
  return new InMemoryBusinessMemoryRepository({ records: [] });
}

const VALID_PRODUCTS = Object.freeze([
  {
    id: "ingest-product-1",
    status: "active",
    data: { name: "Panneau", reference: "PAN-1" },
    dates: { createdAt: "2026-08-01", updatedAt: "2026-08-02" }
  },
  {
    id: "ingest-product-2",
    status: "active",
    data: { name: "Tissu" }
  }
]);

test("ingestion is dry run by default and writes nothing", async () => {
  const memory = createMemory();

  const report = await ingestBusinessRecords({
    memory,
    domain: "products",
    source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
    records: VALID_PRODUCTS
  });

  assert.equal(report.dryRun, true);
  assert.equal(report.acceptedCount, 2);
  assert.equal(report.writtenCount, 0);
  assert.equal(memory.listBusinessRecords({ domain: "products", agentId: "director" }).length, 0);
});

test("ingestion writes only when the caller asks for it explicitly", async () => {
  const memory = createMemory();

  const report = await ingestBusinessRecords({
    memory,
    domain: "products",
    source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
    records: VALID_PRODUCTS,
    dryRun: false
  });

  assert.equal(report.dryRun, false);
  assert.equal(report.writtenCount, 2);
  assert.equal(memory.listBusinessRecords({ domain: "products", agentId: "director" }).length, 2);
});

test("a missing source is refused before anything is validated", async () => {
  const memory = createMemory();

  await assert.rejects(
    () => ingestBusinessRecords({ memory, domain: "products", records: VALID_PRODUCTS, dryRun: false }),
    (error) => error instanceof BusinessIngestionError && error.code === "INGESTION_SOURCE_REQUIRED"
  );

  assert.throws(() => requireIngestionSource(""), BusinessIngestionError);
  assert.throws(() => requireIngestionSource(null), BusinessIngestionError);
  assert.throws(() => requireIngestionSource("   "), BusinessIngestionError);
  // An unknown source value is refused by the provenance model itself.
  assert.throws(() => requireIngestionSource("production_erp"), /Unsupported business data source/);
});

test("a missing or unknown domain is refused", async () => {
  const memory = createMemory();

  await assert.rejects(
    () => ingestBusinessRecords({ memory, source: BUSINESS_DATA_SOURCES.DEMO_MOCK, records: [] }),
    (error) => error instanceof BusinessIngestionError && error.code === "INGESTION_DOMAIN_REQUIRED"
  );
  await assert.rejects(
    () => ingestBusinessRecords({
      memory,
      domain: "invented_domain",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      records: []
    }),
    /Unknown business domain/
  );
});

test("ingestion requires a business memory repository", async () => {
  await assert.rejects(
    () => ingestBusinessRecords({
      domain: "products",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      records: []
    }),
    (error) => error instanceof BusinessIngestionError && error.code === "INGESTION_MEMORY_REQUIRED"
  );
});

test("records with undeclared relations or dates are rejected", async () => {
  const memory = createMemory();

  const relationReport = await ingestBusinessRecords({
    memory,
    domain: "stock",
    source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
    dryRun: false,
    records: [{ id: "ingest-stock-1", data: {}, relations: { invoiceId: "x" } }]
  });

  assert.equal(relationReport.rejectedCount, 1);
  assert.equal(relationReport.rejected[0].code, "INGESTION_UNDECLARED_FIELD");
  assert.equal(relationReport.writtenCount, 0);

  const dateReport = await ingestBusinessRecords({
    memory,
    domain: "products",
    source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
    dryRun: false,
    records: [{ id: "ingest-product-x", data: {}, dates: { shippedAt: "2026-08-01" } }]
  });

  assert.equal(dateReport.rejectedCount, 1);
  assert.equal(dateReport.rejected[0].code, "INGESTION_UNDECLARED_FIELD");
});

test("non-canonical top level fields are rejected", async () => {
  const memory = createMemory();

  const report = await ingestBusinessRecords({
    memory,
    domain: "products",
    source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
    dryRun: false,
    records: [{ id: "ingest-product-y", data: {}, unexpectedField: "nope" }]
  });

  assert.equal(report.rejectedCount, 1);
  assert.equal(report.rejected[0].code, "INVALID_BUSINESS_RECORD");
  assert.equal(report.writtenCount, 0);
});

test("a record type that contradicts its domain is rejected", async () => {
  const memory = createMemory();

  const report = await ingestBusinessRecords({
    memory,
    domain: "products",
    source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
    dryRun: false,
    records: [{ id: "ingest-product-z", recordType: "payment", data: {} }]
  });

  assert.equal(report.rejectedCount, 1);
  assert.equal(report.writtenCount, 0);
});

// All or nothing: a partially invalid batch must not leave half the data in.
test("an invalid record blocks the whole batch", async () => {
  const memory = createMemory();

  const report = await ingestBusinessRecords({
    memory,
    domain: "products",
    source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
    dryRun: false,
    records: [
      { id: "ingest-good", data: { name: "Valide" } },
      { id: "ingest-bad", data: {}, relations: { invoiceId: "x" } }
    ]
  });

  assert.equal(report.blocked, true);
  assert.equal(report.acceptedCount, 1);
  assert.equal(report.rejectedCount, 1);
  assert.equal(report.writtenCount, 0);
  assert.equal(memory.listBusinessRecords({ domain: "products", agentId: "director" }).length, 0);
});

test("the batch report identifies each rejection by index and id", () => {
  const batch = validateIngestionBatch({
    domain: "products",
    source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
    records: [
      { id: "ok-1", data: {} },
      { id: "bad-1", data: {}, dates: { nope: "2026-01-01" } }
    ]
  });

  assert.equal(batch.total, 2);
  assert.equal(batch.accepted.length, 1);
  assert.equal(batch.rejected.length, 1);
  assert.equal(batch.rejected[0].index, 1);
  assert.equal(batch.rejected[0].id, "bad-1");
});

test("a non array batch is refused", () => {
  assert.throws(
    () => validateIngestionBatch({
      domain: "products",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      records: { id: "not-an-array" }
    }),
    (error) => error instanceof BusinessIngestionError && error.code === "INGESTION_RECORDS_REQUIRED"
  );
});

test("ingestion carries the declared source onto every stored record", async () => {
  const memory = createMemory();

  await ingestBusinessRecords({
    memory,
    domain: "products",
    source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA,
    records: VALID_PRODUCTS,
    dryRun: false
  });

  const stored = memory.listBusinessRecords({
    domain: "products",
    agentId: "director",
    source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA
  });

  assert.equal(stored.length, 2);
  assert.equal(stored.every((record) => record.source === BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA), true);
  // A batch declared as one source never leaks into another.
  assert.equal(memory.listBusinessRecords({
    domain: "products",
    agentId: "director",
    source: BUSINESS_DATA_SOURCES.DEMO_MOCK
  }).length, 0);
});

test("every declared business domain is ingestable", () => {
  assert.deepEqual([...listIngestableDomains()].sort(), [...BUSINESS_DOMAINS].sort());
});

test("the new Lot 2A.1 reference domains accept canonical records", async () => {
  const memory = createMemory();
  const batches = [
    { domain: "products", record: { id: "p-1", data: { name: "P" }, dates: { createdAt: "2026-08-01", updatedAt: "2026-08-01" } } },
    { domain: "prices", record: { id: "pr-1", data: { amount: 10, currency: "EUR" }, relations: { productId: "p-1" }, dates: { validFrom: "2026-08-01", validUntil: "2026-12-31" } } },
    { domain: "stock", record: { id: "s-1", data: { quantity: 3, unit: "unit" }, relations: { productId: "p-1", supplierId: "sup-1" }, dates: { countedAt: "2026-08-01" } } },
    { domain: "bills_of_material", record: { id: "b-1", data: { lines: [] }, relations: { productId: "p-1", orderId: "o-1" }, dates: { validFrom: "2026-08-01" } } },
    { domain: "payment_terms", record: { id: "t-1", data: { netDays: 30 }, relations: { customerId: "c-1" } } }
  ];

  for (const { domain, record } of batches) {
    const report = await ingestBusinessRecords({
      memory,
      domain,
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      records: [record],
      dryRun: false
    });

    assert.equal(report.rejectedCount, 0, `${domain}: ${JSON.stringify(report.rejected)}`);
    assert.equal(report.writtenCount, 1, domain);
    assert.equal(memory.listBusinessRecords({ domain, agentId: "director" }).length, 1, domain);
  }
});
