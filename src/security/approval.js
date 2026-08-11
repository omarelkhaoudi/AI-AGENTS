import { randomUUID } from "node:crypto";

export const APPROVAL_STATUSES = Object.freeze([
  "requested",
  "approved",
  "rejected",
  "cancelled",
  "expired"
]);

export const RISK_LEVELS = Object.freeze(["low", "medium", "high", "critical"]);

export class ApprovalModelError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApprovalModelError";
  }
}

export function createApprovalRequest({
  id = randomUUID(),
  requestedAction,
  requestingAgent,
  reason,
  affectedResource,
  risk = "medium",
  status = "requested",
  approver = null,
  metadata = {},
  createdAt = new Date().toISOString(),
  updatedAt = createdAt
}) {
  requireText(requestedAction, "requestedAction");
  requireText(requestingAgent, "requestingAgent");
  requireText(reason, "reason");
  requireText(affectedResource, "affectedResource");

  if (!RISK_LEVELS.includes(risk)) {
    throw new ApprovalModelError(`Unknown risk level: ${risk}`);
  }

  if (!APPROVAL_STATUSES.includes(status)) {
    throw new ApprovalModelError(`Unknown approval status: ${status}`);
  }

  return Object.freeze({
    id,
    requestedAction,
    requestingAgent,
    reason,
    affectedResource,
    risk,
    status,
    approver,
    metadata: { ...metadata },
    createdAt,
    updatedAt
  });
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApprovalModelError(`${field} must be a non-empty string.`);
  }
}
