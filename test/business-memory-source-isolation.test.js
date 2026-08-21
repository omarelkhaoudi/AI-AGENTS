import assert from "node:assert/strict";
import test from "node:test";
import {
  BUSINESS_DATA_SOURCES,
  InMemoryBusinessMemoryRepository,
  createBusinessRecord
} from "../src/index.js";

// Isolation is a property of the read, not a property of an empty table. A test
// that asserts an empty list only proves that nobody seeded anything yet, and
// stops meaning anything the day the database holds demo records.
function payment(id, source) {
  return createBusinessRecord({
    id,
    domain: "payments",
    recordType: "payment",
    status: "expected",
    source,
    data: { id, amount: 100, currency: "MAD" }
  });
}

function repositoryWithBothSources() {
  return new InMemoryBusinessMemoryRepository({
    records: [
      payment("demo-one", BUSINESS_DATA_SOURCES.DEMO_MOCK),
      payment("real-one", BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA),
      payment("demo-two", BUSINESS_DATA_SOURCES.DEMO_MOCK),
      payment("real-two", BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA)
    ]
  });
}

test("asking for one source never returns records of another", () => {
  const memory = repositoryWithBothSources();

  for (const source of [BUSINESS_DATA_SOURCES.DEMO_MOCK, BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA]) {
    const records = memory.listBusinessRecords({ domain: "payments", agentId: "finance", source });

    assert.ok(records.length > 0, source);
    assert.equal(records.every((record) => record.source === source), true, source);
  }
});

test("both sources coexist without either hiding the other", () => {
  const memory = repositoryWithBothSources();

  assert.deepEqual(
    memory
      .listBusinessRecords({ domain: "payments", agentId: "finance", source: BUSINESS_DATA_SOURCES.DEMO_MOCK })
      .map((record) => record.id),
    ["demo-one", "demo-two"]
  );
  assert.deepEqual(
    memory
      .listBusinessRecords({ domain: "payments", agentId: "finance", source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA })
      .map((record) => record.id),
    ["real-one", "real-two"]
  );
});

// The record set grew: isolation must still hold, which an empty-table
// assertion could never express.
test("adding records to one source changes nothing for the other", () => {
  const memory = repositoryWithBothSources();
  const before = memory
    .listBusinessRecords({ domain: "payments", agentId: "finance", source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA })
    .map((record) => record.id);

  memory.saveBusinessRecord(payment("demo-three", BUSINESS_DATA_SOURCES.DEMO_MOCK));

  assert.deepEqual(
    memory
      .listBusinessRecords({ domain: "payments", agentId: "finance", source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA })
      .map((record) => record.id),
    before
  );
  assert.equal(
    memory
      .listBusinessRecords({ domain: "payments", agentId: "finance", source: BUSINESS_DATA_SOURCES.DEMO_MOCK })
      .length,
    3
  );
});

test("a source with no record reports none rather than falling back", () => {
  const memory = new InMemoryBusinessMemoryRepository({
    records: [payment("demo-only", BUSINESS_DATA_SOURCES.DEMO_MOCK)]
  });

  assert.deepEqual(
    memory.listBusinessRecords({
      domain: "payments",
      agentId: "finance",
      source: BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA
    }),
    []
  );
});
