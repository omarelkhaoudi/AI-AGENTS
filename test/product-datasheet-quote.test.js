import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  ToolExecutionService,
  ToolExecutionServiceError,
  createDemoCompanyData,
  createMvpAgentPermissions,
  createMvpToolRegistry,
  createProductDatasheet,
  prepareQuoteFromDatasheet
} from "../src/index.js";

// The test asked for by the client: hand the agent a datasheet, a picture
// reference and a price list, ask it to find the product and prepare a quote
// with the same reference and the same figures, and check that it never fills a
// gap. The three ways the data can fail to answer are exercised on purpose.

function createHarness() {
  const repository = new InMemoryRepository();
  return new ToolExecutionService({
    repository,
    toolRegistry: createMvpToolRegistry({ repository })
  });
}

async function run(service, toolId, input, { agentId = "commercial" } = {}) {
  const requestId = `req-${toolId}-${Math.random().toString(16).slice(2)}`;
  const execution = await service.execute({
    agentId,
    agentPermissions: createMvpAgentPermissions(agentId),
    toolId,
    input: { requestId, ...input },
    requestId
  });
  return execution.output.result.summary;
}

test("the datasheet is found by the reference a person reads on it", async () => {
  const summary = await run(createHarness(), "get_product_datasheet", {
    productReference: "PRD-ATLAS-PANEL"
  });

  assert.equal(summary.reference, "PRD-ATLAS-PANEL");
  assert.equal(summary.datasheet.id, "product-atlas-panel");
  assert.equal(summary.datasheet.name, "Demo Atlas Panel");
  assert.equal(summary.datasheet.unit, "unit");
  assert.deepEqual(summary.issues, []);
});

// A picture is referenced, never carried. The business memory stores where to
// find the file; no byte of it ever passes through.
test("the datasheet carries an image reference and no file", async () => {
  const summary = await run(createHarness(), "get_product_datasheet", {
    productReference: "PRD-ATLAS-PANEL"
  });

  assert.equal(summary.datasheet.imageRef, "demo/products/prd-atlas-panel.jpg");
  assert.equal(JSON.stringify(summary).includes("base64"), false);
  assert.equal("imageData" in summary.datasheet, false);
});

test("the price in force comes from the price list, with its currency and unit", async () => {
  const summary = await run(createHarness(), "get_product_datasheet", {
    productReference: "PRD-ATLAS-PANEL"
  });

  assert.equal(summary.prices.length, 1);
  assert.equal(summary.prices[0].amount, 4200);
  assert.equal(summary.prices[0].currency, "MAD");
  assert.equal(summary.prices[0].unit, "unit");
  assert.equal(summary.prices[0].productReference, "PRD-ATLAS-PANEL");
});

// What the client asked to see: the prepared quote says the same thing as the
// source, field by field, and says where each value came from.
test("the prepared quote repeats the datasheet and the price without altering them", () => {
  const data = createDemoCompanyData();
  const sheet = createProductDatasheet(data, { productReference: "PRD-ATLAS-PANEL" });
  const quote = prepareQuoteFromDatasheet(data, {
    productReference: "PRD-ATLAS-PANEL",
    customerId: "customer-atlas",
    quantity: 12
  });

  assert.equal(quote.status, "pending_approval");
  assert.deepEqual(quote.fromDatasheet, sheet.datasheet);
  assert.deepEqual(quote.fromPriceList, sheet.prices[0]);
  assert.deepEqual(quote.fromRequest, { customerId: "customer-atlas", quantity: 12 });
  assert.deepEqual(quote.issues, []);

  // Three provenances, kept apart: a reader can tell where every value came
  // from. And no fourth block: quantity times price belongs to none of them.
  assert.deepEqual(
    Object.keys(quote).sort(),
    ["fromDatasheet", "fromPriceList", "fromRequest", "issues", "status"]
  );
  assert.equal("total" in quote, false);
});

// --- the three ways the data can refuse to answer -------------------------

test("an unknown reference is reported, and no price is offered for it", async () => {
  const summary = await run(createHarness(), "get_product_datasheet", {
    productReference: "PRD-DOES-NOT-EXIST"
  });

  assert.deepEqual(summary.issues, ["unknown_product_reference"]);
  assert.equal(summary.reference, "PRD-DOES-NOT-EXIST");
  assert.equal(summary.datasheet, null);
  assert.deepEqual(summary.prices, []);
});

test("a product with no price is reported, and no amount is produced for it", async () => {
  const summary = await run(createHarness(), "get_product_datasheet", {
    productReference: "MAT-ALU-A"
  });

  assert.deepEqual(summary.issues, ["no_price_for_product"]);
  assert.equal(summary.datasheet.reference, "MAT-ALU-A");
  assert.deepEqual(summary.prices, [], "no price means no price, not zero");
});

// Two tariffs in force is not a choice to make on the reader's behalf.
test("two prices in force are both reported and neither is chosen", async () => {
  const summary = await run(createHarness(), "get_product_datasheet", {
    productReference: "MAT-PACK-B"
  });

  assert.deepEqual(summary.issues, ["several_prices_in_force"]);
  assert.deepEqual(summary.prices.map((price) => price.amount).sort((a, b) => a - b), [18, 21]);
});

test("each refusal names the reason and carries no amount at all", () => {
  const data = createDemoCompanyData();
  const cases = [
    ["PRD-DOES-NOT-EXIST", "unknown_product_reference"],
    ["MAT-ALU-A", "no_price_for_product"],
    ["MAT-PACK-B", "several_prices_in_force"]
  ];

  for (const [reference, expected] of cases) {
    const quote = prepareQuoteFromDatasheet(data, {
      productReference: reference,
      customerId: "customer-atlas",
      quantity: 12
    });

    assert.equal(quote.status, "refused", reference);
    assert.ok(quote.issues.includes(expected), reference);
    // A refusal that showed a price could be read as the price of the quote it
    // refused. It shows none, and none of the three provenance blocks either.
    for (const key of ["fromPriceList", "fromDatasheet", "fromRequest"]) {
      assert.equal(key in quote, false, `${reference}: ${key}`);
    }
    assert.equal(/\d{2,}/.test(JSON.stringify(quote)), false, `${reference} carries a number`);
  }
});

// Number(null) and Number("") are both 0, so absence is checked before the
// conversion is trusted. A quantity of zero is not a quantity either.
test("a missing customer or quantity refuses the quote rather than guessing one", () => {
  const data = createDemoCompanyData();
  const base = { productReference: "PRD-ATLAS-PANEL" };

  for (const [input, expected] of [
    [{ ...base, quantity: 12 }, "missing_customer"],
    [{ ...base, customerId: "customer-atlas" }, "missing_quantity"],
    [{ ...base, customerId: "customer-atlas", quantity: 0 }, "missing_quantity"],
    [{ ...base, customerId: "customer-atlas", quantity: null }, "missing_quantity"]
  ]) {
    const quote = prepareQuoteFromDatasheet(data, input);
    assert.equal(quote.status, "refused");
    assert.ok(quote.issues.includes(expected), expected);
  }
});

test("no amount is ever reported that the price list does not carry", async () => {
  const service = createHarness();
  const known = new Set(createDemoCompanyData().prices.map((price) => price.amount));

  for (const reference of ["PRD-ATLAS-PANEL", "PRD-NOVA-FRAME", "MAT-ALU-A", "MAT-PACK-B"]) {
    const summary = await run(service, "get_product_datasheet", { productReference: reference });
    for (const price of summary.prices) {
      assert.ok(known.has(price.amount), `${reference} reports ${price.amount}`);
    }
  }
});

// --- security -------------------------------------------------------------

// CDC section 17 level 3: the agent prepares, the human authorises. Preparing a
// quote is not read_analyze, so ToolExecutionService will not run it without a
// decision, whatever the caller asks.
//
// The code matters. PERMISSION_DENIED would mean the agent may not even prepare,
// and no approval would ever be created: the human decision the tool exists to
// ask for would never be asked. APPROVAL_REQUIRED means the call reached the
// approval mechanism and an approval is waiting for a person.
test("preparing a quote raises a real approval and waits for a person", async () => {
  await assert.rejects(
    () => run(createHarness(), "prepare_quote_from_datasheet", {
      productReference: "PRD-ATLAS-PANEL",
      customerId: "customer-atlas",
      quantity: 12
    }),
    (error) => {
      assert.ok(error instanceof ToolExecutionServiceError);
      assert.equal(error.code, "APPROVAL_REQUIRED");

      const approval = error.details.approval;
      assert.ok(approval, "an approval must exist for a person to decide on");
      assert.equal(approval.status, "pending");
      assert.equal(approval.requestedAction, "prepare_quote_from_datasheet");
      assert.equal(approval.risk, "medium");
      assert.equal(approval.requestingAgent, "commercial");
      assert.equal(approval.approverId, null, "nobody has decided yet");
      assert.equal(approval.decidedAt, null);
      assert.equal(approval.metadata.requiredPermission, "prepare_action");
      assert.equal(approval.metadata.permissionDecision.decision, "prepare_only");
      return true;
    }
  );
});

test("an agent outside commercial reaches neither tool", async () => {
  const service = createHarness();

  for (const toolId of ["get_product_datasheet", "prepare_quote_from_datasheet"]) {
    await assert.rejects(
      () => run(service, toolId, { productReference: "PRD-ATLAS-PANEL" }, { agentId: "finance" }),
      (error) => {
        assert.equal(error.code, "AGENT_NOT_ALLOWED");
        return true;
      },
      toolId
    );
  }
});
