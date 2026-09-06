import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  collectedItemIdentity,
  isBlockingSignal
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// CDC section 31 is the first deliverable: the ten headings the Director must
// answer with when asked for the state of the company.
const CDC_SECTIONS = Object.freeze([
  "CE QUI VA BIEN",
  "RETARDS / PROBLEMES",
  "A ENCAISSER",
  "A COMMANDER",
  "RISQUES / BLOCAGES",
  "DECISIONS NECESSAIRES",
  "CE QUI NECESSITE UNE ACTION COMMERCIALE",
  "CE QUI NECESSITE UNE ACTION MARKETING OU COMMUNICATION",
  "CE QUI NECESSITE UNE INTERVENTION SAV",
  "CE QUI PRESENTE UN RISQUE JURIDIQUE"
]);

// The six original keys are frozen: this lot adds headings, it does not rename
// any, and a caller reading the report must not have to change.
const ORIGINAL_SECTIONS = Object.freeze(CDC_SECTIONS.slice(0, 6));

// What each of the six original headings reports. A count moving here means a
// change altered what they say, which is a business decision, never a side
// effect. Lot 2 moved an order running on time out of what is late and into
// what is going well, and left an at risk one under what may block only. Lot 9
// took nine signals out of what may block, where they only repeated the
// decision already asked for them.
const ORIGINAL_COUNTS = Object.freeze({
  "CE QUI VA BIEN": 2,
  "RETARDS / PROBLEMES": 2,
  "A ENCAISSER": 2,
  "A COMMANDER": 4,
  "RISQUES / BLOCAGES": 4,
  "DECISIONS NECESSAIRES": 11
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

test("the Director answers with the ten headings CDC section 31 asks for", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  assert.deepEqual(Object.keys(body.summary.minimumSections), CDC_SECTIONS);
});

test("the six original headings keep their exact wording", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  assert.deepEqual(Object.keys(body.summary.minimumSections).slice(0, 6), ORIGINAL_SECTIONS);
});

test("the six original headings report exactly what they reported before", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  for (const [name, expected] of Object.entries(ORIGINAL_COUNTS)) {
    assert.equal(body.summary.minimumSections[name].length, expected, name);
  }
});

// A signal can be both a risk and a decision. Reported under both it was the
// same line twice, in two shapes, with nothing saying it was one reality: nine
// of the eleven decisions repeated a risk already listed. The two headings now
// answer different questions, so what awaits an arbitration is reported where
// the arbitration is asked for and nowhere else.
test("a signal awaiting a decision is not reported again as a risk", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  const sections = body.summary.minimumSections;
  const decided = new Set(
    sections["DECISIONS NECESSAIRES"]
      .filter((decision) => decision.type === "business_decision")
      .map((decision) => decision.itemId)
  );

  assert.ok(decided.size > 0, "the overview must actually ask for decisions");
  assert.ok(sections["RISQUES / BLOCAGES"].length > 0, "and still report risks");

  for (const entry of sections["RISQUES / BLOCAGES"]) {
    assert.equal(
      decided.has(entry.item.id ?? entry.item.orderId ?? entry.item.subject ?? entry.item.label),
      false,
      `${entry.label} is reported as a risk while a decision is already asked for it`
    );
  }

  // The identity the Director itself uses, so the check does not rest on a
  // resemblance of labels. A tool is not part of it: the same order reaches the
  // Director through more than one tool and is one order either way.
  const risks = new Set(
    sections["RISQUES / BLOCAGES"].map((entry) => collectedItemIdentity(entry.domain, entry.item))
  );
  assert.equal(risks.size, sections["RISQUES / BLOCAGES"].length, "no risk is listed twice either");
});

// urgency and status are lower case in the records, priority is upper case on
// some and lower on others. Compared as written, "critical" was matched by
// nothing, and the single most severe signal of the demo set never reached the
// risks heading. Read here without the case, at the level the rule lives.
test("a critical signal counts as a risk, whatever case it is written in", async (t) => {
  assert.equal(isBlockingSignal({ urgency: "critical" }), true);
  assert.equal(isBlockingSignal({ priority: "CRITICAL" }), true);
  assert.equal(isBlockingSignal({ priority: "HIGH" }), true);
  assert.equal(isBlockingSignal({ status: "BLOCKED" }), true);
  assert.equal(isBlockingSignal({ delayRisk: "high" }), true);
  assert.equal(isBlockingSignal({ urgency: "watch" }), true);

  // A medium signal is not a blocker, and neither is an absent one. A priority
  // of "watch" does not exist in the records and must not start meaning risk.
  assert.equal(isBlockingSignal({ urgency: "medium" }), false);
  assert.equal(isBlockingSignal({ priority: "watch" }), false);
  assert.equal(isBlockingSignal({ delayRisk: "low" }), false);
  assert.equal(isBlockingSignal({}), false);
  assert.equal(isBlockingSignal(undefined), false);

  // And the critical record of the demo set is reported, under the heading that
  // asks for the arbitration it needs.
  const { body, close } = await companyOverview();
  t.after(close);

  const critical = body.results
    .flatMap((result) => result.result?.items ?? [])
    .filter((item) => isBlockingSignal(item) && String(item.urgency).toLowerCase() === "critical");

  assert.equal(critical.length, 1, "the demo set carries exactly one critical signal");
  const reported = Object.values(body.summary.minimumSections)
    .flat()
    .some((entry) => (entry.item?.id ?? entry.itemId) === critical[0].id);
  assert.ok(reported, "a critical signal is never absent from the report");
});

// CDC section 29 lists orders among the fifteen things its question must answer.
// The figure is the order book: how many are registered, and in which state. The
// workshop holds one file more, and calling that a third order would report a
// commitment nobody registered.
test("the order book figure counts the registered orders, not the workshop files", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  const orders = body.summary.aggregates.orders;

  assert.ok(orders, "CDC section 29 asks for orders in the answer to this question");
  assert.equal(orders.tool, "get_order_book_summary");
  assert.equal(orders.counts.orders, 2);
  assert.deepEqual(orders.countsByStatus, { in_production: 1, scheduled: 1 });
  // The statuses account for every order and invent none.
  assert.equal(
    Object.values(orders.countsByStatus).reduce((total, count) => total + count, 0),
    orders.counts.orders
  );

  // The schedule reports three records for those two orders.
  const schedule = body.results.find((result) => result.tool === "get_production_schedule");
  assert.equal(schedule.result.items.length, 3);
});

// Orders carry no amount, in the schema, in the ingestion or in the demo set. A
// valued order book would therefore be invented, and this says so in a way that
// fails rather than in a comment that does not.
test("the order book figure carries no valuation of any kind", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  const orders = body.summary.aggregates.orders;

  for (const key of ["amount", "currency", "total", "totalsByCurrency", "value"]) {
    assert.equal(key in orders, false, key);
  }
  assert.equal(JSON.stringify(orders).toLowerCase().includes("currency"), false);
});

// A production file whose order was never registered is an anomaly to look at,
// not an order to add. It reached the response and no heading before Lot 14,
// because deduplication keeps the entry of the tool that does not carry the flag.
test("a production file with no registered order is named, never counted", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  const production = body.summary.aggregates.production;

  assert.deepEqual(production.productionWithoutOrder, ["order-sample-003"]);
  assert.equal(production.counts.withoutOrder, 1);
  assert.equal(production.counts.records, 3);
  // And it is not in the order book.
  assert.equal(body.summary.aggregates.orders.counts.orders, 2);
});

// Lot 6 learned this on section A ENCAISSER and Lot 9 spent itself undoing it: a
// tool that feeds a heading with records another tool already reports lists the
// same signal twice, and the identity of a signal includes its domain, so the
// deduplication cannot see it. The order book figure reports no item at all.
test("the order book tool adds no entry to any heading", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  const orderBook = body.results.find((result) => result.tool === "get_order_book_summary");
  assert.deepEqual(orderBook.result.items, []);

  const sections = body.summary.minimumSections;
  assert.equal(
    Object.values(sections).flat().some((entry) => entry.tool === "get_order_book_summary"),
    false,
    "a figure belongs beside the headings, never inside one"
  );

  // And no business signal is reported twice under one heading.
  for (const [heading, entries] of Object.entries(sections)) {
    const identities = entries
      .map((entry) => collectedItemIdentity(entry.domain, entry.item))
      .filter((identity) => identity !== null);
    assert.equal(new Set(identities).size, identities.length, heading);
  }
});

test("every heading carries at least one entry on the company overview", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  for (const name of CDC_SECTIONS) {
    assert.ok(body.summary.minimumSections[name].length > 0, `${name} is empty`);
  }
});

// The four additions come from agents that already answered. Each one must
// report its own agent's work and nothing else.
test("each new heading reports the agents it is about", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  const agentsOf = (name) => [
    ...new Set(body.summary.minimumSections[name].map((entry) => entry.agent))
  ].sort();

  assert.deepEqual(agentsOf("CE QUI NECESSITE UNE ACTION COMMERCIALE"), ["commercial"]);
  assert.deepEqual(agentsOf("CE QUI NECESSITE UNE ACTION MARKETING OU COMMUNICATION"), [
    "community_manager",
    "marketing"
  ]);
  assert.deepEqual(agentsOf("CE QUI NECESSITE UNE INTERVENTION SAV"), ["after_sales"]);
  assert.deepEqual(agentsOf("CE QUI PRESENTE UN RISQUE JURIDIQUE"), ["legal"]);
});

test("the new headings read as business statements, like the others", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  for (const name of CDC_SECTIONS.slice(6)) {
    for (const entry of body.summary.minimumSections[name]) {
      const label = entry.label ?? entry.reason;
      assert.equal(typeof label, "string", name);
      assert.ok(label.trim().length > 0, name);
      assert.equal(label.includes("undefined"), false, `${name}: ${label}`);
      assert.equal(label.includes("[object Object]"), false, `${name}: ${label}`);
    }
  }
});

// Nothing was derived: the additions expose sections the summary already
// computed, so they must match them entry for entry.
test("the new headings expose sections the report already computed", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  const { minimumSections, afterSales, legal, commercial, marketingCommunication } = body.summary;

  assert.deepEqual(minimumSections["CE QUI NECESSITE UNE INTERVENTION SAV"], afterSales);
  assert.deepEqual(minimumSections["CE QUI PRESENTE UN RISQUE JURIDIQUE"], legal);
  assert.deepEqual(minimumSections["CE QUI NECESSITE UNE ACTION COMMERCIALE"], commercial);
  assert.deepEqual(
    minimumSections["CE QUI NECESSITE UNE ACTION MARKETING OU COMMUNICATION"],
    marketingCommunication
  );
});

test("the headline and the aggregates are untouched by the added headings", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  assert.match(body.summary.headline, /Point complete: 9\/9 agents responded/);
  assert.match(body.summary.headline, /9 high-priority demo signal\(s\)/);
  assert.deepEqual(body.summary.aggregates.payments.totalsByCurrency, { MAD: 20500 });
  // Lot 6 adds the revenue figure of CDC section 29, beside the receivables and
  // never inside a heading: the ten headings are unchanged.
  assert.deepEqual(body.summary.aggregates.invoices.totalsByCurrency, { MAD: 20500 });
  // Lot 14 adds the order book figure of CDC section 29, also beside the headings
  // and never inside one: it reports no item at all.
  assert.equal(body.summary.aggregates.orders.counts.orders, 2);
  assert.equal(body.results.length, 15);
});

// A heading the Director answers but the cockpit does not list is a heading the
// reader never sees.
test("the cockpit lists the ten headings the Director answers", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const script = await inject({ method: "GET", url: "/app/app.js" });

  assert.equal(script.statusCode, 200);
  for (const name of CDC_SECTIONS) {
    assert.ok(script.body.includes(name), `the cockpit must list ${name}`);
  }
});
