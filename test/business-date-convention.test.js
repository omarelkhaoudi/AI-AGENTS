import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProductionRecord,
  createDemoCompanyData,
  createProductionSchedule,
  createReceivablesSummary,
  demoDate,
  demoReferenceDate,
  getOverdueInvoices,
  isInvoiceOverdue,
  isReceivableOverdue
} from "../src/index.js";

// The demo set carried absolute dates anchored on a fixed operating date, and
// production lateness defaulted to that date. A real order whose deadline had
// passed was compared to 2026-08-13 and reported as running on time, months
// after the fact. The clock is the reference for real data; the demo set is
// expressed relative to the day it is built so it stays demonstrable.
const FIXTURE_DATE = "2026-08-13";

// The set is built on a day chosen here rather than on whichever day the suite
// runs. Every offset in the demo set lies between -12 and +17 days, so on 17
// real days of the calendar one of those offsets lands exactly on FIXTURE_DATE
// and a check for its absence failed while nothing had regressed. A check that
// no date is frozen to the fixture cannot itself depend on the calendar.
const PINNED = new Date("2030-06-15T00:00:00Z");

function today() {
  return demoDate(0);
}

// Every string in the set that carries a date, with the path that reaches it, so
// a failure names the field rather than the whole record.
function collectDates(node, path = "data", found = []) {
  if (node === null || node === undefined) {
    return found;
  }
  if (typeof node === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(node)) {
      found.push([path, node]);
    }
    return found;
  }
  if (Array.isArray(node)) {
    node.forEach((value, index) => collectDates(value, `${path}[${index}]`, found));
    return found;
  }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      collectDates(value, `${path}.${key}`, found);
    }
  }
  return found;
}

test("no business computation defaults to a fixture date", () => {
  // A deadline that passed yesterday is late, whatever day this test runs.
  const overdueOrder = { orderId: "o1", plannedDate: demoDate(-1), classification: "ON_TIME" };
  assert.equal(classifyProductionRecord(overdueOrder), "LATE");

  const schedule = createProductionSchedule({ production: [overdueOrder], orders: [] });
  assert.equal(schedule[0].classification, "LATE");
  assert.equal(schedule[0].late, true);
});

test("the fixture date is gone from the demo set", () => {
  const data = createDemoCompanyData({ referenceDate: PINNED });

  assert.equal(data.company.operatingDate, demoDate(0, PINNED));
  assert.equal(
    JSON.stringify(data).includes(FIXTURE_DATE),
    false,
    "no record may still carry the date the fixture was written on"
  );
  // The check above is only worth something if the fixture date is a date this
  // set can still produce. Built twelve days after it, an offset lands on it and
  // the set does carry it. That is the collision the old check mistook for a
  // regression, and it is what keeps the absence at PINNED from passing for the
  // wrong reason: unreachable, that assertion would hold over anything at all.
  const collisionDay = new Date(Date.parse(`${FIXTURE_DATE}T00:00:00Z`) + 12 * 86400000);
  assert.equal(
    JSON.stringify(createDemoCompanyData({ referenceDate: collisionDay })).includes(FIXTURE_DATE),
    true,
    "the fixture date must stay reachable, or its absence proves nothing"
  );
  // Pinning is for fixtures. Built with no reference, the set still follows the
  // clock, which is what makes the demo demonstrable whenever it runs.
  assert.equal(createDemoCompanyData().company.operatingDate, today());
});

// A check on one value can only ever catch the one date it names, and only on
// the days that value is reachable. Rebuilding the set at two references catches
// any date that does not move: every relative date shifts by the same delta,
// while a literal frozen anywhere in the set stays exactly where it was written.
test("every date in the demo set moves with the reference", () => {
  const DELTA_DAYS = 4001;
  const later = new Date(PINNED.getTime() + DELTA_DAYS * 86400000);

  const from = collectDates(createDemoCompanyData({ referenceDate: PINNED }));
  const to = collectDates(createDemoCompanyData({ referenceDate: later }));

  assert.ok(from.length >= 38, `the walk must reach the dates it checks, found ${from.length}`);
  assert.deepEqual(
    to.map(([path]) => path),
    from.map(([path]) => path),
    "the two builds must have the same shape, or they are not comparable"
  );

  for (const [index, [path, value]] of from.entries()) {
    assert.equal(
      (Date.parse(to[index][1]) - Date.parse(value)) / 86400000,
      DELTA_DAYS,
      `${path} does not follow the reference: it is frozen to ${value}`
    );
  }
});

// The rule the whole convention exists for: a date belonging to a fixture must
// never decide whether a real order is late. The reference builds the set and
// reaches no computation. Pinned in 2020, every date of the set is years behind
// the clock, so every measurement has to say so.
test("an injected reference builds the demo set and decides nothing else", () => {
  const past = createDemoCompanyData({ referenceDate: new Date("2020-01-01T00:00:00Z") });

  assert.deepEqual(
    createProductionSchedule(past).map((item) => item.late),
    [true, true, true],
    "orders planned in 2020 are late: the build reference must not excuse them"
  );
  assert.equal(isInvoiceOverdue(past.invoices[0]), true);
  assert.equal(isReceivableOverdue(past.payments[0]), true);
  // classifyProductionRecord keeps its own default too, which is the clock.
  assert.equal(classifyProductionRecord(past.production[0]), "LATE");

  // And a reference given to the builder never becomes the default anywhere.
  assert.notEqual(demoDate(0), demoDate(0, new Date("2020-01-01T00:00:00Z")));
});

test("a real invoice past its due date is overdue against the clock", () => {
  const past = { id: "i1", status: "issued", dueAt: demoDate(-1) };
  const future = { id: "i2", status: "issued", dueAt: demoDate(1) };

  assert.equal(isInvoiceOverdue(past), true);
  assert.equal(isInvoiceOverdue(future), false);
  assert.deepEqual(
    getOverdueInvoices({ invoices: [past, future] }).map((invoice) => invoice.overdue),
    [true, false]
  );
});

test("a real receivable past its due date is overdue against the clock", () => {
  assert.equal(isReceivableOverdue({ expectedPaymentDate: demoDate(-1) }), true);
  assert.equal(isReceivableOverdue({ expectedPaymentDate: demoDate(1) }), false);
});

// A reference stays injectable: that is how a fixture pins a moment, and how
// the four CDC states are exercised without waiting for the calendar.
test("an explicit reference still drives every derivation", () => {
  const record = { orderId: "o1", plannedDate: demoDate(5), classification: "ON_TIME" };

  assert.equal(classifyProductionRecord(record), "ON_TIME");
  assert.equal(classifyProductionRecord(record, { referenceDate: new Date(demoDate(10)) }), "LATE");
  assert.equal(demoReferenceDate().toISOString().slice(0, 10), today());
});

// The demo set must stay demonstrable: the states the Director sorts into
// different CDC headings have to remain visible whenever it runs.
test("the demo set still shows three distinct production states", () => {
  const data = createDemoCompanyData();

  assert.deepEqual(
    createProductionSchedule(data).map((item) => item.classification),
    ["IN_DANGER", "AT_RISK", "ON_TIME"]
  );
  assert.equal(
    createProductionSchedule(data).every((item) => item.late === false),
    true,
    "no demo order is past its deadline, so stored states are what is shown"
  );
});

test("the demo set still shows an overdue receivable", () => {
  const data = createDemoCompanyData();
  const summary = createReceivablesSummary(data).summary;

  assert.deepEqual(summary.totalsByCurrency, { MAD: 20500 });
  assert.deepEqual(summary.overdueTotalsByCurrency, { MAD: 20500 });
  assert.equal(summary.counts.overdue, 2);
});

// The dates used to contradict the fields stored beside them: a payment stating
// daysLate 2 was dated three days in the future. They now agree.
test("the demo dates agree with the fields stored beside them", () => {
  const data = createDemoCompanyData();
  const deposit = data.payments.find((payment) => payment.id === "payment-atlas-deposit");
  const balance = data.payments.find((payment) => payment.id === "payment-nova-balance");

  assert.equal(deposit.dueStatus, "overdue");
  assert.equal(deposit.expectedPaymentDate, demoDate(-deposit.daysLate));
  assert.equal(balance.dueStatus, "due_today");
  assert.equal(balance.expectedPaymentDate, today());

  const claim = data.afterSales.find((ticket) => ticket.id === "case-sav-001");
  assert.equal(claim.openedAt, demoDate(-claim.daysOpen));
  assert.equal(claim.overdue, true);
  assert.ok(claim.dueAt < today(), "an overdue claim is past its due date");
});

// Rebuilding the set on a later day must produce the same shape, not drift.
test("the demo set keeps its shape whatever day it is built", () => {
  const data = createDemoCompanyData();
  const offsets = data.production.map(
    (record) => (Date.parse(record.plannedDate) - Date.parse(today())) / 86400000
  );

  assert.deepEqual(offsets, [1, 5, 7], "the planned dates keep their spacing");
  assert.ok(offsets.every((offset) => offset > 0), "and stay ahead of today");
});
