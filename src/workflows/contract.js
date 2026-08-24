export const WORKFLOW_EVENT_TYPES = Object.freeze([
  "new_order",
  "quote_accepted",
  "deposit_check",
  "production_file_creation",
  "material_needs_analysis",
  "stock_check",
  "purchase_need",
  "delay_alert",
  "after_sales_claim"
]);

// duplicate_skipped now means two different things, and the difference matters.
//
// Inside this file it is what MockWorkflowAdapter reports from an in-process Map
// keyed by correlationId and event type. That map is per instance and dies with
// the process: it demonstrates the contract, it guarantees nothing.
//
// The real guarantee lives one layer up and is held by the database.
// Request.idempotencyKey carries a unique index, the insert of the request is the
// reservation, and a duplicate business event is refused before a plan, a step, an
// approval or an execution exists. The delay alert endpoint reports that refusal
// with this same status, which is why no second status was introduced.
export const WORKFLOW_STATUSES = Object.freeze([
  "prepared",
  "completed",
  "failed",
  "duplicate_skipped",
  "approval_required"
]);

export class WorkflowContractError extends Error {
  constructor(message, code = "WORKFLOW_INVALID", details = {}) {
    super(message);
    this.name = "WorkflowContractError";
    this.code = code;
    this.details = details;
  }
}

export class WorkflowExecutionError extends Error {
  constructor(message, code = "WORKFLOW_EXECUTION_FAILED", details = {}) {
    super(message);
    this.name = "WorkflowExecutionError";
    this.code = code;
    this.details = details;
  }
}

export const WORKFLOW_DEFINITIONS = Object.freeze({
  new_order: createWorkflowDefinition({
    id: "new_order",
    name: "New order",
    description: "Draft workflow event for preparing downstream order handling after a new order signal.",
    inputs: ["orderId", "customerId"],
    outputs: ["preparedOrderContext"],
    allowedAgents: ["director", "commercial", "production"],
    sensitive: false
  }),
  quote_accepted: createWorkflowDefinition({
    id: "quote_accepted",
    name: "Quote accepted",
    description: "Draft workflow event for preparing follow-up after a quote acceptance signal.",
    inputs: ["quoteId", "customerId"],
    outputs: ["acceptedQuoteContext"],
    allowedAgents: ["director", "commercial", "finance", "production"],
    sensitive: false
  }),
  deposit_check: createWorkflowDefinition({
    id: "deposit_check",
    name: "Deposit check",
    description: "Draft workflow event for preparing a deposit verification request.",
    inputs: ["invoiceId", "paymentId", "customerId"],
    outputs: ["depositCheckPreparation"],
    allowedAgents: ["director", "finance"],
    sensitive: true,
    requiredApprovals: ["confirm_deposit_status", "continue_without_deposit"]
  }),
  production_file_creation: createWorkflowDefinition({
    id: "production_file_creation",
    name: "Production file creation",
    description: "Draft workflow event for preparing a production file creation request.",
    inputs: ["orderId", "quoteId", "customerId"],
    outputs: ["productionFilePreparation"],
    allowedAgents: ["director", "production"],
    sensitive: true,
    requiredApprovals: ["create_or_modify_production_file"]
  }),
  material_needs_analysis: createWorkflowDefinition({
    id: "material_needs_analysis",
    name: "Material needs analysis",
    description: "Draft workflow event for analyzing required materials from production/order signals.",
    inputs: ["orderId"],
    outputs: ["materialNeedsSummary"],
    allowedAgents: ["director", "production", "purchasing"],
    sensitive: false
  }),
  stock_check: createWorkflowDefinition({
    id: "stock_check",
    name: "Stock check",
    description: "Draft workflow event for preparing stock availability checks.",
    inputs: ["materialId"],
    outputs: ["stockCheckSummary"],
    allowedAgents: ["director", "purchasing", "production"],
    sensitive: false
  }),
  purchase_need: createWorkflowDefinition({
    id: "purchase_need",
    name: "Purchase need",
    description: "Draft workflow event for preparing purchase need handling.",
    inputs: ["purchaseNeedId", "supplierId"],
    outputs: ["purchaseNeedPreparation"],
    allowedAgents: ["director", "purchasing"],
    sensitive: true,
    requiredApprovals: ["place_purchase_order", "commit_supplier_order"]
  }),
  delay_alert: createWorkflowDefinition({
    id: "delay_alert",
    name: "Delay alert",
    description: "Draft workflow event for preparing delay alert handling.",
    inputs: ["orderId", "delayRisk"],
    outputs: ["delayAlertSummary"],
    allowedAgents: ["director", "production", "after_sales"],
    sensitive: false
  }),
  after_sales_claim: createWorkflowDefinition({
    id: "after_sales_claim",
    name: "After-sales claim",
    description: "Draft workflow event for preparing after-sales claim follow-up.",
    inputs: ["ticketId", "customerId"],
    outputs: ["claimFollowUpPreparation"],
    allowedAgents: ["director", "after_sales"],
    sensitive: true,
    requiredApprovals: ["commit_customer_resolution", "send_customer_compensation"]
  })
});

export function createWorkflowEvent({
  id,
  type,
  correlationId,
  agentId,
  requestId = null,
  payload = {},
  metadata = {}
} = {}) {
  validateWorkflowEventType(type);
  requireText(id, "id");
  requireText(correlationId, "correlationId");
  requireText(agentId, "agentId");

  return Object.freeze({
    id,
    type,
    correlationId,
    agentId,
    requestId,
    payload: Object.freeze({ ...payload }),
    metadata: Object.freeze({ ...metadata })
  });
}

export function validateWorkflowDefinition(definition) {
  validateKnownWorkflowEventType(definition?.id);
  requireText(definition?.name, "name");
  requireText(definition?.description, "description");
  requireArray(definition?.inputs, "inputs");
  requireArray(definition?.outputs, "outputs");
  requireArray(definition?.allowedAgents, "allowedAgents");
  if (typeof definition?.sensitive !== "boolean") {
    throw new WorkflowContractError("Workflow definition sensitive must be a boolean.", "WORKFLOW_DEFINITION_INVALID");
  }
  if (!Array.isArray(definition?.requiredApprovals)) {
    throw new WorkflowContractError("Workflow definition requiredApprovals must be an array.", "WORKFLOW_DEFINITION_INVALID");
  }
  return true;
}

export function validateWorkflowEvent(event) {
  const definition = validateWorkflowEventType(event?.type);
  requireText(event?.id, "id");
  requireText(event?.correlationId, "correlationId");
  requireText(event?.agentId, "agentId");
  if (!definition.allowedAgents.includes(event.agentId)) {
    throw new WorkflowExecutionError("Agent is not allowed to prepare workflow event.", "WORKFLOW_AGENT_NOT_ALLOWED", {
      eventType: event.type,
      agentId: event.agentId
    });
  }
  for (const field of definition.inputs) {
    if (event.payload?.[field] === undefined || event.payload?.[field] === null || event.payload?.[field] === "") {
      throw new WorkflowContractError(`Workflow event is missing input: ${field}`, "WORKFLOW_INPUT_INVALID", {
        eventType: event.type,
        field
      });
    }
  }
  return true;
}

export function validateWorkflowEventType(type) {
  const definition = WORKFLOW_DEFINITIONS[type];
  if (!definition) {
    throw new WorkflowContractError(`Unknown workflow event type: ${type}`, "WORKFLOW_TYPE_UNKNOWN", {
      type
    });
  }
  return definition;
}

function validateKnownWorkflowEventType(type) {
  if (!WORKFLOW_EVENT_TYPES.includes(type)) {
    throw new WorkflowContractError(`Unknown workflow event type: ${type}`, "WORKFLOW_TYPE_UNKNOWN", {
      type
    });
  }
  return true;
}

function createWorkflowDefinition({
  id,
  name,
  description,
  inputs,
  outputs,
  allowedAgents,
  sensitive,
  requiredApprovals = []
}) {
  const definition = Object.freeze({
    id,
    name,
    description,
    inputs: Object.freeze([...inputs]),
    outputs: Object.freeze([...outputs]),
    allowedAgents: Object.freeze([...allowedAgents]),
    sensitive,
    requiredApprovals: Object.freeze([...requiredApprovals]),
    status: "draft",
    externalConnection: "not_connected",
    adapter: "mock"
  });
  validateWorkflowDefinition(definition);
  return definition;
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkflowContractError(`${field} must be a non-empty string.`, "WORKFLOW_INPUT_INVALID", { field });
  }
}

function requireArray(value, field) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new WorkflowContractError(`${field} must be a non-empty string array.`, "WORKFLOW_DEFINITION_INVALID", { field });
  }
}
