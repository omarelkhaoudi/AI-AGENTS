import { createAuditEvent } from "../observability/audit.js";
import { evaluateActionPolicy } from "../security/permissions.js";
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
  #repository;

  constructor({ repository = null } = {}) {
    this.#repository = repository;
  }

  register(tool) {
    validateToolDefinition(tool);

    if (this.#tools.has(tool.id)) {
      throw new ToolRegistryError(`Tool already registered: ${tool.id}`, "TOOL_ALREADY_REGISTERED");
    }

    this.#tools.set(tool.id, tool);
    return tool;
  }

  get(toolId) {
    return this.#tools.get(toolId) ?? null;
  }

  list() {
    return [...this.#tools.values()];
  }

  has(toolId) {
    return this.#tools.has(toolId);
  }

  async execute(toolId, context = {}, input = {}) {
    const repository = context.repository ?? this.#repository;
    const auditContext = createAuditContext(context, toolId);

    await audit(repository, {
      type: "tool_called",
      ...auditContext,
      metadata: {
        category: this.get(toolId)?.category ?? null
      }
    });

    const tool = this.get(toolId);
    if (!tool) {
      const error = new ToolRegistryError(`Tool is not registered: ${toolId}`, "TOOL_NOT_FOUND", {
        toolId
      });
      await auditFailure(repository, auditContext, error);
      throw error;
    }

    if (!tool.allowedAgents.includes(context.agentId)) {
      const error = new ToolRegistryError(
        `Agent is not allowed to execute tool: ${context.agentId}`,
        "AGENT_NOT_ALLOWED",
        { toolId, agentId: context.agentId }
      );
      await audit(repository, {
        type: "permission_denied",
        ...auditContext,
        metadata: {
          toolId,
          reason: error.message
        }
      });
      await auditFailure(repository, auditContext, error);
      throw error;
    }

    const permissionDecision = evaluateActionPolicy({
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
      await audit(repository, {
        type: "permission_denied",
        ...auditContext,
        metadata: {
          toolId,
          decision: permissionDecision.decision,
          reason: permissionDecision.reason
        }
      });
      await auditFailure(repository, auditContext, error);
      throw error;
    }

    try {
      validateToolInput(tool.inputSchema, input);
      const output = await tool.execute(createToolExecutionContext(context), input);
      await audit(repository, {
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
        : cause instanceof ToolRegistryError
        ? cause
        : new ToolRegistryError(cause?.message ?? String(cause), "TOOL_FAILED", { toolId });
      await auditFailure(repository, auditContext, error);
      throw error;
    }
  }
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

async function auditFailure(repository, auditContext, error) {
  await audit(repository, {
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

async function audit(repository, event) {
  if (!repository) {
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
