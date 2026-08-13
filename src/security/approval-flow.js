import { createAuditEvent } from "../observability/audit.js";
import { ToolExecutionService } from "../tools/execution-service.js";
import { ApprovalStateError } from "./approval.js";

export async function approveApprovalRequest({
  repository,
  approvalId,
  approverId = null,
  decisionReason = null
} = {}) {
  const approval = await repository.approveApproval(approvalId, {
    approverId,
    decisionReason
  });

  await audit(repository, {
    type: "approval_granted",
    actorUserId: approverId,
    agentId: approval.requestingAgent,
    requestId: approval.requestId,
    planStepId: approval.planStepId,
    resourceType: "approval",
    resourceId: approval.id,
    metadata: {
      approvalId: approval.id,
      status: approval.status,
      decisionReasonProvided: typeof decisionReason === "string" && decisionReason.length > 0
    }
  });

  return approval;
}

export async function rejectApprovalRequest({
  repository,
  approvalId,
  approverId = null,
  decisionReason = null
} = {}) {
  const approval = await repository.rejectApproval(approvalId, {
    approverId,
    decisionReason
  });

  await audit(repository, {
    type: "approval_rejected",
    actorUserId: approverId,
    agentId: approval.requestingAgent,
    requestId: approval.requestId,
    planStepId: approval.planStepId,
    resourceType: "approval",
    resourceId: approval.id,
    metadata: {
      approvalId: approval.id,
      status: approval.status,
      decisionReasonProvided: typeof decisionReason === "string" && decisionReason.length > 0
    }
  });

  return approval;
}

export async function executeApprovedApproval({
  repository,
  approval,
  toolRegistry = null
} = {}) {
  if (!approval || approval.status !== "approved") {
    throw new ApprovalStateError("Approval must be approved before execution.", "APPROVAL_NOT_APPROVED", {
      approvalId: approval?.id ?? null,
      status: approval?.status ?? null
    });
  }

  const request = approval.requestId ? await repository.getRequest(approval.requestId) : null;
  const planStep = findPlanStep(request, approval.planStepId);
  if (!request || !planStep) {
    throw new ApprovalStateError("Approval does not reference an executable plan step.", "APPROVAL_INVALID", {
      approvalId: approval.id,
      requestId: approval.requestId,
      planStepId: approval.planStepId
    });
  }

  const agent = planStep.agent ?? await repository.getAgent(planStep.agentId);
  if (!agent) {
    throw new ApprovalStateError("Approval references an unknown agent.", "APPROVAL_INVALID", {
      approvalId: approval.id,
      agentId: planStep.agentId
    });
  }

  const toolId = approval.metadata?.toolId ?? planStep.toolName ?? approval.requestedAction;
  const service = new ToolExecutionService({
    repository,
    toolRegistry
  });

  return service.execute({
    agentId: agent.id,
    agentPermissions: agent.permissions ?? [],
    toolId,
    input: planStep.input ?? { requestId: request.id },
    requestId: request.id,
    planId: planStep.planId,
    planStepId: planStep.id,
    approvalId: approval.id,
    metadata: {
      approvalId: approval.id,
      toolName: toolId
    }
  });
}

function findPlanStep(request, planStepId) {
  return request?.plans
    ?.flatMap((plan) => plan.steps ?? [])
    .find((step) => step.id === planStepId) ?? null;
}

async function audit(repository, event) {
  return repository.createAuditEvent(createAuditEvent(event));
}
