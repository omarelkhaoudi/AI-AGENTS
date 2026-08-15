import { createAuditEvent } from "../observability/audit.js";
import { canExecuteAction, evaluateActionPolicy } from "../security/permissions.js";
import { ToolExecutionService } from "../tools/execution-service.js";
import { createMvpToolRegistry } from "../tools/mvp-tools.js";
import { createDeterministicPlanner } from "./deterministic-planner.js";
import { DirectorExecutionError } from "./orchestrator.js";
import { PlannerContractError, PlanningError, runPlanner, validatePlannerPlan } from "./planner-contract.js";

export async function orchestrateRequest({
  requestId,
  repository,
  planner = createDeterministicPlanner(),
  toolRegistry = null
} = {}) {
  if (!repository) {
    throw new DirectorExecutionError("Request orchestration requires a repository.");
  }

  return repository.transaction((transactionRepository) =>
    orchestrateRequestInTransaction({
      requestId,
      repository: transactionRepository,
      planner,
      toolRegistry
    })
  );
}

async function orchestrateRequestInTransaction({ requestId, repository, planner, toolRegistry }) {
  const request = await repository.getRequest(requestId);
  if (!request) {
    throw new DirectorExecutionError(`Request not found: ${requestId}`);
  }

  const registry = toolRegistry ?? createMvpToolRegistry({ repository });
  const toolExecutionService = new ToolExecutionService({
    repository,
    toolRegistry: registry
  });
  const planned = await createValidatedPlan({
    planner,
    request,
    repository,
    toolRegistry: registry
  });

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

    const plannedTool = plannedStep.toolName ? registry.get(plannedStep.toolName) : null;
    const stepRequiresApproval = Boolean(
      plannedStep.requiresApproval === true ||
      (plannedTool && plannedTool.requiredPermission !== "read_analyze")
    );

    const planStep = await repository.createPlanStep({
      planId: plan.id,
      agentId: agent.id,
      sequence: plannedStep.sequence,
      status: "created",
      actionType: plannedStep.actionType,
      toolName: plannedStep.toolName ?? null,
      input: plannedStep.input,
      requiresApproval: stepRequiresApproval
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
          requiresApproval: stepRequiresApproval
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

    const canDelegateToToolExecutionService =
      plannedStep.toolName &&
      stepRequiresApproval === true &&
      policyDecision.canPrepare === true;
    if (!canExecuteAction(policyDecision) && !canDelegateToToolExecutionService) {
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
        await createBlockedExecution(repository, {
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

    let output;
    try {
      if (plannedStep.toolName) {
        const toolExecution = await toolExecutionService.execute({
          agentId: agent.id,
          agentPermissions: agent.permissions ?? [],
          toolId: plannedStep.toolName,
          input: plannedStep.input ?? {},
          requestId: request.id,
          planId: plan.id,
          planStepId: planStep.id,
          metadata: {
            planner: planned.planner,
            toolName: plannedStep.toolName ?? null,
            policyDecision
          }
        });

        await auditExecutionFinished(repository, {
          execution: toolExecution.execution,
          request,
          plan,
          planStep,
          agent,
          status: "completed"
        });
        executions.push(toolExecution.execution);
        continue;
      } else {
        const execution = await createExecutionRecord(repository, {
          request,
          plan,
          planStep,
          agent,
          status: "executing",
          input: plannedStep.input,
          metadata: {
            planner: planned.planner,
            toolName: plannedStep.toolName ?? null,
            policyDecision
          }
        });
        output = {
          agentId: agent.id,
          status: "acknowledged",
          message: "Deterministic MVP execution placeholder. No business tools were invoked."
        };
        executions.push(
          await finishExecution(repository, {
            execution,
            request,
            plan,
            planStep,
            agent,
            status: "completed",
            input: plannedStep.input,
            output,
            metadata: {
              planner: planned.planner,
              toolName: plannedStep.toolName ?? null,
              policyDecision
            }
          })
        );
        continue;
      }
    } catch (error) {
      if (error.details?.executionId) {
        const failedExecution = await getFailedExecution(repository, error.details.executionId, null);
        executions.push(failedExecution);
        await auditExecutionFinished(repository, {
          execution: failedExecution,
          request,
          plan,
          planStep,
          agent,
          status: "failed"
        });
      }
      blockedSteps.push(plannedStep);
      continue;
    }
  }

  const finalStatus = blockedSteps.length > 0 ? "blocked" : "orchestrated";
  await repository.updateRequest(request.id, {
    status: finalStatus,
    result: {
      planId: plan.id,
      agents: executions.map((execution) => execution.agentId),
      executionIds: executions.map((execution) => execution.id),
      summary: createDirectorResultSummary({ finalStatus, executions, blockedSteps }),
      toolResults: executions.map((execution) => ({
        agentId: execution.agentId,
        status: execution.status,
        toolId: execution.output?.toolId ?? execution.metadata?.toolName ?? null,
        demo: execution.output?.result?.demo === true,
        itemCount: Array.isArray(execution.output?.result?.items) ? execution.output.result.items.length : undefined
      }))
    }
  });

  return repository.getRequest(request.id);
}

async function createExecutionRecord(repository, {
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
    finishedAt: null,
    durationMs: null
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

  return execution;
}

async function createValidatedPlan({ planner, request, repository, toolRegistry }) {
  try {
    const planned = await runPlanner(planner, { request, repository });
    await validatePlannerPlan(planned, { repository, toolRegistry });
    return planned;
  } catch (cause) {
    if (cause instanceof PlannerContractError) {
      throw cause;
    }

    throw new PlanningError("Planner failed before producing an executable plan.", {
      causeName: cause?.name ?? "Error",
      causeCode: cause?.code,
      causeMessage: cause?.message ?? String(cause)
    });
  }
}

async function createBlockedExecution(repository, options) {
  const execution = await createExecutionRecord(repository, options);
  await auditExecutionFinished(repository, {
    ...options,
    execution
  });
  return execution;
}

async function finishExecution(repository, {
  execution,
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
  const finishedAt = new Date().toISOString();
  const saved = await repository.saveExecution({
    id: execution.id,
    requestId: request.id,
    planId: plan.id,
    planStepId: planStep.id,
    agentId: agent.id,
    status,
    input,
    output,
    error,
    metadata,
    startedAt: execution.startedAt,
    finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(execution.startedAt)
  });

  await auditExecutionFinished(repository, {
    execution: saved,
    request,
    plan,
    planStep,
    agent,
    status
  });

  return saved;
}

async function getFailedExecution(repository, executionId, fallback) {
  return (await repository.getExecution(executionId)) ?? fallback;
}

async function auditExecutionFinished(repository, {
  execution,
  request,
  plan,
  planStep,
  agent,
  status
}) {
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

function createDirectorResultSummary({ finalStatus, executions, blockedSteps }) {
  return Object.freeze({
    status: finalStatus,
    completedExecutions: executions.filter((execution) => execution.status === "completed").length,
    blockedSteps: blockedSteps.length,
    agents: [...new Set(executions.map((execution) => execution.agentId))]
  });
}
