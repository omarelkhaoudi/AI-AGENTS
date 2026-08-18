export class WorkflowBoundaryError extends Error {
  constructor(message, code = "WORKFLOW_BOUNDARY_ERROR", details = {}) {
    super(message);
    this.name = "WorkflowBoundaryError";
    this.code = code;
    this.details = details;
  }
}

export const WORKFLOW_PROVIDERS = Object.freeze(["mock", "n8n"]);

export function createWorkflowConfig({ provider = "mock", baseUrl, enabled = false, metadata = {} } = {}) {
  if (!WORKFLOW_PROVIDERS.includes(provider)) {
    throw new WorkflowBoundaryError("Unsupported workflow provider.", "WORKFLOW_PROVIDER_UNSUPPORTED", {
      provider,
      supportedProviders: WORKFLOW_PROVIDERS
    });
  }
  if (enabled !== false) {
    throw new WorkflowBoundaryError(
      "Workflow external connections are disabled in Phase 0.",
      "WORKFLOW_EXTERNAL_CONNECTION_FORBIDDEN",
      { provider }
    );
  }

  return Object.freeze({
    provider,
    baseUrl: baseUrl ?? null,
    enabled: false,
    status: provider === "n8n" ? "contract_prepared_not_connected" : "offline_mock",
    externalConnectionsEnabled: false,
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
