import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository, buildApi } from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// The route the cockpit calls to ask for a quote from a product datasheet. It
// exists because the Director builds a fixed input for every step it plans, so a
// reference, a customer and a quantity have no way through it. Everything under
// the route is the existing circuit: same service, same permissions, same
// approval.

const NOMINAL = Object.freeze({
  productReference: "PRD-ATLAS-PANEL",
  customerId: "customer-atlas",
  quantity: 12
});

async function createApi(t) {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository });
  t.after(() => app.close());
  return { app, inject, repository };
}

function ask(inject, payload) {
  return inject({ method: "POST", url: "/api/quotes/datasheet", payload });
}

test("a datasheet with one price in force asks a person to approve the quote", async (t) => {
  const { inject } = await createApi(t);

  const response = await ask(inject, NOMINAL);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 202);
  assert.equal(body.status, "approval_required");

  // The datasheet the quote was built from, as the price list holds it.
  assert.equal(body.datasheet.reference, "PRD-ATLAS-PANEL");
  assert.equal(body.datasheet.datasheet.name, "Demo Atlas Panel");
  assert.equal(body.datasheet.datasheet.unit, "unit");
  assert.equal(body.datasheet.datasheet.imageRef, "demo/products/prd-atlas-panel.jpg");
  assert.equal(body.datasheet.prices.length, 1);
  assert.equal(body.datasheet.prices[0].amount, 4200);
  assert.equal(body.datasheet.prices[0].currency, "MAD");
  assert.deepEqual(body.datasheet.issues, []);
});

// CDC section 17 level 3: the agent prepares, the human authorises. The route
// answers with the approval a person now has to decide on, and with no quote.
test("the route opens a real approval and returns no quote of its own", async (t) => {
  const { inject } = await createApi(t);

  const body = JSON.parse((await ask(inject, NOMINAL)).body);
  const approval = body.approval;

  assert.ok(approval, "an approval must exist for a person to decide on");
  assert.equal(approval.status, "pending");
  assert.equal(approval.requestedAction, "prepare_quote_from_datasheet");
  assert.equal(approval.risk, "medium");
  assert.equal(approval.requestingAgent, "commercial");
  assert.equal(approval.approverId, null, "nobody has decided yet");
  assert.equal(approval.decidedAt, null);

  // The prepared quote is not in the answer. It exists once a person approves,
  // and not before: the route must not let a caller read it early.
  assert.equal(JSON.stringify(body).includes("fromPriceList"), false);
  assert.deepEqual(
    Object.keys(body).sort(),
    ["approval", "datasheet", "planStep", "request", "status"]
  );
});

test("the approval is retrievable through the existing approvals route", async (t) => {
  const { inject } = await createApi(t);

  const created = JSON.parse((await ask(inject, NOMINAL)).body).approval;
  const listing = await inject({ method: "GET", url: "/api/approvals" });
  const found = JSON.parse(listing.body).approvals.find((entry) => entry.id === created.id);

  assert.equal(listing.statusCode, 200);
  assert.ok(found, "the cockpit reads this route, so the card comes from it");
  assert.equal(found.status, "pending");
  assert.equal(found.requestedAction, "prepare_quote_from_datasheet");
});

test("the request, the plan and the step exist before anything runs", async (t) => {
  const { inject, repository } = await createApi(t);

  const body = JSON.parse((await ask(inject, NOMINAL)).body);
  const saved = await repository.getRequest(body.request.id);

  assert.equal(saved.source, "datasheet_quote");
  assert.deepEqual(saved.payload, NOMINAL);
  assert.equal(saved.plans[0].createdByAgentId, "commercial");
  assert.equal(saved.plans[0].steps[0].toolName, "prepare_quote_from_datasheet");
  assert.equal(saved.plans[0].steps[0].requiresApproval, true);
  assert.ok(saved.auditEvents.some((event) => event.type === "request_created"));
});

// --- the three ways the data can refuse to answer -------------------------

test("an unknown reference refuses without opening an approval", async (t) => {
  const { inject } = await createApi(t);

  const response = await ask(inject, { ...NOMINAL, productReference: "PRD-DOES-NOT-EXIST" });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.status, "refused");
  assert.deepEqual(body.datasheet.issues, ["unknown_product_reference"]);
  assert.equal(body.approval, undefined, "nobody is asked to decide on nothing");
  assert.equal(body.datasheet.datasheet, null);
  assert.deepEqual(body.datasheet.prices, []);
});

test("a product with no price refuses, and no amount is produced for it", async (t) => {
  const { inject } = await createApi(t);

  const response = await ask(inject, { ...NOMINAL, productReference: "MAT-ALU-A" });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.status, "refused");
  assert.deepEqual(body.datasheet.issues, ["no_price_for_product"]);
  assert.equal(body.approval, undefined);
  assert.deepEqual(body.datasheet.prices, [], "no price means no price, not zero");
});

// Both tariffs are shown so a person can see what the ambiguity is. Neither is
// picked: choosing one would state a decision nobody took.
test("two prices in force refuse, showing both and selecting neither", async (t) => {
  const { inject } = await createApi(t);

  const response = await ask(inject, { ...NOMINAL, productReference: "MAT-PACK-B" });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.status, "refused");
  assert.deepEqual(body.datasheet.issues, ["several_prices_in_force"]);
  assert.equal(body.approval, undefined);
  assert.deepEqual(
    body.datasheet.prices.map((price) => price.amount).sort((a, b) => a - b),
    [18, 21]
  );
});

// --- input and access -----------------------------------------------------

test("the route refuses a body it cannot act on", async (t) => {
  const { inject } = await createApi(t);

  const cases = [
    [{}, "productReference is required."],
    [{ productReference: "PRD-ATLAS-PANEL" }, "customerId is required."],
    [{ ...NOMINAL, quantity: 0 }, "quantity must be a positive number."],
    [{ ...NOMINAL, quantity: -3 }, "quantity must be a positive number."],
    [{ ...NOMINAL, quantity: "douze" }, "quantity must be a positive number."],
    [{ ...NOMINAL, createdById: "someone-else" }, "createdById is not accepted: the authenticated principal is the author."]
  ];

  for (const [payload, expected] of cases) {
    const response = await ask(inject, payload);
    const body = JSON.parse(response.body);

    assert.equal(response.statusCode, 400, expected);
    assert.equal(body.error, expected);
    assert.equal(body.details.code, "INVALID_INPUT");
  }
});

test("an anonymous caller reaches nothing", async (t) => {
  const app = buildApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/api/quotes/datasheet",
    payload: NOMINAL
  });

  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).details.code, "AUTHENTICATION_REQUIRED");
});

// The route never runs the preparation itself: it asks the service, and the
// service refuses without a human. If that ever stopped holding, the route
// throws rather than reporting a success nobody authorised.
test("the route carries a guard against a quote prepared without approval", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile("src/api/server.js", "utf8"));

  assert.match(source, /APPROVAL_NOT_ENFORCED/);
  assert.match(source, /The quote was prepared without a human approval\./);
});
