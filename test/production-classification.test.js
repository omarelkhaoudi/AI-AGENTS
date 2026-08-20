import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  PRODUCTION_CLASSIFICATION_LABELS,
  ToolExecutionService,
  ToolExecutionServiceError,
  classifyProductionRecord,
  createMvpAgentPermissions,
  createMvpToolRegistry,
  createProductionSchedule,
  isProductionCompleted,
  resolveProductionDueDate
} from "../src/index.js";

const REFERENCE = new Date("2026-08-19");

function classify(record, orders = []) {
  return classifyProductionRecord(record, { orders, referenceDate: REFERENCE });
}

function createHarness() {
  const repository = new InMemoryRepository();
  return {
    repository,
    service: new ToolExecutionService({ repository, toolRegistry: createMvpToolRegistry({ repository }) })
  };
}

function execute(service, agentId = "production") {
  return service.execute({
    agentId,
    agentPermissions: createMvpAgentPermissions(agentId),
    toolId: "get_production_schedule",
    input: { requestId: "req-sched" },
    requestId: "req-sched"
  });
}

test("the tool is scoped to production and orders", () => {
  const tool = createMvpToolRegistry().get("get_production_schedule");

  assert.deepEqual([...tool.securityDomains], ["production", "orders"]);
  assert.deepEqual([...tool.allowedAgents], ["production"]);
  assert.equal(tool.requiredPermission, "read_analyze");
});

test("the four CDC states each have a label", () => {
  assert.deepEqual(Object.keys(PRODUCTION_CLASSIFICATION_LABELS).sort(), [
    "AT_RISK",
    "IN_DANGER",
    "LATE",
    "ON_TIME",
    "UNKNOWN"
  ]);
  assert.equal(PRODUCTION_CLASSIFICATION_LABELS.LATE, "en retard");
});

// LATE is derived from a passed deadline and overrides whatever was stored.
test("a passed planned date makes a record late whatever its stored state", () => {
  for (const stored of ["ON_TIME", "AT_RISK", "IN_DANGER"]) {
    assert.equal(
      classify({ orderId: "o1", plannedDate: "2026-08-18", status: "watch", classification: stored }),
      "LATE",
      stored
    );
  }
});

test("the deadline boundary is strict", () => {
  const record = { orderId: "o1", status: "watch", classification: "ON_TIME" };

  assert.equal(classify({ ...record, plannedDate: "2026-08-18" }), "LATE");
  // Reached but not passed is not late.
  assert.equal(classify({ ...record, plannedDate: "2026-08-19" }), "ON_TIME");
  assert.equal(classify({ ...record, plannedDate: "2026-08-20" }), "ON_TIME");
});

test("a stored state is kept when the deadline has not passed", () => {
  assert.equal(classify({ plannedDate: "2026-08-25", classification: "IN_DANGER", status: "blocked" }), "IN_DANGER");
  assert.equal(classify({ plannedDate: "2026-08-25", classification: "AT_RISK", status: "watch" }), "AT_RISK");
  assert.equal(classify({ plannedDate: "2026-08-25", classification: "ON_TIME", status: "on_time" }), "ON_TIME");
});

test("finished work is never late", () => {
  for (const status of ["completed", "done", "delivered", "finished", "closed"]) {
    assert.equal(isProductionCompleted({ status }), true, status);
    assert.equal(
      classify({ plannedDate: "2026-08-01", status, classification: "ON_TIME" }),
      "ON_TIME",
      status
    );
  }
  assert.equal(isProductionCompleted({ status: "blocked" }), false);
  assert.equal(isProductionCompleted(null), false);
});

// Planned date first, order due date only as a fallback.
test("the planned date wins over the order due date", () => {
  const orders = [{ id: "o1", due: "2026-08-01" }];
  const due = resolveProductionDueDate({ orderId: "o1", plannedDate: "2026-08-25" }, orders);

  assert.equal(due.dueDate, "2026-08-25");
  assert.equal(due.dueDateSource, "planned_date");
  assert.equal(due.orderFound, true);
  // The order deadline has passed but the planned date has not: not late.
  assert.equal(classify({ orderId: "o1", plannedDate: "2026-08-25", classification: "ON_TIME" }, orders), "ON_TIME");
});

test("the order due date is used when no planned date is usable", () => {
  const orders = [{ id: "o1", due: "2026-08-10" }];

  for (const plannedDate of [undefined, null, "not-a-date", 20260810]) {
    const due = resolveProductionDueDate({ orderId: "o1", plannedDate }, orders);
    assert.equal(due.dueDate, "2026-08-10", String(plannedDate));
    assert.equal(due.dueDateSource, "order_due", String(plannedDate));
  }

  assert.equal(classify({ orderId: "o1", classification: "ON_TIME" }, orders), "LATE");
});

test("a missing order is reported and never invents a deadline", () => {
  const due = resolveProductionDueDate({ orderId: "ghost" }, [{ id: "o1", due: "2026-08-01" }]);

  assert.equal(due.dueDate, null);
  assert.equal(due.dueDateSource, "none");
  assert.equal(due.orderFound, false);
  // With no deadline at all the stored state is kept untouched.
  assert.equal(classify({ orderId: "ghost", classification: "AT_RISK" }), "AT_RISK");
});

test("an unusable order due date does not produce a deadline", () => {
  const orders = [{ id: "o1", due: "not-a-date" }];
  const due = resolveProductionDueDate({ orderId: "o1" }, orders);

  assert.equal(due.dueDate, null);
  assert.equal(due.dueDateSource, "none");
  assert.equal(due.orderFound, true);
});

test("an unknown or missing stored state becomes UNKNOWN, never invented", () => {
  assert.equal(classify({ plannedDate: "2026-08-25", classification: "SOMETHING_ELSE" }), "UNKNOWN");
  assert.equal(classify({ plannedDate: "2026-08-25" }), "UNKNOWN");
  assert.equal(classify({}), "UNKNOWN");
  assert.equal(classify(null), "UNKNOWN");
});

test("the schedule exposes the deadline it used and whether the order was found", () => {
  const schedule = createProductionSchedule({
    production: [
      { orderId: "o1", plannedDate: "2026-08-18", status: "watch", classification: "AT_RISK" },
      { orderId: "ghost", classification: "ON_TIME" }
    ],
    orders: [{ id: "o1", due: "2026-08-30" }]
  }, { referenceDate: REFERENCE });

  assert.deepEqual(schedule.map((item) => item.classification), ["LATE", "ON_TIME"]);
  assert.deepEqual(schedule.map((item) => item.timing), ["en retard", "a l'heure"]);
  assert.deepEqual(schedule.map((item) => item.dueDateSource), ["planned_date", "none"]);
  assert.deepEqual(schedule.map((item) => item.orderFound), [true, false]);
  assert.deepEqual(schedule.map((item) => item.late), [true, false]);
});

test("an empty schedule is not an error", () => {
  assert.deepEqual(createProductionSchedule({}, { referenceDate: REFERENCE }), []);
  assert.deepEqual(createProductionSchedule({ production: [], orders: [] }, { referenceDate: REFERENCE }), []);
});

test("production reads its schedule through the tool", async () => {
  const { service } = createHarness();
  const result = await execute(service);
  const items = result.output.result.items;

  assert.equal(result.status, "completed");
  assert.equal(result.output.result.dataSource, "demo_mock");
  assert.equal(items.length, 3);
  assert.ok(items.every((item) => ["LATE", "IN_DANGER", "AT_RISK", "ON_TIME", "UNKNOWN"].includes(item.classification)));
  // The demo production record whose order does not exist is reported as such.
  assert.equal(items.filter((item) => item.orderFound === false).length, 1);
});

test("no aggregate is produced by the schedule", async () => {
  const { service } = createHarness();
  const result = await execute(service);

  assert.equal("summary" in result.output.result, false);
});

// The existing tool keeps its stored classifications: this commit must not
// change what the Director already reports.
test("get_delayed_production_orders is untouched by the derivation", async () => {
  const { service } = createHarness();
  const result = await service.execute({
    agentId: "production",
    agentPermissions: createMvpAgentPermissions("production"),
    toolId: "get_delayed_production_orders",
    input: { requestId: "req-old" },
    requestId: "req-old"
  });
  const items = result.output.result.items;

  assert.deepEqual(
    [...new Set(items.map((item) => item.classification))].sort(),
    ["AT_RISK", "IN_DANGER", "ON_TIME"]
  );
  assert.equal(items.some((item) => item.classification === "LATE"), false);
  assert.equal(items.some((item) => "dueDateSource" in item), false);
});

test("an agent without both domains is denied", async () => {
  const { service } = createHarness();

  await assert.rejects(
    () => service.execute({
      agentId: "production",
      // HR is scoped to its own domain only: neither production nor orders.
      agentPermissions: createMvpAgentPermissions("hr"),
      toolId: "get_production_schedule",
      input: { requestId: "req-sched" },
      requestId: "req-sched"
    }),
    (error) => {
      assert.equal(error.code, "DOMAIN_NOT_ALLOWED");
      assert.deepEqual(error.details.missingDomains, ["production", "orders"]);
      return true;
    }
  );
});

test("an agent other than production cannot use the tool", async () => {
  const { service } = createHarness();

  await assert.rejects(
    () => execute(service, "commercial"),
    (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED"
  );
});
