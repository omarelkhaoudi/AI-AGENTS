import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKFLOW_DEFINITIONS,
  WORKFLOW_EVENT_TYPES,
  WorkflowContractError,
  WorkflowExecutionError,
  createMockWorkflowAdapter,
  createWorkflowEvent,
  createWorkflowPreparationService,
  validateWorkflowDefinition,
  validateWorkflowEvent
} from "../src/index.js";

const VALID_PAYLOAD_BY_TYPE = Object.freeze({
  new_order: { orderId: "order-demo-001", customerId: "customer-demo-001" },
  quote_accepted: { quoteId: "quote-demo-001", customerId: "customer-demo-001" },
  deposit_check: { invoiceId: "invoice-demo-001", paymentId: "payment-demo-001", customerId: "customer-demo-001" },
  production_file_creation: { orderId: "order-demo-001", quoteId: "quote-demo-001", customerId: "customer-demo-001" },
  material_needs_analysis: { orderId: "order-demo-001" },
  stock_check: { materialId: "material-demo-001" },
  purchase_need: { purchaseNeedId: "purchase-demo-001", supplierId: "supplier-demo-001" },
  delay_alert: { orderId: "order-demo-001", delayRisk: "high" },
  after_sales_claim: { ticketId: "ticket-demo-001", customerId: "customer-demo-001" }
});

const AGENT_BY_TYPE = Object.freeze({
  new_order: "commercial",
  quote_accepted: "commercial",
  deposit_check: "finance",
  production_file_creation: "production",
  material_needs_analysis: "production",
  stock_check: "purchasing",
  purchase_need: "purchasing",
  delay_alert: "production",
  after_sales_claim: "after_sales"
});

test("workflow definitions cover the CDC MVP process events", () => {
  assert.deepEqual(Object.keys(WORKFLOW_DEFINITIONS), WORKFLOW_EVENT_TYPES);

  for (const type of WORKFLOW_EVENT_TYPES) {
    const definition = WORKFLOW_DEFINITIONS[type];
    assert.equal(validateWorkflowDefinition(definition), true, type);
    assert.equal(definition.status, "draft", type);
    assert.equal(definition.externalConnection, "not_connected", type);
    assert.equal(definition.adapter, "mock", type);
    assert.equal(definition.inputs.length > 0, true, type);
    assert.equal(definition.outputs.length > 0, true, type);
  }
});

test("workflow events require correlation id, authorized agent, and declared inputs", () => {
  for (const type of WORKFLOW_EVENT_TYPES) {
    const event = createWorkflowEvent({
      id: `event-${type}`,
      type,
      correlationId: `corr-${type}`,
      agentId: AGENT_BY_TYPE[type],
      payload: VALID_PAYLOAD_BY_TYPE[type]
    });
    assert.equal(validateWorkflowEvent(event), true, type);
  }

  assert.throws(
    () => createWorkflowEvent({
      id: "event-missing-correlation",
      type: "new_order",
      agentId: "commercial",
      payload: VALID_PAYLOAD_BY_TYPE.new_order
    }),
    (error) => error instanceof WorkflowContractError && error.code === "WORKFLOW_INPUT_INVALID"
  );

  assert.throws(
    () => validateWorkflowEvent(createWorkflowEvent({
      id: "event-missing-input",
      type: "deposit_check",
      correlationId: "corr-missing-input",
      agentId: "finance",
      payload: { invoiceId: "invoice-demo-001" }
    })),
    (error) => error instanceof WorkflowContractError && error.code === "WORKFLOW_INPUT_INVALID"
  );

  assert.throws(
    () => validateWorkflowEvent(createWorkflowEvent({
      id: "event-agent-denied",
      type: "purchase_need",
      correlationId: "corr-agent-denied",
      agentId: "commercial",
      payload: VALID_PAYLOAD_BY_TYPE.purchase_need
    })),
    (error) => error instanceof WorkflowExecutionError && error.code === "WORKFLOW_AGENT_NOT_ALLOWED"
  );
});

test("workflow preparation service cannot be used outside ToolExecutionService boundary", async () => {
  const service = createWorkflowPreparationService();
  const event = createEvent("new_order");

  await assert.rejects(
    () => service.prepare(event),
    (error) => error instanceof WorkflowExecutionError && error.code === "TOOL_EXECUTION_SERVICE_REQUIRED"
  );
});

test("mock workflow adapter prepares non-sensitive workflows without external connection", async () => {
  const service = createWorkflowPreparationService();
  const result = await service.prepare(createEvent("material_needs_analysis"), {
    executedThroughToolExecutionService: true
  });

  assert.equal(result.status, "completed");
  assert.equal(result.provider, "n8n");
  assert.equal(result.adapter, "mock");
  assert.equal(result.externalConnection, "not_connected");
  assert.equal(result.output.demo, true);
  assert.equal(result.output.workflowConnected, false);
  assert.deepEqual(result.output.outputNames, WORKFLOW_DEFINITIONS.material_needs_analysis.outputs);
});

test("sensitive workflow preparation requires approval and is idempotent", async () => {
  const service = createWorkflowPreparationService();
  const event = createEvent("purchase_need", { correlationId: "corr-sensitive-once" });

  const first = await service.prepare(event, {
    executedThroughToolExecutionService: true
  });
  const second = await service.prepare(event, {
    executedThroughToolExecutionService: true
  });

  assert.equal(first.status, "approval_required");
  assert.equal(first.sensitive, true);
  assert.deepEqual(first.requiredApprovals, WORKFLOW_DEFINITIONS.purchase_need.requiredApprovals);
  assert.equal(second.status, "duplicate_skipped");
  assert.equal(second.duplicateOf, first.id);
});

test("approved sensitive workflow preparation still stays mock and idempotent", async () => {
  const service = createWorkflowPreparationService({
    adapter: createMockWorkflowAdapter()
  });
  const event = createEvent("after_sales_claim", { correlationId: "corr-approved-once" });

  const first = await service.prepare(event, {
    executedThroughToolExecutionService: true,
    approvalGranted: true
  });
  const second = await service.prepare(event, {
    executedThroughToolExecutionService: true,
    approvalGranted: true
  });

  assert.equal(first.status, "completed");
  assert.equal(first.output.workflowConnected, false);
  assert.equal(second.status, "duplicate_skipped");
  assert.equal(second.duplicateOf, first.id);
});

function createEvent(type, overrides = {}) {
  return createWorkflowEvent({
    id: overrides.id ?? `event-${type}`,
    type,
    correlationId: overrides.correlationId ?? `corr-${type}`,
    agentId: overrides.agentId ?? AGENT_BY_TYPE[type],
    requestId: overrides.requestId ?? "req-workflow",
    payload: overrides.payload ?? VALID_PAYLOAD_BY_TYPE[type],
    metadata: {
      demo: true,
      ...(overrides.metadata ?? {})
    }
  });
}
