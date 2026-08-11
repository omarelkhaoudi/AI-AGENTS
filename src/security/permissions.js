export const PERMISSION_KINDS = Object.freeze([
  "read_analyze",
  "prepare_action",
  "execute_action",
  "human_approval_required"
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
