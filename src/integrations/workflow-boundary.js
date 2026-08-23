export class WorkflowBoundaryError extends Error {
  constructor(message, code = "WORKFLOW_BOUNDARY_ERROR", details = {}) {
    super(message);
    this.name = "WorkflowBoundaryError";
    this.code = code;
    this.details = details;
  }
}

export const WORKFLOW_PROVIDERS = Object.freeze(["mock", "n8n"]);

// Every activation used to be refused, so the application could not start at
// all with WORKFLOW_ENABLED=true. Activation is possible now, but only
// deliberately: the mock provider stays offline by design, and n8n needs
// somewhere to call before it can be turned on.
//
// Enabling the configuration is not a connection. Nothing has been reached at
// this point, no adapter exists, and the status says exactly that.
export function createWorkflowConfig({ provider = "mock", baseUrl, enabled = false, metadata = {} } = {}) {
  if (!WORKFLOW_PROVIDERS.includes(provider)) {
    throw new WorkflowBoundaryError("Unsupported workflow provider.", "WORKFLOW_PROVIDER_UNSUPPORTED", {
      provider,
      supportedProviders: WORKFLOW_PROVIDERS
    });
  }

  // A truthy string such as "true" used to be refused by accident, as part of
  // the blanket ban. It is refused on purpose now: reading an environment
  // variable is the caller's job, and a half-parsed flag must not open a door.
  if (enabled !== true && enabled !== false) {
    throw new WorkflowBoundaryError("enabled must be a boolean.", "WORKFLOW_ENABLED_INVALID", {
      provider,
      enabled
    });
  }

  if (enabled === true) {
    if (provider !== "n8n") {
      throw new WorkflowBoundaryError(
        "Only the n8n provider can be enabled: the mock provider is offline by design.",
        "WORKFLOW_PROVIDER_CANNOT_BE_ENABLED",
        { provider }
      );
    }
    if (!isCallableBaseUrl(baseUrl)) {
      throw new WorkflowBoundaryError(
        "Enabling n8n requires an http or https baseUrl.",
        "WORKFLOW_BASE_URL_REQUIRED",
        { provider }
      );
    }
  }

  return Object.freeze({
    provider,
    baseUrl: baseUrl ?? null,
    enabled,
    status: enabled
      ? "enabled_not_verified"
      : provider === "n8n"
        ? "contract_prepared_not_connected"
        : "offline_mock",
    externalConnectionsEnabled: enabled,
    metadata: { ...metadata }
  });
}

// An enabled workflow boundary has to have somewhere to call. Anything that is
// not an http or https URL is a configuration mistake, and failing here is
// cheaper than failing on the first outbound call.
function isCallableBaseUrl(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    return false;
  }

  try {
    const { protocol } = new URL(baseUrl);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export class WorkflowClient {
  constructor(config = createWorkflowConfig()) {
    this.config = config;
  }

  async invoke() {
    throw new WorkflowBoundaryError("Workflow invocation is not implemented in Phase 0.");
  }
}
