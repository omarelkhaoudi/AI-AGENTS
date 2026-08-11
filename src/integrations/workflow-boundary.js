export class WorkflowBoundaryError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowBoundaryError";
  }
}

export function createWorkflowConfig({ provider = "n8n", baseUrl, enabled = false, metadata = {} } = {}) {
  if (enabled && (!baseUrl || typeof baseUrl !== "string")) {
    throw new WorkflowBoundaryError("Workflow baseUrl is required when workflows are enabled.");
  }

  return Object.freeze({
    provider,
    baseUrl: baseUrl ?? null,
    enabled,
    metadata: { ...metadata }
  });
}

export class WorkflowClient {
  constructor(config = createWorkflowConfig()) {
    this.config = config;
  }

  async invoke() {
    throw new WorkflowBoundaryError("Workflow invocation is not implemented in Phase 0.");
  }
}
