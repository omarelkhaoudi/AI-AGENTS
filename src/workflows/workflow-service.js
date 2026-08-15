import { createMockWorkflowAdapter } from "./mock-adapter.js";
import { WORKFLOW_DEFINITIONS, WorkflowExecutionError, validateWorkflowEvent } from "./contract.js";

export class WorkflowPreparationService {
  constructor({ adapter = createMockWorkflowAdapter() } = {}) {
    this.adapter = adapter;
  }

  listDefinitions() {
    return this.adapter.listDefinitions();
  }

  async prepare(event, {
    executedThroughToolExecutionService = false,
    approvalGranted = false
  } = {}) {
    validateWorkflowEvent(event);

    if (executedThroughToolExecutionService !== true) {
      throw new WorkflowExecutionError(
        "Workflow preparation must be invoked behind ToolExecutionService.",
        "TOOL_EXECUTION_SERVICE_REQUIRED",
        {
          eventType: event.type,
          correlationId: event.correlationId
        }
      );
    }

    const definition = WORKFLOW_DEFINITIONS[event.type];
    if (definition.sensitive && approvalGranted !== true) {
      return this.adapter.prepare(event, { approvalGranted: false });
    }

    return this.adapter.prepare(event, { approvalGranted });
  }
}

export function createWorkflowPreparationService(options = {}) {
  return new WorkflowPreparationService(options);
}
