import { redact } from "../observability/logger.js";

export class PlannerContractError extends Error {
  constructor(message, code = "PLAN_INVALID", details = {}) {
    super(message);
    this.name = "PlannerContractError";
    this.code = code;
    this.details = details;
  }
}

export class PlanningError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PlanningError";
    this.code = "PLANNING_FAILED";
    this.details = redact(details);
  }
}

export function createPlanner({
  id,
  kind,
  description = "",
  plan
} = {}) {
  const planner = Object.freeze({
    id,
    kind,
    description,
    plan
  });
  validatePlanner(planner);
  return planner;
}

export function validatePlanner(planner) {
  const errors = [];
  requireText(planner?.id, "id", errors);
  requireText(planner?.kind, "kind", errors);
  if (typeof planner?.plan !== "function") {
    errors.push("plan must be a function");
  }

  if (errors.length > 0) {
    throw new PlannerContractError("Planner contract is invalid.", "PLANNER_INVALID", { errors });
  }

  return true;
}

export async function runPlanner(planner, { request, repository } = {}) {
  const normalizedRequest = normalizePlannerRequest(request);
  const rawPlan = typeof planner === "function"
    ? await planner({ request: normalizedRequest, repository })
    : await runPlannerObject(planner, { request: normalizedRequest, repository });

  return normalizePlannerPlan(rawPlan, planner);
}

export function normalizePlannerRequest(request = {}) {
  return Object.freeze({
    id: request.id ?? request.requestId,
    requestId: request.id ?? request.requestId,
    title: request.title ?? null,
    payload: request.payload && typeof request.payload === "object" ? { ...request.payload } : {},
    metadata: request.metadata && typeof request.metadata === "object" ? { ...request.metadata } : {},
    createdById: request.createdById ?? null,
    source: request.source ?? null,
    createdAt: request.createdAt ?? null
  });
}

export function normalizePlannerPlan(plan, planner = null) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new PlannerContractError("Planner must return a structured plan object.", "PLAN_INVALID");
  }

  const plannerId = plan.planner ?? planner?.id ?? plan.metadata?.planner ?? "unknown";
  const steps = Array.isArray(plan.steps)
    ? plan.steps.map((step, index) => normalizePlannerStep(step, index))
    : null;

  return Object.freeze({
    summary: plan.summary,
    planner: plannerId,
    agents: Array.isArray(plan.agents) ? [...plan.agents] : inferAgents(steps),
    steps,
    metadata: {
      ...(plan.metadata ?? {}),
      planner: plannerId
    }
  });
}

export async function validatePlannerPlan(plan, { repository, toolRegistry } = {}) {
  const errors = [];

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throwPlanInvalid(["plan must be an object"]);
  }

  requireText(plan.summary, "summary", errors);
  requireText(plan.planner, "planner", errors);

  if (!Array.isArray(plan.agents)) {
    errors.push("agents must be an array");
  }

  if (!Array.isArray(plan.steps)) {
    errors.push("steps must be an array");
  } else if (plan.steps.length === 0) {
    errors.push("steps must contain at least one step");
  } else {
    for (const [index, step] of plan.steps.entries()) {
      await validatePlannerStep(step, index, { repository, toolRegistry, errors });
    }
  }

  if (Array.isArray(plan.agents)) {
    for (const agentId of plan.agents) {
      if (typeof agentId !== "string" || agentId.trim().length === 0) {
        errors.push("agents must contain non-empty agent ids");
      } else if (repository && !(await repository.getAgent(agentId))) {
        errors.push(`agent does not exist: ${agentId}`);
      }
    }
  }

  if (errors.length > 0) {
    throwPlanInvalid(errors);
  }

  return true;
}

async function runPlannerObject(planner, context) {
  validatePlanner(planner);
  return planner.plan(context);
}

function normalizePlannerStep(step, index) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    return step;
  }

  return Object.freeze({
    ...step,
    sequence: step.sequence ?? index + 1,
    actionKind: step.actionKind ?? step.actionType,
    requiresApproval: step.requiresApproval ?? false,
    input: step.input && typeof step.input === "object" && !Array.isArray(step.input) ? { ...step.input } : step.input
  });
}

async function validatePlannerStep(step, index, { repository, toolRegistry, errors }) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    errors.push(`steps[${index}] must be an object`);
    return;
  }

  requireText(step.agentId, `steps[${index}].agentId`, errors);
  requireText(step.actionType, `steps[${index}].actionType`, errors);
  requireText(step.actionKind, `steps[${index}].actionKind`, errors);
  requireText(step.toolName, `steps[${index}].toolName`, errors);

  if (!step.input || typeof step.input !== "object" || Array.isArray(step.input)) {
    errors.push(`steps[${index}].input must be an object`);
  }

  if (typeof step.requiresApproval !== "boolean") {
    errors.push(`steps[${index}].requiresApproval must be a boolean`);
  }

  if (typeof step.agentId === "string" && repository && !(await repository.getAgent(step.agentId))) {
    errors.push(`steps[${index}].agentId does not exist: ${step.agentId}`);
  }

  if (typeof step.toolName === "string" && toolRegistry && !toolRegistry.has(step.toolName)) {
    errors.push(`steps[${index}].toolName does not exist: ${step.toolName}`);
  }
}

function inferAgents(steps) {
  if (!Array.isArray(steps)) {
    return [];
  }
  return [...new Set(steps.map((step) => step?.agentId).filter(Boolean))];
}

function requireText(value, field, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} is required`);
  }
}

function throwPlanInvalid(errors) {
  throw new PlannerContractError("Planner returned an invalid plan.", "PLAN_INVALID", { errors });
}
