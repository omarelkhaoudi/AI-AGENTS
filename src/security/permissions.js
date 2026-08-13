export const PERMISSION_KINDS = Object.freeze([
  "read_analyze",
  "prepare_action",
  "execute_action",
  "human_approval_required"
]);

export const ACTION_POLICY_DECISIONS = Object.freeze([
  "execute_directly",
  "prepare_only",
  "requires_human_approval",
  "denied"
]);

export class PermissionModelError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermissionModelError";
  }
}

export function createPermission({ kind, resource = "*", scope = "technical", metadata = {} }) {
  if (!PERMISSION_KINDS.includes(kind)) {
    throw new PermissionModelError(`Unknown permission kind: ${kind}`);
  }

  if (typeof resource !== "string" || resource.trim().length === 0) {
    throw new PermissionModelError("Permission resource must be a non-empty string.");
  }

  return Object.freeze({
    kind,
    resource,
    scope,
    metadata: { ...metadata }
  });
}

export function requiresHumanApproval(permission) {
  return permission?.kind === "human_approval_required";
}

export function evaluateActionPolicy({
  permissions = [],
  actionKind,
  resource = "*",
  requiresApproval = false
} = {}) {
  if (!PERMISSION_KINDS.includes(actionKind)) {
    throw new PermissionModelError(`Unknown action kind: ${actionKind}`);
  }

  const matchingPermissions = permissions.filter((permission) =>
    matchesResource(permission.resource, resource)
  );

  if (
    requiresApproval ||
    matchingPermissions.some((permission) => permission.kind === "human_approval_required")
  ) {
    return createDecision({
      decision: "requires_human_approval",
      allowed: false,
      canPrepare: true,
      requiresApproval: true,
      reason: "Human approval is required before execution."
    });
  }

  if (actionKind === "read_analyze" && hasAny(matchingPermissions, [
    "read_analyze",
    "prepare_action",
    "execute_action"
  ])) {
    return createDecision({
      decision: "execute_directly",
      allowed: true,
      canPrepare: false,
      requiresApproval: false,
      reason: "Read/analyze action is allowed."
    });
  }

  if (actionKind === "prepare_action" && hasAny(matchingPermissions, [
    "prepare_action",
    "execute_action"
  ])) {
    return createDecision({
      decision: "prepare_only",
      allowed: true,
      canPrepare: true,
      requiresApproval: false,
      reason: "Action can be prepared as a proposal."
    });
  }

  if (actionKind === "execute_action") {
    if (hasAny(matchingPermissions, ["execute_action"])) {
      return createDecision({
        decision: "execute_directly",
        allowed: true,
        canPrepare: false,
        requiresApproval: false,
        reason: "Execution permission is granted."
      });
    }

    if (hasAny(matchingPermissions, ["prepare_action"])) {
      return createDecision({
        decision: "prepare_only",
        allowed: false,
        canPrepare: true,
        requiresApproval: false,
        reason: "Only preparation is allowed; execution must not run."
      });
    }
  }

  return createDecision({
    decision: "denied",
    allowed: false,
    canPrepare: false,
    requiresApproval: false,
    reason: "No matching permission allows this action."
  });
}

export function canExecuteAction(policyDecision) {
  return policyDecision?.decision === "execute_directly" && policyDecision.allowed === true;
}

function hasAny(permissions, kinds) {
  return permissions.some((permission) => kinds.includes(permission.kind));
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

function createDecision({ decision, allowed, canPrepare, requiresApproval, reason }) {
  if (!ACTION_POLICY_DECISIONS.includes(decision)) {
    throw new PermissionModelError(`Unknown policy decision: ${decision}`);
  }

  return Object.freeze({
    decision,
    allowed,
    canPrepare,
    requiresApproval,
    reason
  });
}
