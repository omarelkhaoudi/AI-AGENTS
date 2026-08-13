import { randomUUID } from "node:crypto";
import { redact } from "./logger.js";

export const AUDIT_EVENT_TYPES = Object.freeze([
  "request_created",
  "plan_created",
  "plan_step_created",
  "agent_selected",
  "execution_created",
  "permission_checked",
  "permission_denied",
  "agent_called",
  "tool_called",
  "action_prepared",
  "approval_requested",
  "approval_granted",
  "approval_rejected",
  "execution_completed",
  "execution_failed"
]);

export class AuditEventError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuditEventError";
  }
}

export function createAuditEvent({
  id = randomUUID(),
  type,
  actorUserId = null,
  agentId = null,
  requestId = null,
  planId = null,
  planStepId = null,
  executionId = null,
  documentId = null,
  resourceType = null,
  resourceId = null,
  metadata = {},
  createdAt = new Date().toISOString()
} = {}) {
  if (!AUDIT_EVENT_TYPES.includes(type)) {
    throw new AuditEventError(`Unknown audit event type: ${type}`);
  }

  return Object.freeze({
    id,
    type,
    actorUserId,
    agentId,
    requestId,
    planId,
    planStepId,
    executionId,
    documentId,
    resourceType,
    resourceId,
    metadata: redact(metadata),
    createdAt
  });
}
