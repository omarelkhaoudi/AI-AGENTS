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

function today() {
  return demoDate(0);
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
  const data = createDemoCompanyData();

  assert.notEqual(data.company.operatingDate, FIXTURE_DATE);
  assert.equal(data.company.operatingDate, today());
  assert.equal(
    JSON.stringify(data).includes(FIXTURE_DATE),
    false,
    "no record may still carry the date the fixture was written on"
  );
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
