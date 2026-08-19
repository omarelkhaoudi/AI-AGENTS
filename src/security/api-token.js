import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Opaque bearer tokens. Only the SHA-256 hash is ever persisted, so a database
// dump never yields a usable credential.
export const API_TOKEN_PREFIX = "aia_";
export const API_TOKEN_BYTE_LENGTH = 32;
const TOKEN_HASH_LENGTH = 64;

export class ApiTokenError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ApiTokenError";
    this.code = code;
    this.details = details;
  }
}

export function generateApiTokenSecret() {
  return `${API_TOKEN_PREFIX}${randomBytes(API_TOKEN_BYTE_LENGTH).toString("base64url")}`;
}

export function hashApiTokenSecret(secret) {
  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new ApiTokenError("An API token secret must be a non-empty string.", "API_TOKEN_INVALID");
  }

  return createHash("sha256").update(secret, "utf8").digest("hex");
}

// Hashes are fixed length, so a constant-time comparison is always well defined.
export function apiTokenHashesMatch(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  if (left.length !== TOKEN_HASH_LENGTH || right.length !== TOKEN_HASH_LENGTH) {
    return false;
  }

  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function isApiTokenUsable(token, now = new Date()) {
  if (!token || typeof token !== "object") {
    return false;
  }
  if (token.revokedAt) {
    return false;
  }
  if (token.expiresAt && Date.parse(token.expiresAt) <= now.getTime()) {
    return false;
  }
  return true;
}

// The secret is returned once, to the caller that created it, and never stored.
export function createApiTokenMaterial({ userId, name = "api-token", expiresAt = null } = {}) {
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new ApiTokenError("An API token requires a userId.", "API_TOKEN_INVALID");
  }

  const secret = generateApiTokenSecret();
  return Object.freeze({
    secret,
    record: Object.freeze({
      userId,
      name,
      tokenHash: hashApiTokenSecret(secret),
      expiresAt
    })
  });
}
