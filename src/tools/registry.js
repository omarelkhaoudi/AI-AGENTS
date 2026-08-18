import { createAuditEvent } from "../observability/audit.js";
import { evaluateActionPolicy } from "../security/permissions.js";
import {
  ToolAdapterError,
  executeToolAdapter,
  getToolAdapterMetadata,
  validateToolAdapter
} from "./adapters/contract.js";
import { ToolContractError, validateToolDefinition, validateToolInput } from "./contract.js";

export class ToolRegistryError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ToolRegistryError";
    this.code = code;
    this.details = details;
  }
}

export class ToolRegistry {
  #tools = new Map();
  #adapters = new Map();
  #repository;

  constructor({ repository = null, adapters = [] } = {}) {
    this.#repository = repository;
    for (const adapter of adapters) {
      this.registerAdapter(adapter);
    }
  }

  register(tool) {
    validateToolDefinition(tool);

    if (this.#tools.has(tool.id)) {
      throw new ToolRegistryError(`Tool already registered: ${tool.id}`, "TOOL_ALREADY_REGISTERED");
    }

    if (tool.adapter) {
      this.registerAdapter(tool.adapter);
    }

    this.#tools.set(tool.id, tool);
    return tool;
  }

  registerAdapter(adapter) {
    validateToolAdapter(adapter);

    if (this.#adapters.has(adapter.toolId)) {
      throw new ToolRegistryError(`Adapter already registered for tool: ${adapter.toolId}`, "ADAPTER_ALREADY_REGISTERED", {
        toolId: adapter.toolId
      });
    }

    this.#adapters.set(adapter.toolId, adapter);
    return adapter;
  }

  get(toolId) {
    return this.#tools.get(toolId) ?? null;
  }

  list() {
    return [...this.#tools.values()];
  }

  getAdapter(toolId) {
    return this.#adapters.get(toolId) ?? null;
  }

  listAdapters() {
    return [...this.#adapters.values()];
  }

  has(toolId) {
    return this.#tools.has(toolId);
  }

  hasAdapter(toolId) {
    return this.#adapters.has(toolId);
  }

  async execute(toolId, context = {}, input = {}) {
    const repository = context.repository ?? this.#repository;
    const auditContext = createAuditContext(context, toolId);
    const auditEnabled = context.audit !== false;

    await audit(repository, auditEnabled, {
      type: "tool_called",
      ...auditContext,
      metadata: {
        category: this.get(toolId)?.category ?? null,
        adapter: summarizeAdapter(this.getAdapter(toolId))
      }
    });

    const tool = this.get(toolId);
    if (!tool) {
      const error = new ToolRegistryError(`Tool is not registered: ${toolId}`, "TOOL_NOT_FOUND", {
        toolId
      });
      await auditFailure(repository, auditEnabled, auditContext, error);
      throw error;
    }

    if (!tool.allowedAgents.includes(context.agentId)) {
      const error = new ToolRegistryError(
        `Agent is not allowed to execute tool: ${context.agentId}`,
        "AGENT_NOT_ALLOWED",
        { toolId, agentId: context.agentId }
      );
      await audit(repository, auditEnabled, {
        type: "permission_denied",
        ...auditContext,
        metadata: {
          toolId,
          reason: error.message
        }
      });
      await auditFailure(repository, auditEnabled, auditContext, error);
      throw error;
    }

    if (tool.requiredPermission !== "read_analyze" && context.executedThroughToolExecutionService !== true) {
      const error = new ToolRegistryError("Sensitive tools must be executed through ToolExecutionService.", "PERMISSION_DENIED", {
        toolId,
        agentId: context.agentId,
        requiredPermission: tool.requiredPermission
      });
      await audit(repository, auditEnabled, {
        type: "permission_denied",
        ...auditContext,
        metadata: {
          toolId,
          reason: error.message
        }
      });
      await auditFailure(repository, auditEnabled, auditContext, error);
      throw error;
    }

    const permissionDecision = context.approvalGranted === true && context.executedThroughToolExecutionService === true
      ? {
          decision: "execute_directly",
          allowed: true,
          canPrepare: false,
          requiresApproval: false,
          reason: "Tool execution is covered by an approved human approval."
        }
      : evaluateActionPolicy({
          permissions: context.agentPermissions ?? [],
          actionKind: tool.requiredPermission,
          resource: `request:${context.requestId}`,
          requiresApproval: tool.requiredPermission === "human_approval_required"
        });

    if (!permissionDecision.allowed || permissionDecision.requiresApproval) {
      const error = new ToolRegistryError("Tool permission denied.", "PERMISSION_DENIED", {
        toolId,
        agentId: context.agentId,
        permissionDecision
      });
      await audit(repository, auditEnabled, {
        type: "permission_denied",
        ...auditContext,
        metadata: {
          toolId,
          decision: permissionDecision.decision,
          reason: permissionDecision.reason
        }
      });
      await auditFailure(repository, auditEnabled, auditContext, error);
      throw error;
    }

    try {
      validateToolInput(tool.inputSchema, input);
      const output = await executeRegisteredTool({
        tool,
        adapter: this.getAdapter(tool.id),
        context: createToolExecutionContext(context),
        input
      });
      await audit(repository, auditEnabled, {
        type: "tool_completed",
        ...auditContext,
        metadata: {
          toolId,
          outputSummary: summarizeOutput(output)
        }
      });
      return Object.freeze({
        toolId,
        status: "completed",
        output
      });
    } catch (cause) {
      const error = cause instanceof ToolContractError
        ? new ToolRegistryError(cause.message, "INVALID_INPUT", { toolId })
        : cause instanceof ToolAdapterError && cause.code === "INVALID_INPUT"
        ? new ToolRegistryError(cause.message, "INVALID_INPUT", { toolId })
        : cause instanceof ToolAdapterError
        ? new ToolRegistryError(cause.message, "TOOL_FAILED", {
            toolId,
            adapterCode: cause.code
          })
        : cause instanceof ToolRegistryError
        ? cause
        : new ToolRegistryError(cause?.message ?? String(cause), "TOOL_FAILED", { toolId });
      await auditFailure(repository, auditEnabled, auditContext, error);
      throw error;
    }
  }
}

async function executeRegisteredTool({ tool, adapter, context, input }) {
  if (adapter) {
    return executeToolAdapter(adapter, context, input);
  }

  if (tool.adapterRequired) {
    throw new ToolRegistryError(`No adapter is registered for tool: ${tool.id}`, "ADAPTER_NOT_FOUND", {
      toolId: tool.id
    });
  }

  return tool.execute(context, input);
}

function createToolExecutionContext(context) {
  return Object.freeze({
    requestId: context.requestId,
    planId: context.planId,
    stepId: context.stepId,
    executionId: context.executionId,
    agentId: context.agentId
  });
}

function createAuditContext(context, toolId) {
  return {
    agentId: context.agentId ?? null,
    requestId: context.requestId ?? null,
    planId: context.planId ?? null,
    planStepId: context.stepId ?? null,
    executionId: context.executionId ?? null,
    resourceType: "tool",
    resourceId: toolId
  };
}

async function auditFailure(repository, auditEnabled, auditContext, error) {
  await audit(repository, auditEnabled, {
    type: "tool_failed",
    ...auditContext,
    metadata: {
      error: {
        name: error.name,
        code: error.code
      }
    }
  });
}

async function audit(repository, auditEnabled, event) {
  if (!repository || !auditEnabled) {
    return null;
  }
  return repository.createAuditEvent(createAuditEvent(event));
}

function summarizeOutput(output) {
  if (!output || typeof output !== "object") {
    return { type: typeof output };
  }

  return {
    demo: output.demo === true,
    itemCount: Array.isArray(output.items) ? output.items.length : undefined
  };
}

function summarizeAdapter(adapter) {
  if (!adapter) {
    return null;
  }

  const metadata = getToolAdapterMetadata(adapter);
  return {
    toolId: adapter.toolId,
    kind: adapter.kind,
    metadata
  };
}
