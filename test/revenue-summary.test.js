import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  ToolExecutionService,
  ToolExecutionServiceError,
  createMvpAgentPermissions,
  createMvpToolRegistry,
  createBusinessMemoryRepository,
  createPrismaClient,
  createRevenueSummary,
  hasValidDatabaseUrl,
  isInvoiceCancelled
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// CDC section 29 asks for revenue beside collections and receivables. Three
// separate figures, so revenue cannot be what was collected: it is what was
// invoiced, settled or not, and only a cancelled invoice never counted.
const skipReason =
  process.env.RUN_POSTGRES_INTEGRATION === "true" && hasValidDatabaseUrl(process.env.DATABASE_URL)
    ? false
    : "Set RUN_POSTGRES_INTEGRATION=true and DATABASE_URL to run the PostgreSQL parity test.";

function invoice(overrides = {}) {
  return {
    id: "invoice-1",
    customerId: "customer-1",
    status: "issued",
    amount: 1000,
    currency: "MAD",
    issuedAt: "2026-08-10",
    ...overrides
  };
}

test("totals are grouped by currency", () => {
  const { summary } = createRevenueSummary({
    invoices: [
      invoice({ id: "a", amount: 1000, currency: "MAD" }),
      invoice({ id: "b", amount: 500, currency: "MAD" }),
      invoice({ id: "c", amount: 250, currency: "EUR" })
    ]
  });

  assert.deepEqual(summary.totalsByCurrency, { MAD: 1500, EUR: 250 });
  assert.equal(summary.counts.invoices, 3);
});

// Two amounts in two currencies are two amounts. Adding them would invent money.
test("currencies are never merged into a single figure", () => {
  const { summary } = createRevenueSummary({
    invoices: [
      invoice({ id: "a", amount: 100, currency: "MAD" }),
      invoice({ id: "b", amount: 100, currency: "EUR" }),
      invoice({ id: "c", amount: 100, currency: "USD" })
    ]
  });

  assert.deepEqual(Object.keys(summary.totalsByCurrency).sort(), ["EUR", "MAD", "USD"]);
  for (const total of Object.values(summary.totalsByCurrency)) {
    assert.equal(total, 100);
  }
  // An invoice with no currency is kept and reported under its own key rather
  // than folded into another one.
  const { summary: sansDevise } = createRevenueSummary({
    invoices: [invoice({ amount: 42, currency: undefined })]
  });
  assert.deepEqual(sansDevise.totalsByCurrency, { unknown: 42 });
});

// The trap this tool had to avoid: isInvoiceSettled groups paid, settled and
// cancelled together, which is right for a receivable and wrong here. Reusing it
// would have dropped every paid invoice and understated revenue in silence.
test("cancelled invoices are excluded and paid ones are kept", () => {
  const { summary } = createRevenueSummary({
    invoices: [
      invoice({ id: "paid", amount: 1000, status: "paid" }),
      invoice({ id: "settled", amount: 2000, status: "settled" }),
      invoice({ id: "issued", amount: 3000, status: "issued" }),
      invoice({ id: "cancelled", amount: 9999, status: "cancelled" }),
      invoice({ id: "void", amount: 8888, status: "void" })
    ]
  });

  assert.deepEqual(summary.totalsByCurrency, { MAD: 6000 });
  assert.equal(summary.counts.invoices, 3);
  assert.equal(summary.counts.cancelledCount, 2);
  assert.deepEqual(summary.countsByStatus, { paid: 1, settled: 1, issued: 1 });

  assert.equal(isInvoiceCancelled({ status: "cancelled" }), true);
  assert.equal(isInvoiceCancelled({ status: "paid" }), false);
  assert.equal(isInvoiceCancelled({ status: "issued" }), false);
});

// A missing amount is a gap in the data. A total that quietly skipped it would
// look complete when it is not, so it is counted and reported.
test("invoices without an amount are counted, never guessed", () => {
  const { summary } = createRevenueSummary({
    invoices: [
      invoice({ id: "a", amount: 1000 }),
      invoice({ id: "b", amount: undefined }),
      invoice({ id: "c", amount: "not a number" }),
      invoice({ id: "d", amount: null })
    ]
  });

  assert.deepEqual(summary.totalsByCurrency, { MAD: 1000 });
  assert.equal(summary.counts.itemsWithoutAmount, 3);
  assert.equal(summary.counts.invoices, 4, "they are still invoices, just unusable ones");
});

// A credit note reduces revenue, so it is kept in the total. It is also flagged,
// because a negative figure in a revenue report deserves to be noticed.
test("negative amounts are kept in the total and reported", () => {
  const { summary } = createRevenueSummary({
    invoices: [
      invoice({ id: "a", amount: 1000 }),
      invoice({ id: "b", amount: -300 })
    ]
  });

  assert.deepEqual(summary.totalsByCurrency, { MAD: 700 });
  assert.equal(summary.counts.negativeAmountCount, 1);
});

test("invoices without an issue date are counted and excluded from the period", () => {
  const { summary } = createRevenueSummary({
    invoices: [
      invoice({ id: "a", issuedAt: "2026-08-05" }),
      invoice({ id: "b", issuedAt: undefined }),
      invoice({ id: "c", issuedAt: "pas une date" })
    ]
  });

  assert.equal(summary.counts.undatedCount, 2);
  assert.equal(summary.periodStart, "2026-08-05");
  assert.equal(summary.periodEnd, "2026-08-05");
  // They still count as invoices and their amounts still count.
  assert.deepEqual(summary.totalsByCurrency, { MAD: 3000 });
});

// No period filter: none is stated by the CDC and no other tool has one, so the
// window is reported rather than chosen.
test("the period is derived from the dates actually present", () => {
  const { summary } = createRevenueSummary({
    invoices: [
      invoice({ id: "a", issuedAt: "2026-03-15" }),
      invoice({ id: "b", issuedAt: "2026-01-02" }),
      invoice({ id: "c", issuedAt: "2026-07-30" })
    ]
  });

  assert.equal(summary.periodStart, "2026-01-02");
  assert.equal(summary.periodEnd, "2026-07-30");
});

test("an empty set reports empty totals, never an error", () => {
  const { items, summary } = createRevenueSummary({ invoices: [] });

  assert.deepEqual(items, []);
  assert.deepEqual(summary.totalsByCurrency, {});
  assert.deepEqual(summary.countsByStatus, {});
  assert.equal(summary.counts.invoices, 0);
  assert.equal(summary.periodStart, null);
  assert.equal(summary.periodEnd, null);

  // No argument at all behaves the same way.
  assert.deepEqual(createRevenueSummary().summary.totalsByCurrency, {});
});

// Section A ENCAISSER collects the items of every finance tool. Returning the
// invoices here listed the same business signals twice, once as the payment
// expected and once as the invoice behind it, with different ids so the existing
// deduplication could not see they were the same reality.
test("the tool returns no item, so no heading gains a duplicate", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const response = await inject({
    method: "POST",
    url: "/api/director/requests",
    payload: { message: "Fais-moi le point sur mon entreprise aujourd'hui." }
  });
  const body = JSON.parse(response.body);
  const revenue = body.results.find((result) => result.tool === "get_revenue_summary");

  assert.ok(revenue, "the Director must route the revenue tool");
  assert.deepEqual(revenue.result.items, []);
  assert.equal(body.summary.minimumSections["A ENCAISSER"].length, 2);
  assert.equal(
    body.summary.minimumSections["A ENCAISSER"].some((entry) => entry.tool === "get_revenue_summary"),
    false,
    "a figure is not a thing to act on: it belongs beside the headings, not inside one"
  );
});

test("the revenue reaches the Director as an aggregate", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const response = await inject({
    method: "POST",
    url: "/api/director/requests",
    payload: { message: "Quelle est la situation aujourd'hui ?" }
  });
  const aggregate = JSON.parse(response.body).summary.aggregates.invoices;

  assert.ok(aggregate, "CDC section 29 asks for revenue in the answer to this question");
  assert.equal(aggregate.agent, "finance");
  assert.equal(aggregate.tool, "get_revenue_summary");
  assert.deepEqual(aggregate.totalsByCurrency, { MAD: 20500 });
  assert.equal(aggregate.counts.invoices, 2);
  assert.equal(typeof aggregate.periodStart, "string");
  assert.equal(typeof aggregate.periodEnd, "string");
});

// The tool reads invoices, a domain finance already held. No other agent does,
// and the domain check is what says so.
test("an agent outside finance cannot read the revenue", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository })
  });

  await assert.rejects(
    () => service.execute({
      agentId: "commercial",
      agentPermissions: createMvpAgentPermissions("commercial"),
      toolId: "get_revenue_summary",
      input: { requestId: "req-revenue" },
      requestId: "req-revenue"
    }),
    (error) => {
      assert.ok(error instanceof ToolExecutionServiceError);
      assert.equal(error.code, "AGENT_NOT_ALLOWED");
      return true;
    }
  );
});

// The figure must be the same whichever store the invoices come from.
test("memory and PostgreSQL report the same revenue", { skip: skipReason }, async () => {
  const prisma = await createPrismaClient();
  const businessMemory = createBusinessMemoryRepository({
    prisma,
    env: { BUSINESS_MEMORY_PROVIDER: "postgres", DATABASE_URL: process.env.DATABASE_URL }
  });

  try {
    const repository = new InMemoryRepository();
    const registry = createMvpToolRegistry({ repository, businessMemory });
    const service = new ToolExecutionService({ repository, toolRegistry: registry });

    const fromPostgres = await service.execute({
      agentId: "finance",
      agentPermissions: createMvpAgentPermissions("finance"),
      toolId: "get_revenue_summary",
      input: { requestId: "req-revenue-pg" },
      requestId: "req-revenue-pg"
    });

    const memoryRepository = new InMemoryRepository();
    const fromMemory = await new ToolExecutionService({
      repository: memoryRepository,
      toolRegistry: createMvpToolRegistry({ repository: memoryRepository })
    }).execute({
      agentId: "finance",
      agentPermissions: createMvpAgentPermissions("finance"),
      toolId: "get_revenue_summary",
      input: { requestId: "req-revenue-mem" },
      requestId: "req-revenue-mem"
    });

    assert.deepEqual(
      fromPostgres.output.result.summary.totalsByCurrency,
      fromMemory.output.result.summary.totalsByCurrency
    );
    assert.equal(
      fromPostgres.output.result.summary.counts.invoices,
      fromMemory.output.result.summary.counts.invoices
    );
  } finally {
    await prisma.$disconnect();
  }
});
