import { createAuditEvent } from "../observability/audit.js";
import { canExecuteAction, evaluateActionPolicy } from "../security/permissions.js";
import { createDeterministicPlanner } from "./deterministic-planner.js";
import { DirectorExecutionError } from "./orchestrator.js";

export async function orchestrateRequest({
  requestId,
  repository,
  planner = createDeterministicPlanner()
} = {}) {
  if (!repository) {
    throw new DirectorExecutionError("Request orchestration requires a repository.");
  }

  const request = await repository.getRequest(requestId);
  if (!request) {
    throw new DirectorExecutionError(`Request not found: ${requestId}`);
  }

  const planned = await planner({ request, repository });
  const plan = await repository.createPlan({
    requestId: request.id,
    createdByAgentId: "director",
    status: "created",
    summary: planned.summary,
    metadata: planned.metadata
  });

  await audit(repository, {
    type: "plan_created",
    actorUserId: request.createdById,
    agentId: "director",
    requestId: request.id,
    planId: plan.id,
    resourceType: "plan",
    resourceId: plan.id,
    metadata: { steps: planned.steps.length }
  });

  const executions = [];
  const blockedSteps = [];

  for (const plannedStep of planned.steps) {
    const agent = await repository.getAgent(plannedStep.agentId);
    if (!agent) {
      await audit(repository, {
        type: "permission_denied",
        actorUserId: request.createdById,
        agentId: plannedStep.agentId,
        requestId: request.id,
        planId: plan.id,
        resourceType: "agent",
        resourceId: plannedStep.agentId,
        metadata: { reason: "Agent does not exist." }
      });
      blockedSteps.push(plannedStep);
      continue;
    }

    const planStep = await repository.createPlanStep({
      planId: plan.id,
      agentId: agent.id,
      sequence: plannedStep.sequence,
      status: "created",
      actionType: plannedStep.actionType,
      input: plannedStep.input,
      requiresApproval: plannedStep.requiresApproval ?? false
    });

    await audit(repository, {
      type: "plan_step_created",
      actorUserId: request.createdById,
      agentId: agent.id,
      requestId: request.id,
      planId: plan.id,
      planStepId: planStep.id,
      resourceType: "plan_step",
      resourceId: planStep.id,
      metadata: { sequence: planStep.sequence, actionType: planStep.actionType }
    });

    await audit(repository, {
      type: "agent_selected",
      actorUserId: request.createdById,
      agentId: agent.id,
      requestId: request.id,
      planId: plan.id,
      planStepId: planStep.id,
      resourceType: "agent",
      resourceId: agent.id,
      metadata: { role: agent.role, reason: plannedStep.reason }
    });

    const activeCheck = isAgentActive(agent);
    const policyDecision = activeCheck.allowed
      ? evaluateActionPolicy({
          permissions: agent.permissions ?? [],
          actionKind: plannedStep.actionKind,
          resource: plannedStep.resource,
          requiresApproval: plannedStep.requiresApproval
        })
      : activeCheck;

    await audit(repository, {
      type: "permission_checked",
      actorUserId: request.createdById,
      agentId: agent.id,
      requestId: request.id,
      planId: plan.id,
      planStepId: planStep.id,
      resourceType: "permission",
      resourceId: plannedStep.resource,
      metadata: {
        actionKind: plannedStep.actionKind,
        decision: policyDecision.decision,
        allowed: policyDecision.allowed,
        reason: policyDecision.reason
      }
    });

    if (!canExecuteAction(policyDecision)) {
      await audit(repository, {
        type: "permission_denied",
        actorUserId: request.createdById,
        agentId: agent.id,
        requestId: request.id,
        planId: plan.id,
        planStepId: planStep.id,
        resourceType: "permission",
        resourceId: plannedStep.resource,
        metadata: {
          actionKind: plannedStep.actionKind,
          decision: policyDecision.decision,
          reason: policyDecision.reason
        }
      });

      executions.push(
        await createExecution(repository, {
          request,
          plan,
          planStep,
          agent,
          status: "blocked",
          input: plannedStep.input,
          error: {
            reason: policyDecision.reason,
            decision: policyDecision.decision
          },
          metadata: { policyDecision }
        })
      );
      blockedSteps.push(plannedStep);
      continue;
    }

    await audit(repository, {
      type: "agent_called",
      actorUserId: request.createdById,
      agentId: agent.id,
      requestId: request.id,
      planId: plan.id,
      planStepId: planStep.id,
      resourceType: "agent",
      resourceId: agent.id,
      metadata: { actionKind: plannedStep.actionKind }
    });

    executions.push(
      await createExecution(repository, {
        request,
        plan,
        planStep,
        agent,
        status: "completed",
        input: plannedStep.input,
        output: {
          agentId: agent.id,
          status: "acknowledged",
          message: "Deterministic MVP execution placeholder. No business tools were invoked."
        },
        metadata: {
          planner: "deterministic",
          policyDecision
        }
      })
    );
  }

  const finalStatus = blockedSteps.length > 0 ? "blocked" : "orchestrated";
  await repository.updateRequest(request.id, {
    status: finalStatus,
    result: {
      planId: plan.id,
      agents: executions.map((execution) => execution.agentId),
      executionIds: executions.map((execution) => execution.id)
    }
  });

  return repository.getRequest(request.id);
}

async function createExecution(repository, {
  request,
  plan,
  planStep,
  agent,
  status,
  input = null,
  output = null,
  error = null,
  metadata = {}
}) {
  const startedAt = new Date().toISOString();
  const finishedAt = new Date().toISOString();
  const execution = await repository.saveExecution({
    requestId: request.id,
    planId: plan.id,
    planStepId: planStep.id,
    agentId: agent.id,
    status,
    input,
    output,
    error,
    metadata,
    startedAt,
    finishedAt,
    durationMs: 0
  });

  await audit(repository, {
    type: "execution_created",
    actorUserId: request.createdById,
    agentId: agent.id,
    requestId: request.id,
    planId: plan.id,
    planStepId: planStep.id,
    executionId: execution.id,
    resourceType: "execution",
    resourceId: execution.id,
    metadata: { status: execution.status }
  });

  await audit(repository, {
    type: status === "completed" ? "execution_completed" : "execution_failed",
    actorUserId: request.createdById,
    agentId: agent.id,
    requestId: request.id,
    planId: plan.id,
    planStepId: planStep.id,
    executionId: execution.id,
    resourceType: "execution",
    resourceId: execution.id,
    metadata: { status: execution.status }
  });

  return execution;
}

function isAgentActive(agent) {
  if (agent.status === "available" || agent.status === "active") {
    return { allowed: true };
  }

  return Object.freeze({
    decision: "denied",
    allowed: false,
    canPrepare: false,
    requiresApproval: false,
    reason: `Agent is not active: ${agent.status}`
  });
}

async function audit(repository, event) {
  return repository.createAuditEvent(createAuditEvent(event));
}
