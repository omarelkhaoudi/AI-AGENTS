import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  ToolExecutionService,
  ToolExecutionServiceError,
  createMvpAgentPermissions,
  createMvpToolRegistry,
  createReceivablesSummary,
  isPaymentSettled,
  isReceivableOverdue
} from "../src/index.js";

const REFERENCE = new Date("2026-08-19");

function summaryOf(input, referenceDate = REFERENCE) {
  return createReceivablesSummary(input, referenceDate).summary;
}

function createHarness() {
  const repository = new InMemoryRepository();
  return {
    repository,
    service: new ToolExecutionService({ repository, toolRegistry: createMvpToolRegistry({ repository }) })
  };
}

function execute(service, agentId = "finance") {
  return service.execute({
    agentId,
    agentPermissions: createMvpAgentPermissions(agentId),
    toolId: "get_receivables_summary",
    input: { requestId: "req-recv" },
    requestId: "req-recv"
  });
}

test("the tool is scoped to both payments and invoices", () => {
  const tool = createMvpToolRegistry().get("get_receivables_summary");

  assert.deepEqual([...tool.securityDomains], ["payments", "invoices"]);
  assert.deepEqual([...tool.allowedAgents], ["finance"]);
  assert.equal(tool.requiredPermission, "read_analyze");
});

test("finance reads the demo receivables and gets totals per currency", async () => {
  const { service } = createHarness();
  const result = await execute(service);

  assert.equal(result.status, "completed");
  assert.equal(result.output.result.dataSource, "demo_mock");
  assert.ok(result.output.result.items.length > 0);
  assert.ok(result.output.result.summary.totalsByCurrency.MAD > 0);
});

// The whole point of reading two domains at once: a payment that settles an
// invoice must replace it, never add to it.
test("an invoice already covered by a payment is not counted twice", () => {
  const summary = summaryOf({
    payments: [{ id: "p1", invoiceId: "i1", amount: 1000, currency: "MAD", status: "expected", expectedPaymentDate: "2026-09-01" }],
    invoices: [{ id: "i1", amount: 1000, currency: "MAD", status: "issued", dueAt: "2026-09-01" }]
  });

  assert.deepEqual(summary.totalsByCurrency, { MAD: 1000 });
  assert.equal(summary.counts.receivables, 1);
  assert.equal(summary.counts.deduplicatedInvoices, 1);
  assert.deepEqual([...summary.deduplicatedInvoiceIds], ["i1"]);
});

test("an invoice with no matching payment is kept", () => {
  const summary = summaryOf({
    payments: [{ id: "p1", invoiceId: "i1", amount: 1000, currency: "MAD", status: "expected" }],
    invoices: [
      { id: "i1", amount: 1000, currency: "MAD", status: "issued" },
      { id: "i2", amount: 400, currency: "MAD", status: "issued" }
    ]
  });

  assert.deepEqual(summary.totalsByCurrency, { MAD: 1400 });
  assert.equal(summary.counts.receivables, 2);
  assert.equal(summary.counts.deduplicatedInvoices, 1);
});

test("settled payments and invoices are excluded", () => {
  const summary = summaryOf({
    payments: [
      { id: "p1", amount: 100, currency: "MAD", status: "received" },
      { id: "p2", amount: 200, currency: "MAD", status: "expected" }
    ],
    invoices: [
      { id: "i1", amount: 500, currency: "MAD", status: "paid" },
      { id: "i2", amount: 50, currency: "MAD", status: "cancelled" }
    ]
  });

  assert.deepEqual(summary.totalsByCurrency, { MAD: 200 });
  assert.equal(summary.counts.receivables, 1);
});

// Currencies are never merged: there is no single grand total to misread.
test("mixed currencies are totalled separately and never summed together", () => {
  const summary = summaryOf({
    payments: [
      { id: "p1", amount: 1000, currency: "MAD", status: "expected" },
      { id: "p2", amount: 250, currency: "EUR", status: "expected" },
      { id: "p3", amount: 40, currency: "USD", status: "expected" }
    ],
    invoices: []
  });

  assert.deepEqual(summary.totalsByCurrency, { MAD: 1000, EUR: 250, USD: 40 });
  assert.equal("total" in summary, false);
  assert.equal("totalAmount" in summary, false);
  assert.equal("grandTotal" in summary, false);
});

test("a missing currency is bucketed as unknown and never merged into a real one", () => {
  const summary = summaryOf({
    payments: [
      { id: "p1", amount: 100, currency: "MAD", status: "expected" },
      { id: "p2", amount: 70, status: "expected" },
      { id: "p3", amount: 30, currency: "   ", status: "expected" }
    ],
    invoices: []
  });

  assert.deepEqual(summary.totalsByCurrency, { MAD: 100, unknown: 100 });
});

// Nothing is silently dropped: what cannot be summed is counted.
test("invalid amounts are excluded from totals but reported", () => {
  const summary = summaryOf({
    payments: [
      { id: "p1", amount: 100, currency: "MAD", status: "expected" },
      { id: "p2", currency: "MAD", status: "expected" },
      { id: "p3", amount: null, currency: "MAD", status: "expected" },
      { id: "p4", amount: Number.NaN, currency: "MAD", status: "expected" },
      { id: "p5", amount: "120", currency: "MAD", status: "expected" }
    ],
    invoices: []
  });

  assert.deepEqual(summary.totalsByCurrency, { MAD: 100 });
  assert.equal(summary.counts.itemsWithoutAmount, 4);
  assert.equal(summary.counts.receivables, 5);
});

test("a negative amount is kept in the total and counted", () => {
  const summary = summaryOf({
    payments: [
      { id: "p1", amount: 500, currency: "MAD", status: "expected" },
      { id: "p2", amount: -120, currency: "MAD", status: "expected" }
    ],
    invoices: []
  });

  assert.deepEqual(summary.totalsByCurrency, { MAD: 380 });
  assert.equal(summary.counts.negativeAmountCount, 1);
});

test("overdue totals are a separate aggregate", () => {
  const summary = summaryOf({
    payments: [
      { id: "p1", amount: 100, currency: "MAD", status: "expected", expectedPaymentDate: "2026-08-10" },
      { id: "p2", amount: 300, currency: "MAD", status: "expected", expectedPaymentDate: "2026-09-30" }
    ],
    invoices: []
  });

  assert.deepEqual(summary.totalsByCurrency, { MAD: 400 });
  assert.deepEqual(summary.overdueTotalsByCurrency, { MAD: 100 });
  assert.equal(summary.counts.overdue, 1);
});

test("overdue uses the due date of each kind and an explicit reference", () => {
  // Payments carry expectedPaymentDate, invoices carry dueAt.
  assert.equal(isReceivableOverdue({ expectedPaymentDate: "2026-08-18" }, REFERENCE), true);
  assert.equal(isReceivableOverdue({ dueAt: "2026-08-18" }, REFERENCE), true);
  assert.equal(isReceivableOverdue({ dueAt: "2026-08-20" }, REFERENCE), false);
  // A date reached but not passed is not overdue.
  assert.equal(isReceivableOverdue({ dueAt: "2026-08-19" }, REFERENCE), false);
  assert.equal(isReceivableOverdue({ dueAt: "not-a-date" }, REFERENCE), false);
  assert.equal(isReceivableOverdue({}, REFERENCE), false);
  assert.equal(isReceivableOverdue(null, REFERENCE), false);
});

test("payment settlement is recognised by status", () => {
  assert.equal(isPaymentSettled({ status: "received" }), true);
  assert.equal(isPaymentSettled({ status: "paid" }), true);
  assert.equal(isPaymentSettled({ status: "cancelled" }), true);
  assert.equal(isPaymentSettled({ status: "expected" }), false);
  assert.equal(isPaymentSettled(null), false);
});

test("empty inputs produce empty aggregates rather than failing", () => {
  const summary = summaryOf({});

  assert.deepEqual(summary.totalsByCurrency, {});
  assert.deepEqual(summary.overdueTotalsByCurrency, {});
  assert.equal(summary.counts.receivables, 0);
  assert.equal(summary.counts.deduplicatedInvoices, 0);
});

test("an agent without both domains is denied", async () => {
  const { service } = createHarness();

  await assert.rejects(
    () => service.execute({
      agentId: "finance",
      // Commercial holds quotes, customers and orders: neither payments nor invoices.
      agentPermissions: createMvpAgentPermissions("commercial"),
      toolId: "get_receivables_summary",
      input: { requestId: "req-recv" },
      requestId: "req-recv"
    }),
    (error) => {
      assert.ok(error instanceof ToolExecutionServiceError);
      assert.equal(error.code, "DOMAIN_NOT_ALLOWED");
      assert.deepEqual(error.details.missingDomains, ["payments", "invoices"]);
      return true;
    }
  );
});

test("an agent other than finance cannot use the tool", async () => {
  const { service } = createHarness();

  await assert.rejects(
    () => execute(service, "commercial"),
    (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED"
  );
});
