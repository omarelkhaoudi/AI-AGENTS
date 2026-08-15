import {
  WORKFLOW_DEFINITIONS,
  WORKFLOW_STATUSES,
  WorkflowExecutionError,
  createWorkflowEvent,
  validateWorkflowEvent
} from "./contract.js";

export class MockWorkflowAdapter {
  #executions = new Map();

  constructor({ provider = "n8n", externalConnection = "not_connected" } = {}) {
    this.provider = provider;
    this.externalConnection = externalConnection;
  }

  listDefinitions() {
    return Object.values(WORKFLOW_DEFINITIONS);
  }

  getDefinition(type) {
    return WORKFLOW_DEFINITIONS[type] ?? null;
  }

  async prepare(eventInput, { approvalGranted = false } = {}) {
    const event = createWorkflowEvent(eventInput);
    validateWorkflowEvent(event);

    const definition = WORKFLOW_DEFINITIONS[event.type];
    const key = createExecutionKey(event);
    const existing = this.#executions.get(key);
    if (existing) {
      return createWorkflowResult({
        adapter: this,
        event,
        definition,
        status: "duplicate_skipped",
        output: existing.output,
        duplicateOf: existing.id
      });
    }

    if (definition.sensitive && approvalGranted !== true) {
      const result = createWorkflowResult({
        adapter: this,
        event,
        definition,
        status: "approval_required",
        output: {
          preparedOnly: true,
          requiredApprovals: definition.requiredApprovals
        }
      });
      this.#executions.set(key, result);
      return result;
    }

    const result = createWorkflowResult({
      adapter: this,
      event,
      definition,
      status: "completed",
      output: createMockOutput(definition, event)
    });
    this.#executions.set(key, result);
    return result;
  }
}

export function createMockWorkflowAdapter(options = {}) {
  return new MockWorkflowAdapter(options);
}

function createWorkflowResult({ adapter, event, definition, status, output, duplicateOf = null }) {
  if (!WORKFLOW_STATUSES.includes(status)) {
    throw new WorkflowExecutionError(`Unsupported workflow status: ${status}`, "WORKFLOW_STATUS_INVALID", {
      status
    });
  }

  return Object.freeze({
    id: `${event.correlationId}:${event.type}`,
    provider: adapter.provider,
    adapter: "mock",
    externalConnection: adapter.externalConnection,
    status,
    eventType: event.type,
    correlationId: event.correlationId,
    eventId: event.id,
    requestId: event.requestId,
    agentId: event.agentId,
    sensitive: definition.sensitive,
    requiredApprovals: definition.requiredApprovals,
    output: Object.freeze({
      demo: true,
      dataSource: "demo_mock",
      workflowConnected: false,
      ...output
    }),
    duplicateOf
  });
}

function createMockOutput(definition, event) {
  return Object.freeze({
    preparedOnly: true,
    outputNames: definition.outputs,
    payloadSummary: Object.freeze({
      fields: Object.keys(event.payload).sort(),
      fieldCount: Object.keys(event.payload).length
    })
  });
}

function createExecutionKey(event) {
  return `${event.correlationId}:${event.type}`;
}
