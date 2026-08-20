import { redact } from "../observability/logger.js";

export const PLANNER_PLAN_VERSION = "1";
const PLAN_FIELDS = Object.freeze(["version", "requestId", "intent", "summary", "planner", "agents", "steps", "metadata"]);
const STEP_FIELDS = Object.freeze([
  "id",
  "agentId",
  "sequence",
  "actionKind",
  "actionType",
  "toolName",
  "resource",
  "reason",
  "input",
  "requiresApproval"
]);
const FORBIDDEN_INPUT_KEYS = Object.freeze([
  "command",
  "commands",
  "exec",
  "eval",
  "function",
  "script",
  "shell",
  "sql",
  "url"
]);
const FORBIDDEN_INPUT_PATTERNS = Object.freeze([
  /\beval\s*\(/i,
  /\bfunction\s*\(/i,
  /\bnew\s+Function\b/i,
  /\b(select|insert|update|delete|drop|alter)\s+.+\b(from|into|table|where)\b/i,
  /\b(?:curl|wget|powershell|cmd\.exe|bash|sh)\b/i,
  /^https?:\/\//i
]);

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

  const steps = Array.isArray(plan.steps)
    ? plan.steps.map((step, index) => normalizePlannerStep(step, index))
    : null;

  return Object.freeze({
    version: plan.version,
    requestId: plan.requestId,
    intent: plan.intent,
    summary: plan.summary,
    planner: plan.planner,
    agents: Array.isArray(plan.agents) ? [...plan.agents] : plan.agents,
    steps,
    metadata: plan.metadata && typeof plan.metadata === "object" && !Array.isArray(plan.metadata)
      ? { ...plan.metadata }
      : plan.metadata
  });
}

export async function validatePlannerPlan(plan, { repository, toolRegistry } = {}) {
  const errors = [];

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throwPlanInvalid(["plan must be an object"]);
  }

  collectUnexpectedFields(plan, PLAN_FIELDS, "plan", errors);
  requireExactText(plan.version, PLANNER_PLAN_VERSION, "version", errors);
  requireText(plan.requestId, "requestId", errors);
  requireText(plan.intent, "intent", errors);
  requireText(plan.summary, "summary", errors);
  requireText(plan.planner, "planner", errors);

  if (plan.metadata !== undefined && (!plan.metadata || typeof plan.metadata !== "object" || Array.isArray(plan.metadata))) {
    errors.push("metadata must be an object when provided");
  } else if (plan.metadata !== undefined) {
    validateJsonValue(plan.metadata, "metadata", errors);
  }

  if (!Array.isArray(plan.agents)) {
    errors.push("agents must be an array");
  }

  if (!Array.isArray(plan.steps)) {
    errors.push("steps must be an array");
  } else if (plan.steps.length === 0) {
    errors.push("steps must contain at least one step");
  } else {
    const stepIds = new Set();
    const stepSequences = new Set();
    for (const [index, step] of plan.steps.entries()) {
      await validatePlannerStep(step, index, { repository, toolRegistry, errors });
      if (typeof step?.id === "string") {
        if (stepIds.has(step.id)) {
          errors.push(`steps[${index}].id is duplicated: ${step.id}`);
        }
        stepIds.add(step.id);
      }
      // A step sequence is unique per plan in the database schema. Checking it
      // here keeps an invalid plan from passing in memory and failing only once
      // it reaches PostgreSQL.
      if (Number.isInteger(step?.sequence)) {
        if (stepSequences.has(step.sequence)) {
          errors.push(`steps[${index}].sequence is duplicated: ${step.sequence}`);
        }
        stepSequences.add(step.sequence);
      }
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
    input: step.input && typeof step.input === "object" && !Array.isArray(step.input) ? { ...step.input } : step.input
  });
}

async function validatePlannerStep(step, index, { repository, toolRegistry, errors }) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    errors.push(`steps[${index}] must be an object`);
    return;
  }

  collectUnexpectedFields(step, STEP_FIELDS, `steps[${index}]`, errors);
  requireText(step.id, `steps[${index}].id`, errors);
  requireText(step.agentId, `steps[${index}].agentId`, errors);
  requireText(step.actionType, `steps[${index}].actionType`, errors);
  requireText(step.actionKind, `steps[${index}].actionKind`, errors);
  requireText(step.toolName, `steps[${index}].toolName`, errors);
  requireText(step.resource, `steps[${index}].resource`, errors);
  requireText(step.reason, `steps[${index}].reason`, errors);

  if (!Number.isInteger(step.sequence) || step.sequence < 1) {
    errors.push(`steps[${index}].sequence must be a positive integer`);
  }

  if (!step.input || typeof step.input !== "object" || Array.isArray(step.input)) {
    errors.push(`steps[${index}].input must be an object`);
  } else {
    validateJsonValue(step.input, `steps[${index}].input`, errors);
    validateSafeToolInput(step.input, `steps[${index}].input`, errors);
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

function requireText(value, field, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} is required`);
  }
}

function requireExactText(value, expected, field, errors) {
  if (value !== expected) {
    errors.push(`${field} must be ${JSON.stringify(expected)}`);
  }
}

function collectUnexpectedFields(value, allowed, path, errors) {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) {
      errors.push(`${path}.${field} is not allowed`);
    }
  }
}

function validateJsonValue(value, path, errors) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    errors.push(`${path} must be JSON-compatible`);
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateJsonValue(entry, `${path}[${index}]`, errors));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    validateJsonValue(nested, `${path}.${key}`, errors);
  }
}

function validateSafeToolInput(input, path, errors) {
  if (Array.isArray(input)) {
    input.forEach((entry, index) => {
      if (entry && typeof entry === "object") {
        validateSafeToolInput(entry, `${path}[${index}]`, errors);
      }
    });
    return;
  }

  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = key.toLowerCase();
    if (FORBIDDEN_INPUT_KEYS.some((forbidden) => normalizedKey.includes(forbidden))) {
      errors.push(`${path}.${key} is not allowed in planner tool input`);
    }
    if (typeof value === "string" && FORBIDDEN_INPUT_PATTERNS.some((pattern) => pattern.test(value.trim()))) {
      errors.push(`${path}.${key} contains executable or unsafe content`);
    }
    if (value && typeof value === "object") {
      validateSafeToolInput(value, `${path}.${key}`, errors);
    }
  }
}

function throwPlanInvalid(errors) {
  throw new PlannerContractError("Planner returned an invalid plan.", "PLAN_INVALID", { errors });
}
