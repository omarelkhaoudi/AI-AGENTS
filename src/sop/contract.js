import { BUSINESS_DOMAINS } from "../business-memory/domain-contract.js";

export const SOP_STATUSES = Object.freeze(["draft", "confirmed"]);

export class SopContractError extends Error {
  constructor(message, code = "INVALID_SOP", details = {}) {
    super(message);
    this.name = "SopContractError";
    this.code = code;
    this.details = details;
  }
}

export function createSopDefinition({
  id,
  agentId,
  name,
  description,
  status = "draft",
  steps = [],
  inputs = [],
  outputs = [],
  requiredApprovals = [],
  relatedDomains = [],
  metadata = {}
} = {}) {
  const sop = {
    id,
    agentId,
    name,
    description,
    status,
    steps: steps.map((step) => Object.freeze({ ...step })),
    inputs: inputs.map((input) => Object.freeze({ ...input })),
    outputs: outputs.map((output) => Object.freeze({ ...output })),
    requiredApprovals: requiredApprovals.map((approval) => Object.freeze({ ...approval })),
    relatedDomains: [...relatedDomains],
    metadata: Object.freeze({ ...metadata })
  };

  validateSopDefinition(sop);
  return Object.freeze({
    ...sop,
    steps: Object.freeze(sop.steps),
    inputs: Object.freeze(sop.inputs),
    outputs: Object.freeze(sop.outputs),
    requiredApprovals: Object.freeze(sop.requiredApprovals),
    relatedDomains: Object.freeze(sop.relatedDomains)
  });
}

export function validateSopDefinition(sop) {
  const errors = [];

  requireText(sop?.id, "id", errors);
  requireText(sop?.agentId, "agentId", errors);
  requireText(sop?.name, "name", errors);
  requireText(sop?.description, "description", errors);

  if (!SOP_STATUSES.includes(sop?.status)) {
    errors.push(`status must be one of: ${SOP_STATUSES.join(", ")}`);
  }

  validateArray(sop?.steps, "steps", errors, validateSopStep);
  validateArray(sop?.inputs, "inputs", errors, validateNamedEntry);
  validateArray(sop?.outputs, "outputs", errors, validateNamedEntry);
  validateArray(sop?.requiredApprovals, "requiredApprovals", errors, validateApprovalEntry);

  if (!Array.isArray(sop?.relatedDomains)) {
    errors.push("relatedDomains must be an array");
  } else {
    for (const [index, domain] of sop.relatedDomains.entries()) {
      if (!BUSINESS_DOMAINS.includes(domain)) {
        errors.push(`relatedDomains[${index}] must be a known business domain`);
      }
    }
  }

  if (!sop?.metadata || typeof sop.metadata !== "object" || Array.isArray(sop.metadata)) {
    errors.push("metadata must be an object");
  }

  if (sop?.metadata?.executesTools === true) {
    errors.push("SOP definitions must not execute tools directly");
  }

  if (errors.length > 0) {
    throw new SopContractError("Invalid SOP definition.", "INVALID_SOP", { errors });
  }

  return true;
}

function validateSopStep(step, field, errors) {
  requireText(step?.id, `${field}.id`, errors);
  requireText(step?.description, `${field}.description`, errors);
  if (typeof step?.order !== "number" || !Number.isInteger(step.order) || step.order < 1) {
    errors.push(`${field}.order must be a positive integer`);
  }
  if (step?.toolId !== undefined || step?.execute !== undefined) {
    errors.push(`${field} must not declare direct tool execution`);
  }
}

function validateNamedEntry(entry, field, errors) {
  requireText(entry?.name, `${field}.name`, errors);
  if (entry?.description !== undefined && typeof entry.description !== "string") {
    errors.push(`${field}.description must be a string when provided`);
  }
}

function validateApprovalEntry(entry, field, errors) {
  requireText(entry?.action, `${field}.action`, errors);
  requireText(entry?.reason, `${field}.reason`, errors);
  if (entry?.required !== true) {
    errors.push(`${field}.required must be true`);
  }
}

function validateArray(value, field, errors, validateEntry) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${field} must be a non-empty array`);
    return;
  }

  for (const [index, entry] of value.entries()) {
    validateEntry(entry, `${field}[${index}]`, errors);
  }
}

function requireText(value, field, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`);
  }
}
