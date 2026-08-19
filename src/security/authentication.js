import { apiTokenHashesMatch, hashApiTokenSecret, isApiTokenUsable } from "./api-token.js";
import { normalizeUserRole } from "./authorization.js";

export const BEARER_SCHEME = "Bearer";
export const ACTIVE_USER_STATUS = "active";

export class AuthenticationError extends Error {
  constructor(message, code = "AUTHENTICATION_REQUIRED", details = {}) {
    super(message);
    this.name = "AuthenticationError";
    this.code = code;
    this.details = details;
  }
}

export function extractBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== "string" || authorizationHeader.trim().length === 0) {
    throw new AuthenticationError("An Authorization bearer token is required.", "AUTHENTICATION_REQUIRED");
  }

  const [scheme, ...rest] = authorizationHeader.trim().split(/\s+/);
  const secret = rest.join("");
  if (scheme !== BEARER_SCHEME || secret.length === 0) {
    throw new AuthenticationError("Authorization must use the Bearer scheme.", "AUTHENTICATION_REQUIRED");
  }

  return secret;
}

// Resolves the caller identity. Every failure raises the same generic message so
// the endpoint never discloses whether a token exists, is expired, or is revoked.
export async function authenticatePrincipal({ repository, authorizationHeader } = {}) {
  if (!repository) {
    throw new AuthenticationError("Authentication requires a repository.", "AUTHENTICATION_UNAVAILABLE");
  }

  const secret = extractBearerToken(authorizationHeader);
  const presentedHash = hashApiTokenSecret(secret);
  const token = await repository.findApiTokenByHash(presentedHash);

  if (!token || !apiTokenHashesMatch(token.tokenHash, presentedHash) || !isApiTokenUsable(token)) {
    throw new AuthenticationError("Invalid API token.", "INVALID_CREDENTIALS");
  }

  const user = await repository.getUser(token.userId);
  if (!user) {
    throw new AuthenticationError("Invalid API token.", "INVALID_CREDENTIALS");
  }

  if ((user.status ?? ACTIVE_USER_STATUS) !== ACTIVE_USER_STATUS) {
    throw new AuthenticationError("Invalid API token.", "INVALID_CREDENTIALS");
  }

  return createPrincipal({ user, tokenId: token.id });
}

export function createPrincipal({ user, tokenId = null }) {
  return Object.freeze({
    userId: user.id,
    name: user.name ?? null,
    email: user.email ?? null,
    role: normalizeUserRole(user.role),
    tokenId
  });
}
