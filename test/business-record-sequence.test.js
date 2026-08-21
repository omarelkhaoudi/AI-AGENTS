import assert from "node:assert/strict";
import test from "node:test";
import {
  BUSINESS_DOMAINS,
  BUSINESS_RECORD_CANONICAL_FIELDS,
  compareBusinessRecords,
  createBusinessRecord,
  createDemoBusinessMemoryRepository,
  createDemoBusinessRecords,
  filterBusinessRecords,
  normalizeRecordSequence
} from "../src/index.js";

function record(id, sequence, domain = "customers") {
  return createBusinessRecord({
    id,
    domain,
    recordType: "customer",
    data: {},
    sequence
  });
}

test("sequence is a canonical field of every business record", () => {
  assert.ok(BUSINESS_RECORD_CANONICAL_FIELDS.includes("sequence"));
  assert.equal(record("a", 0).sequence, 0);
  assert.equal(createBusinessRecord({ id: "a", domain: "customers", recordType: "customer", data: {} }).sequence, null);
});

test("a rank is a non-negative integer or nothing at all", () => {
  assert.equal(normalizeRecordSequence(null), null);
  assert.equal(normalizeRecordSequence(undefined), null);
  assert.equal(normalizeRecordSequence(0), 0);
  assert.equal(normalizeRecordSequence(7), 7);

  for (const invalid of [-1, 1.5, "0", true, Number.NaN]) {
    assert.throws(
      () => normalizeRecordSequence(invalid),
      (error) => error.code === "INVALID_BUSINESS_RECORD",
      String(invalid)
    );
  }
});

// The order must be total: two providers cannot agree on a partial one.
test("records sort by rank, then by identifier, and unranked ones come last", () => {
  const ranked = [record("z", 0), record("a", 1)];
  assert.deepEqual([...ranked].sort(compareBusinessRecords).map((entry) => entry.id), ["z", "a"]);

  const tied = [record("b", 2), record("a", 2)];
  assert.deepEqual([...tied].sort(compareBusinessRecords).map((entry) => entry.id), ["a", "b"]);

  const mixed = [record("unranked", null), record("ranked", 5)];
  assert.deepEqual([...mixed].sort(compareBusinessRecords).map((entry) => entry.id), ["ranked", "unranked"]);

  const noRank = [record("b", null), record("a", null)];
  assert.deepEqual([...noRank].sort(compareBusinessRecords).map((entry) => entry.id), ["a", "b"]);
});

// Both repositories go through filterBusinessRecords, so ordering it there is
// what makes memory and PostgreSQL agree.
test("the shared filter returns records in rank order whatever the input order", () => {
  const shuffled = [record("c", 2), record("a", 0), record("b", 1)];

  assert.deepEqual(
    filterBusinessRecords(shuffled, { source: null }).map((entry) => entry.id),
    ["a", "b", "c"]
  );
  assert.deepEqual(
    filterBusinessRecords([...shuffled].reverse(), { source: null }).map((entry) => entry.id),
    ["a", "b", "c"]
  );
});

test("demo records are ranked per domain, contiguously from zero", () => {
  const byDomain = new Map(BUSINESS_DOMAINS.map((domain) => [domain, []]));
  for (const entry of createDemoBusinessRecords()) {
    byDomain.get(entry.domain).push(entry.sequence);
  }

  for (const [domain, ranks] of byDomain) {
    if (ranks.length === 0) {
      continue;
    }
    assert.deepEqual(ranks, ranks.map((_, index) => index), domain);
  }
});

// Declaration order is what a reader expects, and it is what the rank encodes.
test("the demo repository returns each domain in declaration order", () => {
  const memory = createDemoBusinessMemoryRepository();

  assert.deepEqual(
    memory.listBusinessRecords({ domain: "hr_demo_overview", agentId: "hr" }).map((entry) => entry.id),
    createDemoBusinessRecords()
      .filter((entry) => entry.domain === "hr_demo_overview")
      .map((entry) => entry.id)
  );
});

// The Director keeps the first occurrence when it deduplicates a section, so a
// change of record order changes which one survives. This pins the order the
// rule depends on.
test("a reordered input cannot change which record comes first", () => {
  const first = record("hr-b", 0);
  const second = record("hr-a", 1);

  for (const input of [[first, second], [second, first]]) {
    assert.equal(filterBusinessRecords(input, { source: null })[0].id, "hr-b");
  }
});
