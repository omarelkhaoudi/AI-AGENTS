import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  ToolExecutionService,
  ToolExecutionServiceError,
  createMvpAgentPermissions,
  createMvpToolRegistry,
  isInvoiceOverdue,
  isInvoiceSettled
} from "../src/index.js";

// The four Lot 2B.1 read tools, with the agent each one belongs to and the
// business domain it is scoped to.
const READ_TOOLS = Object.freeze([
  { toolId: "get_customer_overview", agents: ["commercial", "finance"], securityDomains: ["customers"] },
  { toolId: "get_customer_orders", agents: ["commercial", "production"], securityDomains: ["orders"] },
  { toolId: "get_overdue_invoices", agents: ["finance"], securityDomains: ["invoices"] },
  { toolId: "get_supplier_catalog", agents: ["purchasing"], securityDomains: ["suppliers"] }
]);

function createHarness() {
  const repository = new InMemoryRepository();
  return {
    repository,
    service: new ToolExecutionService({ repository, toolRegistry: createMvpToolRegistry({ repository }) })
  };
}

function createInput({ agentId, toolId }) {
  return {
    agentId,
    agentPermissions: createMvpAgentPermissions(agentId),
    toolId,
    input: { requestId: "req-2b1" },
    requestId: "req-2b1",
    planId: "plan-2b1",
    planStepId: "step-2b1"
  };
}

test("the four read tools are registered with a declared security domain", () => {
  const registry = createMvpToolRegistry();

  for (const { toolId, agents, securityDomains } of READ_TOOLS) {
    const tool = registry.get(toolId);

    assert.ok(tool, `${toolId} must be registered`);
    assert.equal(tool.requiredPermission, "read_analyze", toolId);
    assert.deepEqual([...tool.securityDomains], securityDomains, toolId);
    assert.deepEqual([...tool.allowedAgents].sort(), [...agents].sort(), toolId);
  }
});

test("each read tool returns demo marked data for every agent it belongs to", async () => {
  for (const { toolId, agents } of READ_TOOLS) {
    for (const agentId of agents) {
      const { service } = createHarness();
      const result = await service.execute(createInput({ agentId, toolId }));

      assert.equal(result.status, "completed", `${toolId}/${agentId}`);
      assert.equal(result.output.result.demo, true, `${toolId}/${agentId}`);
      assert.equal(result.output.result.dataSource, "demo_mock", `${toolId}/${agentId}`);
      assert.equal(result.output.result.sourceProvider, "demo", `${toolId}/${agentId}`);
      assert.ok(result.output.result.items.length > 0, `${toolId}/${agentId} must return items`);
    }
  }
});

test("a read tool refuses an agent it does not belong to", async () => {
  const cases = [
    { toolId: "get_customer_overview", agentId: "purchasing" },
    { toolId: "get_customer_orders", agentId: "finance" },
    { toolId: "get_overdue_invoices", agentId: "commercial" },
    { toolId: "get_supplier_catalog", agentId: "production" }
  ];

  for (const { toolId, agentId } of cases) {
    const { service } = createHarness();

    await assert.rejects(
      () => service.execute(createInput({ agentId, toolId })),
      (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED",
      `${toolId} must refuse ${agentId}`
    );
  }
});

// Defence in depth: even an allowed agent is refused when its permissions do not
// carry the tool business domain.
test("a read tool refuses an allowed agent that lacks the domain scope", async () => {
  for (const { toolId, agents } of READ_TOOLS) {
    const { service, repository } = createHarness();
    const agentId = agents[0];

    await assert.rejects(
      () => service.execute({
        ...createInput({ agentId, toolId }),
        // Marketing is scoped to its own domain only.
        agentPermissions: createMvpAgentPermissions("marketing")
      }),
      (error) => error instanceof ToolExecutionServiceError && error.code === "DOMAIN_NOT_ALLOWED",
      toolId
    );

    const denied = (await repository.listAuditEvents()).filter((event) => event.type === "permission_denied");
    assert.equal(denied.length, 1, toolId);
    assert.equal(denied[0].metadata.code, "DOMAIN_NOT_ALLOWED", toolId);
  }
});

test("a read tool with no permission at all is denied before the domain check", async () => {
  for (const { toolId, agents } of READ_TOOLS) {
    const { service } = createHarness();

    await assert.rejects(
      () => service.execute({ ...createInput({ agentId: agents[0], toolId }), agentPermissions: [] }),
      (error) => error instanceof ToolExecutionServiceError && error.code === "PERMISSION_DENIED",
      toolId
    );
  }
});

test("read tools never require approval and never create one", async () => {
  for (const { toolId, agents } of READ_TOOLS) {
    const { service, repository } = createHarness();
    await service.execute(createInput({ agentId: agents[0], toolId }));

    assert.deepEqual(await repository.listPendingApprovals({ requestId: "req-2b1" }), [], toolId);
  }
});

test("customer overview exposes the pipeline stage and outstanding balance", async () => {
  const { service } = createHarness();
  const result = await service.execute(createInput({ agentId: "commercial", toolId: "get_customer_overview" }));
  const items = result.output.result.items;

  assert.equal(items.length, 2);
  assert.ok(items.every((item) => typeof item.pipelineStage === "string"));
  assert.ok(items.every((item) => typeof item.outstandingBalance === "number"));
});

test("customer orders expose status and risk for production planning", async () => {
  const { service } = createHarness();
  const result = await service.execute(createInput({ agentId: "production", toolId: "get_customer_orders" }));
  const items = result.output.result.items;

  assert.equal(items.length, 2);
  assert.ok(items.every((item) => typeof item.status === "string"));
  assert.ok(items.every((item) => typeof item.customerId === "string"));
});

test("supplier catalog exposes lead times", async () => {
  const { service } = createHarness();
  const result = await service.execute(createInput({ agentId: "purchasing", toolId: "get_supplier_catalog" }));
  const items = result.output.result.items;

  assert.equal(items.length, 2);
  assert.ok(items.every((item) => Number.isInteger(item.leadTimeDays)));
});

test("overdue invoices are flagged per record and no total is computed", async () => {
  const { service } = createHarness();
  const result = await service.execute(createInput({ agentId: "finance", toolId: "get_overdue_invoices" }));
  const items = result.output.result.items;

  assert.equal(items.length, 2);
  assert.ok(items.every((item) => typeof item.overdue === "boolean"));
  assert.ok(items.every((item) => typeof item.dueAt === "string"));
  // Lot 2B.1 reads and labels. Aggregation belongs to a later lot, so no total
  // must appear here.
  assert.equal("total" in result.output.result, false);
  assert.equal("totalAmount" in result.output.result, false);
});

// The due date comparison is tested against fixed dates so it never depends on
// when the suite runs.
test("invoice overdue detection compares against an explicit reference date", () => {
  const invoice = { status: "issued", dueAt: "2026-08-16" };

  assert.equal(isInvoiceOverdue(invoice, new Date("2026-08-17")), true);
  assert.equal(isInvoiceOverdue(invoice, new Date("2026-08-15")), false);
  // A due date reached but not passed is not yet overdue.
  assert.equal(isInvoiceOverdue(invoice, new Date("2026-08-16")), false);
  assert.equal(isInvoiceOverdue({ status: "paid", dueAt: "2020-01-01" }, new Date("2026-08-19")), false);
  assert.equal(isInvoiceOverdue({ status: "issued" }, new Date("2026-08-19")), false);
  assert.equal(isInvoiceOverdue({ status: "issued", dueAt: "not-a-date" }, new Date("2026-08-19")), false);
  assert.equal(isInvoiceOverdue(null, new Date("2026-08-19")), false);
});

test("settled invoices are recognised by status", () => {
  assert.equal(isInvoiceSettled({ status: "paid" }), true);
  assert.equal(isInvoiceSettled({ status: "settled" }), true);
  assert.equal(isInvoiceSettled({ status: "cancelled" }), true);
  assert.equal(isInvoiceSettled({ status: "issued" }), false);
  assert.equal(isInvoiceSettled(null), false);
});

// The business memory layer keeps its own access ceiling, independent of the
// security domain model.
test("the business memory ceiling still refuses an agent outside the domain", async () => {
  const { service } = createHarness();

  await assert.rejects(
    () => service.execute({
      ...createInput({ agentId: "finance", toolId: "get_supplier_catalog" }),
      agentPermissions: createMvpAgentPermissions("purchasing")
    }),
    (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED"
  );
});
