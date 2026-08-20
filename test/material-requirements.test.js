import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  ToolExecutionService,
  ToolExecutionServiceError,
  createDemoCompanyData,
  createMaterialRequirements,
  createMvpAgentPermissions,
  createMvpToolRegistry,
  isOrderClosed,
  isStockAvailable,
  summarizeProductStock
} from "../src/index.js";

function chain(input) {
  return createMaterialRequirements(input);
}

function createHarness() {
  const repository = new InMemoryRepository();
  return {
    repository,
    service: new ToolExecutionService({ repository, toolRegistry: createMvpToolRegistry({ repository }) })
  };
}

function execute(service, agentId = "purchasing") {
  return service.execute({
    agentId,
    agentPermissions: createMvpAgentPermissions(agentId),
    toolId: "get_material_requirements",
    input: { requestId: "req-mat" },
    requestId: "req-mat"
  });
}

const ORDER = { id: "o1", status: "in_production" };
const BOM = { id: "b1", orderId: "o1", lines: [{ lineId: "l1", productId: "m1", quantity: 10, unit: "units" }] };

test("the tool is scoped to the four domains of the chain", () => {
  const tool = createMvpToolRegistry().get("get_material_requirements");

  assert.deepEqual([...tool.securityDomains], ["orders", "bills_of_material", "stock", "products"]);
  assert.deepEqual([...tool.allowedAgents], ["purchasing"]);
  assert.equal(tool.requiredPermission, "read_analyze");
});

// The derived shortage must reproduce the figures the demo data already states,
// otherwise the two sources of truth have drifted.
test("the derived shortage matches the pre-existing purchase needs", () => {
  const data = createDemoCompanyData();
  const result = chain({
    orders: data.orders,
    billsOfMaterial: data.billsOfMaterial,
    stock: data.stock,
    products: data.products
  });

  assert.equal(result.items.length, 2);
  for (const item of result.items) {
    const need = data.purchaseNeeds.find((candidate) => candidate.item === item.productName);
    assert.ok(need, item.productName);
    assert.equal(item.shortage, need.missingQuantity, item.productName);
    assert.equal(item.required, need.quantity, item.productName);
    assert.equal(item.available, need.stockOnHand, item.productName);
  }
});

test("stock is subtracted from the requirement", () => {
  const result = chain({
    orders: [ORDER],
    billsOfMaterial: [BOM],
    stock: [{ id: "s1", productId: "m1", quantity: 4, status: "available" }]
  });

  assert.equal(result.items[0].required, 10);
  assert.equal(result.items[0].available, 4);
  assert.equal(result.items[0].shortage, 6);
  assert.equal(result.items[0].covered, false);
});

test("sufficient stock leaves no shortage and is not a purchase need", () => {
  const result = chain({
    orders: [ORDER],
    billsOfMaterial: [BOM],
    stock: [{ id: "s1", productId: "m1", quantity: 25, status: "available" }]
  });

  assert.equal(result.items[0].shortage, 0);
  assert.equal(result.items[0].covered, true);
  assert.equal(result.summary.counts.shortages, 0);
  assert.equal(result.summary.counts.covered, 1);
});

test("no stock record at all means the whole requirement is missing", () => {
  const result = chain({ orders: [ORDER], billsOfMaterial: [BOM], stock: [] });

  assert.equal(result.items[0].available, 0);
  assert.equal(result.items[0].shortage, 10);
  assert.equal(result.items[0].stockKnown, false);
});

test("a negative stock quantity is clamped to zero", () => {
  const result = chain({
    orders: [ORDER],
    billsOfMaterial: [BOM],
    stock: [{ id: "s1", productId: "m1", quantity: -5, status: "available" }]
  });

  assert.equal(result.items[0].available, 0);
  assert.equal(result.items[0].shortage, 10);
  assert.equal(result.items[0].stockKnown, true);
});

test("several stock records for one product are summed", () => {
  const result = chain({
    orders: [ORDER],
    billsOfMaterial: [BOM],
    stock: [
      { id: "s1", productId: "m1", quantity: 3, status: "available" },
      { id: "s2", productId: "m1", quantity: 4, status: "available" },
      { id: "s3", productId: "other", quantity: 100, status: "available" }
    ]
  });

  assert.equal(result.items[0].available, 7);
  assert.equal(result.items[0].shortage, 3);
});

// Fail closed: only stock we are sure is available counts, and what was left
// out stays visible in the counters.
test("stock that is not explicitly available is excluded but counted", () => {
  const result = chain({
    orders: [ORDER],
    billsOfMaterial: [BOM],
    stock: [
      { id: "s1", productId: "m1", quantity: 2, status: "available" },
      { id: "s2", productId: "m1", quantity: 6, status: "reserved" },
      { id: "s3", productId: "m1", quantity: 1, status: undefined }
    ]
  });

  assert.equal(result.items[0].available, 2);
  assert.equal(result.items[0].shortage, 8);
  assert.equal(result.summary.counts.unavailableQuantity, 7);
  assert.equal(result.summary.counts.stockRecordsIgnored, 2);
});

test("stock availability is recognised by status", () => {
  assert.equal(isStockAvailable({ status: "available" }), true);
  assert.equal(isStockAvailable({ status: "in_stock" }), true);
  assert.equal(isStockAvailable({ status: "free" }), true);
  assert.equal(isStockAvailable({ status: "reserved" }), false);
  assert.equal(isStockAvailable({}), false);
  assert.equal(isStockAvailable(null), false);
});

test("stock summary reports the supplier of the product", () => {
  const summary = summarizeProductStock("m1", [
    { productId: "m1", quantity: 5, status: "available", supplierId: "sup-1" }
  ]);

  assert.equal(summary.available, 5);
  assert.equal(summary.supplierId, "sup-1");
  assert.equal(summary.stockKnown, true);
});

// A missing bill of material is a reported gap, never a silent skip.
test("an order without a bill of material is reported as an anomaly", () => {
  const result = chain({ orders: [ORDER], billsOfMaterial: [], stock: [] });

  assert.deepEqual(result.items, []);
  assert.equal(result.summary.counts.anomalies, 1);
  assert.equal(result.summary.anomalies[0].reason, "bill_of_material_missing");
  assert.equal(result.summary.anomalies[0].orderId, "o1");
});

test("a bill of material with no line is reported as an anomaly", () => {
  const result = chain({
    orders: [ORDER],
    billsOfMaterial: [{ id: "b1", orderId: "o1", lines: [] }],
    stock: []
  });

  assert.equal(result.summary.anomalies[0].reason, "bill_of_material_empty");
  assert.equal(result.summary.anomalies[0].billOfMaterialId, "b1");
});

test("a line with an unusable quantity is reported, never computed as NaN", () => {
  const result = chain({
    orders: [ORDER],
    billsOfMaterial: [{
      id: "b1",
      orderId: "o1",
      lines: [
        { lineId: "bad-1", productId: "m1" },
        { lineId: "bad-2", productId: "m1", quantity: 0 },
        { lineId: "bad-3", productId: "m1", quantity: -4 },
        { lineId: "bad-4", productId: "m1", quantity: "10" },
        { lineId: "ok", productId: "m1", quantity: 5 }
      ]
    }],
    stock: []
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].lineId, "ok");
  assert.equal(result.summary.counts.anomalies, 4);
  assert.ok(result.summary.anomalies.every((anomaly) => anomaly.reason === "invalid_line"));
  assert.ok(result.items.every((item) => Number.isFinite(item.shortage)));
});

test("a bill of material can be matched through the order product", () => {
  const result = chain({
    orders: [{ id: "o9", status: "scheduled", productId: "p9" }],
    billsOfMaterial: [{ id: "b9", productId: "p9", lines: [{ lineId: "l1", productId: "m1", quantity: 2 }] }],
    stock: []
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].billOfMaterialId, "b9");
});

test("a closed order is not considered at all", () => {
  for (const status of ["cancelled", "completed", "delivered", "closed"]) {
    const result = chain({ orders: [{ id: "o1", status }], billsOfMaterial: [], stock: [] });

    assert.equal(isOrderClosed({ status }), true, status);
    assert.equal(result.summary.counts.orders, 0, status);
    assert.equal(result.summary.counts.anomalies, 0, status);
  }
});

// The order quantity is not part of the persisted model: honoured through
// fixtures only, defaulting to one.
test("an order quantity multiplies every line, defaulting to one", () => {
  const withoutQuantity = chain({ orders: [ORDER], billsOfMaterial: [BOM], stock: [] });
  assert.equal(withoutQuantity.items[0].required, 10);

  const withQuantity = chain({
    orders: [{ ...ORDER, quantity: 3 }],
    billsOfMaterial: [BOM],
    stock: [{ id: "s1", productId: "m1", quantity: 5, status: "available" }]
  });
  assert.equal(withQuantity.items[0].required, 30);
  assert.equal(withQuantity.items[0].shortage, 25);

  for (const quantity of [0, -2, "3", null, Number.NaN]) {
    const result = chain({ orders: [{ ...ORDER, quantity }], billsOfMaterial: [BOM], stock: [] });
    assert.equal(result.items[0].required, 10, String(quantity));
  }
});

test("an unknown product is flagged but the computation continues", () => {
  const result = chain({
    orders: [ORDER],
    billsOfMaterial: [BOM],
    stock: [{ id: "s1", productId: "m1", quantity: 1, status: "available" }],
    products: [{ id: "other", name: "Other" }]
  });

  assert.equal(result.items[0].productKnown, false);
  assert.equal(result.items[0].productName, null);
  assert.equal(result.items[0].shortage, 9);
});

test("empty inputs produce no item, no anomaly and no failure", () => {
  const result = chain({});

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.summary.anomalies, []);
  assert.equal(result.summary.counts.orders, 0);
  assert.equal(result.summary.counts.lines, 0);
});

test("anomalies are kept out of the items list", () => {
  const result = chain({
    orders: [ORDER, { id: "o2", status: "scheduled" }],
    billsOfMaterial: [BOM],
    stock: []
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.summary.anomalies.length, 1);
  assert.equal(result.items.some((item) => "reason" in item), false);
});

test("purchasing reads the chain through the tool", async () => {
  const { service } = createHarness();
  const result = await execute(service);

  assert.equal(result.status, "completed");
  assert.equal(result.output.result.dataSource, "demo_mock");
  assert.equal(result.output.result.items.length, 2);
  assert.deepEqual(
    result.output.result.items.map((item) => item.shortage).sort((a, b) => a - b),
    [20, 90]
  );
  assert.equal(result.output.result.summary.counts.anomalies, 0);
});

test("no monetary amount or currency is produced", async () => {
  const { service } = createHarness();
  const result = await execute(service);

  for (const item of result.output.result.items) {
    assert.equal("amount" in item, false);
    assert.equal("currency" in item, false);
    assert.equal("unitPrice" in item, false);
  }
  assert.equal("totalsByCurrency" in result.output.result.summary, false);
});

// The existing tool keeps its pre-computed needs untouched.
test("get_purchase_needs is untouched by the derivation", async () => {
  const { service } = createHarness();
  const result = await service.execute({
    agentId: "purchasing",
    agentPermissions: createMvpAgentPermissions("purchasing"),
    toolId: "get_purchase_needs",
    input: { requestId: "req-old" },
    requestId: "req-old"
  });

  assert.equal(createMvpToolRegistry().get("get_purchase_needs").securityDomains.length, 1);
  assert.ok(result.output.result.items.every((item) => "missingQuantity" in item));
  assert.equal(result.output.result.items.some((item) => "covered" in item), false);
  assert.equal("summary" in result.output.result, false);
});

test("an agent missing any of the four domains is denied", async () => {
  const { service } = createHarness();

  await assert.rejects(
    () => service.execute({
      agentId: "purchasing",
      // HR is scoped to its own domain only.
      agentPermissions: createMvpAgentPermissions("hr"),
      toolId: "get_material_requirements",
      input: { requestId: "req-mat" },
      requestId: "req-mat"
    }),
    (error) => {
      assert.equal(error.code, "DOMAIN_NOT_ALLOWED");
      assert.deepEqual(error.details.missingDomains, ["orders", "bills_of_material", "stock", "products"]);
      return true;
    }
  );
});

test("holding only some of the four domains is still a denial", async () => {
  const { service } = createHarness();

  await assert.rejects(
    () => service.execute({
      agentId: "purchasing",
      // Production holds production and orders: orders is enough for one domain.
      agentPermissions: createMvpAgentPermissions("production"),
      toolId: "get_material_requirements",
      input: { requestId: "req-mat" },
      requestId: "req-mat"
    }),
    (error) => {
      assert.equal(error.code, "DOMAIN_NOT_ALLOWED");
      assert.deepEqual(error.details.missingDomains, ["bills_of_material", "stock", "products"]);
      return true;
    }
  );
});

test("an agent other than purchasing cannot use the tool", async () => {
  const { service } = createHarness();

  await assert.rejects(
    () => execute(service, "production"),
    (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED"
  );
});
