import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  PRODUCTION_CLASSIFICATION_LABELS,
  classifyProductionRecord
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// CDC section 6 defines four production states, and section 31 sorts them into
// different headings. The report used to look for status "ok" or "completed",
// which no tool produces, so what is going well held one signal out of thirty
// two; and it swept every production item into what is late, so an order
// running on time was reported as late.
const HEADING_BY_STATE = Object.freeze({
  ON_TIME: "CE QUI VA BIEN",
  IN_DANGER: "RETARDS / PROBLEMES",
  LATE: "RETARDS / PROBLEMES",
  AT_RISK: "RISQUES / BLOCAGES"
});

async function companyOverview() {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  const response = await inject({
    method: "POST",
    url: "/api/director/requests",
    payload: { message: "Fais-moi le point sur mon entreprise aujourd'hui." }
  });
  assert.equal(response.statusCode, 201);
  return { body: JSON.parse(response.body), close: () => app.close() };
}

function statesIn(body, heading) {
  return [
    ...new Set(
      body.summary.minimumSections[heading]
        .map((entry) => entry.item?.classification)
        .filter(Boolean)
    )
  ].sort();
}

test("the four CDC production states are the ones the report knows", () => {
  for (const state of Object.keys(HEADING_BY_STATE)) {
    assert.ok(state in PRODUCTION_CLASSIFICATION_LABELS, state);
  }
});

test("an order running on time is reported under what is going well", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  assert.ok(statesIn(body, "CE QUI VA BIEN").includes("ON_TIME"));
  assert.ok(
    body.summary.minimumSections["CE QUI VA BIEN"].some((entry) => entry.agent === "production"),
    "production must contribute to what is going well"
  );
});

// The defect that made this lot necessary: the same order was reported as
// running on time and as late at once.
test("an order running on time is never reported as late", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  assert.equal(statesIn(body, "RETARDS / PROBLEMES").includes("ON_TIME"), false);
});

// CDC section 6 keeps "to watch" apart from "late". An at risk order belongs
// under what may block, and it was already reported there by its watch status.
test("an at risk order is reported under what may block, not under what is late", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  assert.ok(statesIn(body, "RISQUES / BLOCAGES").includes("AT_RISK"));
  assert.equal(statesIn(body, "RETARDS / PROBLEMES").includes("AT_RISK"), false);
});

test("a dangerous order is reported under what is late", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  assert.ok(statesIn(body, "RETARDS / PROBLEMES").includes("IN_DANGER"));
});

// No state may vanish: every production order the tools returned is reported
// under one heading or another.
test("every production order reaches at least one heading", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  const planned = new Set(
    body.results
      .filter((result) => result.agent === "production")
      .flatMap((result) => result.result?.items ?? [])
      .map((item) => item.orderId)
  );
  const reported = new Set(
    Object.values(body.summary.minimumSections)
      .flat()
      .map((entry) => entry.item?.orderId)
      .filter(Boolean)
  );

  for (const orderId of planned) {
    assert.ok(reported.has(orderId), `${orderId} is reported nowhere`);
  }
});

test("each production state reaches the heading CDC section 31 assigns it", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  for (const [state, heading] of Object.entries(HEADING_BY_STATE)) {
    const present = body.results
      .filter((result) => result.agent === "production")
      .flatMap((result) => result.result?.items ?? [])
      .some((item) => item.classification === state);

    if (!present) {
      continue;
    }
    assert.ok(statesIn(body, heading).includes(state), `${state} must reach ${heading}`);
  }
});

// LATE is derived, never stored, and the demo data set carries none on its
// operating date. The rule is pinned directly so it is covered even so.
test("a late order would be reported under what is late", () => {
  const late = classifyProductionRecord(
    { orderId: "o1", plannedDate: "2026-08-01", status: "watch", classification: "ON_TIME" },
    { referenceDate: new Date("2026-08-19") }
  );

  assert.equal(late, "LATE");
  assert.equal(HEADING_BY_STATE.LATE, "RETARDS / PROBLEMES");
});

// The signals that look encouraging but are not: an order that is not late yet
// can still be in danger, and an open claim that is not overdue is still open.
test("not being late is not the same as going well", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  const goingWell = body.summary.minimumSections["CE QUI VA BIEN"];

  for (const entry of goingWell) {
    const item = entry.item ?? {};
    assert.notEqual(item.classification, "IN_DANGER", entry.label);
    assert.notEqual(item.classification, "AT_RISK", entry.label);
    assert.notEqual(item.status, "blocked", entry.label);
    assert.notEqual(item.status, "attention_required", entry.label);
  }
  // An after sales ticket carrying overdue: false is not a positive signal.
  assert.equal(goingWell.some((entry) => entry.agent === "after_sales"), false);
});
