// User-facing roles, ordered from least to most privileged. Agent permissions are
// a separate model (see permissions.js): this file only governs human callers.
export const USER_ROLES = Object.freeze(["viewer", "operator", "approver", "leader"]);

export const API_CAPABILITIES = Object.freeze([
  "read_requests",
  "create_requests",
  "decide_approvals",
  "manage_api_tokens"
]);

const ROLE_RANK = Object.freeze({
  viewer: 0,
  operator: 1,
  approver: 2,
  leader: 3
});

const MINIMUM_ROLE_BY_CAPABILITY = Object.freeze({
  read_requests: "viewer",
  create_requests: "operator",
  decide_approvals: "approver",
  manage_api_tokens: "leader"
});

export class AuthorizationError extends Error {
  constructor(message, code = "AUTHORIZATION_DENIED", details = {}) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
    this.details = details;
  }
}

export function normalizeUserRole(role) {
  if (typeof role !== "string" || !USER_ROLES.includes(role)) {
    // An unknown role must never be more privileged than the weakest known role.
    return "viewer";
  }
  return role;
}

export function roleSatisfiesCapability(role, capability) {
  if (!API_CAPABILITIES.includes(capability)) {
    return false;
  }

  return ROLE_RANK[normalizeUserRole(role)] >= ROLE_RANK[MINIMUM_ROLE_BY_CAPABILITY[capability]];
}

export function minimumRoleForCapability(capability) {
  return MINIMUM_ROLE_BY_CAPABILITY[capability] ?? null;
}

export function assertCapability(principal, capability) {
  if (!API_CAPABILITIES.includes(capability)) {
    throw new AuthorizationError(`Unknown capability: ${capability}`, "AUTHORIZATION_MISCONFIGURED", { capability });
  }

  if (!principal || typeof principal.userId !== "string") {
    throw new AuthorizationError("An authenticated principal is required.", "AUTHORIZATION_DENIED", { capability });
  }

  if (!roleSatisfiesCapability(principal.role, capability)) {
    throw new AuthorizationError(
      `Role ${normalizeUserRole(principal.role)} cannot ${capability}.`,
      "AUTHORIZATION_DENIED",
      { capability, role: normalizeUserRole(principal.role), minimumRole: MINIMUM_ROLE_BY_CAPABILITY[capability] }
    );
  }

  return true;
}
