import { createAuditEvent } from "../observability/audit.js";
import { ApprovalStateError, createApprovalRequest } from "../security/approval.js";
import { evaluateActionPolicy } from "../security/permissions.js";
import { ToolContractError, validateToolInput } from "./contract.js";
import { createMvpToolRegistry } from "./mvp-tools.js";
import { ToolRegistryError } from "./registry.js";

export class ToolExecutionServiceError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ToolExecutionServiceError";
    this.code = code;
    this.details = details;
  }
}

export class ToolExecutionService {
  constructor({ repository, toolRegistry = null } = {}) {
    if (!repository) {
      throw new ToolExecutionServiceError("ToolExecutionService requires a repository.", "REPOSITORY_REQUIRED");
    }

    this.repository = repository;
    this.toolRegistry = toolRegistry ?? createMvpToolRegistry({ repository });
  }

  async execute({
    agentId,
    agentPermissions = [],
    toolId,
    input = {},
    requestId,
    planId = null,
    planStepId = null,
    executionId = null,
    approvalId = null,
    metadata = {}
  } = {}) {
    const tool = this.#getToolOrThrow(toolId);
    await this.#assertAgentAllowed(tool, { agentId, requestId, planId, planStepId, executionId });
    const permissionDecision = await this.#assertPermissionAllowed(tool, {
      agentId,
      agentPermissions,
      requestId,
      planId,
      planStepId,
      executionId
    });
    this.#validateInput(tool, input);
    const approval = await this.#resolveApproval({
      tool,
      agentId,
      input,
      requestId,
      planId,
      planStepId,
      approvalId,
      permissionDecision
    });

    let createdByService = false;
    const execution = executionId
      ? await this.#getExistingExecution(executionId)
      : await this.#createExecution({
          requestId,
          planId,
          planStepId,
          agentId,
          input,
          metadata
        });
    createdByService = !executionId;

    if (createdByService) {
      await this.#audit({
        type: "execution_created",
        agentId,
        requestId,
        planId,
        planStepId,
        executionId: execution.id,
        resourceType: "execution",
        resourceId: execution.id,
        metadata: { status: execution.status }
      });
    }

    const startedAt = execution.startedAt ?? new Date().toISOString();
    const auditContext = {
      agentId,
      requestId,
      planId,
      planStepId,
      executionId: execution.id,
      resourceType: "tool",
      resourceId: tool.id
    };

    if (approval) {
      try {
        await this.repository.markApprovalExecuted(approval.id, {
          executionId: execution.id
        });
      } catch (cause) {
        const error = normalizeToolFailure(cause, tool.id);
        const savedExecution = await this.#finishExecution({
          execution,
          status: "failed",
          requestId,
          planId,
          planStepId,
          agentId,
          input,
          output: null,
          error: {
            name: error.name,
            code: error.code,
            message: error.message
          },
          metadata,
          startedAt
        });
        error.details = {
          ...error.details,
          executionId: savedExecution.id
        };
        throw error;
      }
    }

    await this.#audit({
      type: "tool_called",
      ...auditContext,
      metadata: {
        toolId: tool.id,
        category: tool.category,
        requiredPermission: tool.requiredPermission
      }
    });

    try {
      const toolExecution = await this.toolRegistry.execute(tool.id, {
        repository: this.repository,
        requestId,
        planId,
        stepId: planStepId,
        executionId: execution.id,
        agentId,
        agentPermissions,
        approvalGranted: approval?.status === "approved",
        approvalId: approval?.id ?? null,
        audit: false
      }, input);

      const output = {
        agentId,
        toolId: toolExecution.toolId,
        result: toolExecution.output
      };
      const savedExecution = await this.#finishExecution({
        execution,
        status: "completed",
        requestId,
        planId,
        planStepId,
        agentId,
        input,
        output,
        error: null,
        metadata,
        startedAt
      });

      await this.#audit({
        type: "tool_completed",
        ...auditContext,
        metadata: {
          toolId: tool.id,
          outputSummary: summarizeOutput(toolExecution.output)
        }
      });

      return Object.freeze({
        status: "completed",
        toolId: tool.id,
        output,
        execution: savedExecution,
        approval
      });
    } catch (cause) {
      const error = normalizeToolFailure(cause, tool.id);
      const savedExecution = await this.#finishExecution({
        execution,
        status: "failed",
        requestId,
        planId,
        planStepId,
        agentId,
        input,
        output: null,
        error: {
          name: error.name,
          code: error.code,
          message: error.message
        },
        metadata,
        startedAt
      });

      await this.#audit({
        type: "tool_failed",
        ...auditContext,
        metadata: {
          error: {
            name: error.name,
            code: error.code
          }
        }
      });

      error.details = {
        ...error.details,
        executionId: savedExecution.id
      };
      throw error;
    }
  }

  #getToolOrThrow(toolId) {
    const tool = this.toolRegistry.get(toolId);
    if (!tool) {
      throw new ToolExecutionServiceError(`Tool is not registered: ${toolId}`, "TOOL_NOT_FOUND", {
        toolId
      });
    }
    return tool;
  }

  async #assertAgentAllowed(tool, { agentId, requestId, planId, planStepId, executionId }) {
    if (!tool.allowedAgents.includes(agentId)) {
      const error = new ToolExecutionServiceError(
        `Agent is not allowed to execute tool: ${agentId}`,
        "AGENT_NOT_ALLOWED",
        { toolId: tool.id, agentId }
      );
      await this.#auditPermissionDenied({ error, tool, agentId, requestId, planId, planStepId, executionId });
      throw error;
    }
  }

  async #assertPermissionAllowed(tool, { agentId, agentPermissions, requestId, planId, planStepId, executionId }) {
    const permissionDecision = evaluateActionPolicy({
      permissions: agentPermissions,
      actionKind: tool.requiredPermission,
      resource: `request:${requestId}`,
      requiresApproval: tool.requiredPermission === "human_approval_required"
    });

    if (!permissionDecision.allowed && !permissionDecision.canPrepare && !hasMatchingApprovalPermission(agentPermissions, `request:${requestId}`)) {
      const error = new ToolExecutionServiceError("Tool permission denied.", "PERMISSION_DENIED", {
        toolId: tool.id,
        agentId,
        permissionDecision
      });
      await this.#auditPermissionDenied({ error, tool, agentId, requestId, planId, planStepId, executionId });
      throw error;
    }

    return permissionDecision;
  }

  #validateInput(tool, input) {
    try {
      validateToolInput(tool.inputSchema, input);
    } catch (cause) {
      if (cause instanceof ToolContractError) {
        throw new ToolExecutionServiceError(cause.message, "INVALID_INPUT", {
          toolId: tool.id,
          details: cause.details
        });
      }
      throw cause;
    }
  }

  async #getExistingExecution(executionId) {
    const execution = await this.repository.getExecution(executionId);
    if (!execution) {
      throw new ToolExecutionServiceError(`Execution not found: ${executionId}`, "EXECUTION_NOT_FOUND", {
        executionId
      });
    }
    return execution;
  }

  async #resolveApproval({ tool, agentId, input, requestId, planId, planStepId, approvalId, permissionDecision }) {
    if (!requiresApproval(tool, permissionDecision)) {
      return null;
    }

    if (!approvalId) {
      const existing = await this.#findPendingApproval({ tool, requestId, planStepId, agentId });
      const approval = existing ?? await this.#createPendingApproval({
        tool,
        agentId,
        input,
        requestId,
        planId,
        planStepId,
        permissionDecision
      });
      throw new ToolExecutionServiceError("Human approval is required before tool execution.", "APPROVAL_REQUIRED", {
        toolId: tool.id,
        agentId,
        approval
      });
    }

    const approval = await this.repository.getApproval(approvalId);
    if (!approval) {
      throw new ToolExecutionServiceError(`Approval not found: ${approvalId}`, "APPROVAL_NOT_FOUND", {
        approvalId
      });
    }

    this.#assertApprovalMatches({ approval, tool, agentId, requestId, planStepId });

    if (["pending", "requested"].includes(approval.status)) {
      throw new ToolExecutionServiceError("Approval is still pending.", "APPROVAL_REQUIRED", {
        approvalId,
        approval
      });
    }

    if (approval.status === "rejected") {
      throw new ToolExecutionServiceError("Approval was rejected.", "APPROVAL_REJECTED", {
        approvalId,
        approval
      });
    }

    if (approval.status !== "approved") {
      throw new ToolExecutionServiceError("Approval is not executable.", "APPROVAL_INVALID", {
        approvalId,
        approval
      });
    }

    if (approval.metadata?.executedAt || approval.metadata?.executionId) {
      throw new ToolExecutionServiceError("Approval has already been executed.", "APPROVAL_ALREADY_EXECUTED", {
        approvalId,
        executionId: approval.metadata.executionId
      });
    }

    return approval;
  }

  async #findPendingApproval({ tool, requestId, planStepId, agentId }) {
    const approvals = await this.repository.listPendingApprovals({
      requestId,
      planStepId
    });
    return approvals.find((approval) =>
      approval.requestingAgent === agentId &&
      approval.metadata?.toolId === tool.id
    ) ?? null;
  }

  async #createPendingApproval({ tool, agentId, input, requestId, planId, planStepId, permissionDecision }) {
    const approval = await this.repository.createApproval(createApprovalRequest({
      requestId,
      planStepId,
      requestingAgent: agentId,
      requestedByAgentId: agentId,
      requestedAction: tool.id,
      reason: `Human approval is required before executing tool ${tool.id}.`,
      affectedResource: `request:${requestId}`,
      risk: tool.requiredPermission === "execute_action" ? "high" : "medium",
      status: "pending",
      metadata: {
        toolId: tool.id,
        toolCategory: tool.category,
        requiredPermission: tool.requiredPermission,
        planId,
        inputSummary: summarizeInput(input),
        permissionDecision: {
          decision: permissionDecision.decision,
          reason: permissionDecision.reason
        }
      }
    }));

    await this.#audit({
      type: "approval_requested",
      agentId,
      requestId,
      planId,
      planStepId,
      resourceType: "approval",
      resourceId: approval.id,
      metadata: {
        approvalId: approval.id,
        toolId: tool.id,
        status: approval.status,
        risk: approval.risk
      }
    });

    return approval;
  }

  #assertApprovalMatches({ approval, tool, agentId, requestId, planStepId }) {
    const matches =
      approval.requestId === requestId &&
      approval.planStepId === planStepId &&
      approval.requestingAgent === agentId &&
      approval.requestedAction === tool.id &&
      approval.metadata?.toolId === tool.id;

    if (!matches) {
      throw new ToolExecutionServiceError("Approval does not match the requested tool execution.", "APPROVAL_INVALID", {
        approvalId: approval.id,
        toolId: tool.id
      });
    }
  }

  async #createExecution({ requestId, planId, planStepId, agentId, input, metadata }) {
    const startedAt = new Date().toISOString();
    return this.repository.saveExecution({
      requestId,
      planId,
      planStepId,
      agentId,
      status: "executing",
      input,
      output: null,
      error: null,
      metadata,
      startedAt,
      finishedAt: null,
      durationMs: null
    });
  }

  async #finishExecution({
    execution,
    status,
    requestId,
    planId,
    planStepId,
    agentId,
    input,
    output,
    error,
    metadata,
    startedAt
  }) {
    const finishedAt = new Date().toISOString();
    return this.repository.saveExecution({
      id: execution.id,
      requestId,
      planId,
      planStepId,
      agentId,
      status,
      input,
      output,
      error,
      metadata,
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt)
    });
  }

  async #audit(event) {
    return this.repository.createAuditEvent(createAuditEvent(event));
  }

  async #auditPermissionDenied({ error, tool, agentId, requestId, planId, planStepId, executionId }) {
    return this.#audit({
      type: "permission_denied",
      agentId,
      requestId,
      planId,
      planStepId,
      executionId: executionId ?? null,
      resourceType: "tool",
      resourceId: tool.id,
      metadata: {
        toolId: tool.id,
        code: error.code,
        decision: error.details?.permissionDecision?.decision,
        reason: error.details?.permissionDecision?.reason ?? error.message
      }
    });
  }
}

function normalizeToolFailure(cause, toolId) {
  if (cause instanceof ToolExecutionServiceError) {
    return cause;
  }

  if (cause instanceof ApprovalStateError) {
    return new ToolExecutionServiceError(cause.message, cause.code, {
      ...cause.details,
      toolId
    });
  }

  if (cause instanceof ToolRegistryError) {
    return new ToolExecutionServiceError(cause.message, mapRegistryCode(cause.code), {
      ...cause.details,
      toolId
    });
  }

  return new ToolExecutionServiceError(cause?.message ?? String(cause), "TOOL_FAILED", {
    toolId
  });
}

function requiresApproval(tool, permissionDecision) {
  return tool.requiredPermission !== "read_analyze" || permissionDecision.requiresApproval;
}

function hasMatchingApprovalPermission(permissions, resource) {
  return permissions.some((permission) =>
    ["prepare_action", "execute_action", "human_approval_required"].includes(permission.kind) &&
    matchesResource(permission.resource, resource)
  );
}

function matchesResource(permissionResource = "*", requestedResource = "*") {
  if (permissionResource === "*" || requestedResource === "*") {
    return true;
  }
  if (permissionResource === requestedResource) {
    return true;
  }
  if (permissionResource.endsWith(":*")) {
    return requestedResource.startsWith(permissionResource.slice(0, -1));
  }
  return false;
}

function summarizeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { type: typeof input };
  }

  const fields = Object.keys(input).sort();
  return {
    type: "object",
    fields,
    fieldCount: fields.length,
    hasSensitiveFields: fields.some((field) => isSensitiveField(field))
  };
}

function isSensitiveField(field) {
  return ["apikey", "password", "token", "secret", "credential"].some((fragment) =>
    field.toLowerCase().includes(fragment)
  );
}

function mapRegistryCode(code) {
  if (code === "PERMISSION_DENIED") {
    return "PERMISSION_DENIED";
  }
  return ["TOOL_NOT_FOUND", "AGENT_NOT_ALLOWED", "INVALID_INPUT", "TOOL_FAILED", "ADAPTER_NOT_FOUND"].includes(code)
    ? code
    : "TOOL_FAILED";
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
