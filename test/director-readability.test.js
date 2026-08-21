import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_SECURITY_DOMAINS,
  InMemoryRepository,
  describeBusinessItem
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

const SECTION_NAMES = Object.freeze([
  "CE QUI VA BIEN",
  "RETARDS / PROBLEMES",
  "A ENCAISSER",
  "A COMMANDER",
  "RISQUES / BLOCAGES",
  "DECISIONS NECESSAIRES"
]);

// Counts are frozen on purpose: this commit changes how entries read, never how
// many there are. A count moving here means the rendering changed the selection.
const SECTION_COUNTS = Object.freeze({
  "CE QUI VA BIEN": 1,
  "RETARDS / PROBLEMES": 4,
  "A ENCAISSER": 2,
  "A COMMANDER": 4,
  "RISQUES / BLOCAGES": 13,
  "DECISIONS NECESSAIRES": 11
});

// A technical identifier is a slug the demo data uses as a key. None of them
// should ever be what a manager reads first.
const TECHNICAL_IDENTIFIER = /^(order|payment|quote|invoice|purchase|customer|supplier|material|bom|case|campaign|community|legal|hr|contract|employee|product|stock)-/;

async function companyOverview() {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  const response = await inject({
    method: "POST",
    url: "/api/director/requests",
    payload: { message: "Fais-moi le point sur mon entreprise aujourd'hui." }
  });
  const body = JSON.parse(response.body);
  return { body, close: () => app.close() };
}

test("every section entry reads as a business statement", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  for (const name of SECTION_NAMES) {
    const entries = body.summary.minimumSections[name];
    assert.ok(entries.length > 0, `${name} must not be empty`);

    for (const entry of entries) {
      const label = entry.label ?? entry.reason;
      assert.equal(typeof label, "string", `${name}: every entry carries a label`);
      assert.ok(label.trim().length > 0, `${name}: no empty label`);
      assert.equal(label.includes("undefined"), false, `${name}: ${label}`);
      assert.equal(label.includes("null"), false, `${name}: ${label}`);
      assert.equal(label.includes("[object Object]"), false, `${name}: ${label}`);
    }
  }
});

test("no technical identifier is used as the primary label", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  for (const name of SECTION_NAMES) {
    for (const entry of body.summary.minimumSections[name]) {
      const label = entry.label ?? entry.reason;
      const head = label.split(" - ")[0];
      assert.doesNotMatch(head, TECHNICAL_IDENTIFIER, `${name}: "${label}" leads with an identifier`);
    }
  }
});

// The identifier is not thrown away: it moves out of the label and into its own
// field, so a caller that needs to act on the record still has it.
test("the technical identifier stays available under its own field", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  const entries = body.summary.minimumSections["A ENCAISSER"];

  assert.deepEqual(entries.map((entry) => entry.reference), [
    "payment-atlas-deposit",
    "payment-nova-balance"
  ]);
  assert.ok(entries.every((entry) => "item" in entry), "the raw record is still there");
});

test("a receivable reports its amount with its currency", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  assert.deepEqual(body.summary.minimumSections["A ENCAISSER"].map((entry) => entry.label), [
    "Demo Client Atlas - 12000 MAD - en retard de 2 jour(s)",
    "Demo Client Nova - 8500 MAD - echeance aujourd'hui"
  ]);
});

// An amount without its currency is meaningless, and two currencies added
// together are money that does not exist.
test("an amount is never rendered without its currency, and never summed", () => {
  assert.equal(describeBusinessItem({ id: "x", amount: 500, currency: "EUR" }), "500 EUR");
  // No currency: the figure is not reported at all rather than reported bare.
  assert.equal(describeBusinessItem({ id: "payment-x", amount: 500 }), "payment-x");
  assert.equal(describeBusinessItem({ id: "payment-x", currency: "MAD" }), "payment-x");

  const first = describeBusinessItem({ id: "a", customerName: "Cli", amount: 100, currency: "MAD" });
  const second = describeBusinessItem({ id: "b", customerName: "Cli", amount: 200, currency: "EUR" });

  assert.equal(first, "Cli - 100 MAD");
  assert.equal(second, "Cli - 200 EUR");
  assert.equal(first.includes("300"), false, "two currencies are never merged");
});

test("a customer identifier is resolved to the customer name", () => {
  assert.equal(
    describeBusinessItem({ id: "payment-x", customerId: "customer-atlas", amount: 1, currency: "MAD" }),
    "Demo Client Atlas - 1 MAD"
  );
  // A name carried by the record itself wins over the directory.
  assert.equal(
    describeBusinessItem({ id: "x", customerId: "customer-atlas", customerName: "Nom porte" }),
    "Nom porte"
  );
});

// A production record names an order, and an order names its customer.
test("a customer is resolved through the order when the record names no customer", () => {
  assert.equal(
    describeBusinessItem({ orderId: "order-atlas-001", timing: "en danger" }),
    "Demo Client Atlas - en danger"
  );
  // The indirect route never wins over the record's own subject: a material
  // shortage names an order, but its subject is the material.
  assert.equal(
    describeBusinessItem({ orderId: "order-atlas-001", productName: "Tole", shortage: 20, unit: "sheets" }),
    "Tole - manque 20 sheets"
  );
});

test("an unknown customer keeps its identifier instead of being given a name", () => {
  assert.equal(
    describeBusinessItem({ id: "payment-x", customerId: "customer-ghost", amount: 5, currency: "MAD" }),
    "customer-ghost - 5 MAD"
  );
  // An order that resolves to nothing invents neither an order nor a customer.
  assert.equal(describeBusinessItem({ orderId: "order-ghost", timing: "en danger" }), "en danger");
});

test("an item carrying nothing readable falls back to its identifier, never to undefined", () => {
  assert.equal(describeBusinessItem({ id: "payment-x" }), "payment-x");
  assert.equal(describeBusinessItem({ orderId: "order-x" }), "order-x");
  assert.equal(describeBusinessItem({ lineId: "line-x" }), "line-x");
  assert.equal(describeBusinessItem({}), "Signal sans libelle");
  assert.equal(describeBusinessItem(null), "Signal sans libelle");
  // Blank strings are not names.
  assert.equal(describeBusinessItem({ id: "payment-x", customerName: "   " }), "payment-x");
});

test("the section counts are exactly what they were before the rendering", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  for (const [name, expected] of Object.entries(SECTION_COUNTS)) {
    assert.equal(body.summary.minimumSections[name].length, expected, name);
  }
  assert.equal(body.results.length, 13);
});

test("the headline still reports nine agents out of nine", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  assert.match(body.summary.headline, /Point complete: 9\/9 agents responded/);
  assert.match(body.summary.headline, /9 high-priority demo signal\(s\)/);
});

test("the aggregates are untouched by the rendering", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  assert.deepEqual(body.summary.aggregates.payments.totalsByCurrency, { MAD: 20500 });
  assert.equal(body.summary.aggregates.purchase_needs.counts.shortages, 2);
  // The aggregate is still beside the sections, never inside them.
  assert.ok(body.summary.minimumSections["A ENCAISSER"].every((entry) => !("totalsByCurrency" in entry)));
});

// Reading a customer name is a local join on data the demo memory already
// holds. It must never have widened any agent scope.
test("no agent scope moved to make the sections readable", () => {
  assert.deepEqual([...AGENT_SECURITY_DOMAINS.director], ["company_overview"]);
  assert.deepEqual([...AGENT_SECURITY_DOMAINS.finance], [
    "company_overview",
    "payments",
    "customers",
    "invoices"
  ]);
  assert.deepEqual([...AGENT_SECURITY_DOMAINS.production], ["production", "orders"]);
  assert.deepEqual([...AGENT_SECURITY_DOMAINS.hr], ["hr"]);
});

test("a decision names the signal it is about", async (t) => {
  const { body, close } = await companyOverview();
  t.after(close);

  const business = body.decisionsRequired.filter((decision) => decision.type === "business_decision");

  assert.ok(business.length > 0);
  for (const decision of business) {
    assert.equal(typeof decision.label, "string", decision.itemId);
    assert.doesNotMatch(decision.label.split(" - ")[0], TECHNICAL_IDENTIFIER, decision.label);
    // The reason to act is still there, next to the signal it concerns.
    assert.equal(typeof decision.reason, "string");
  }
});
