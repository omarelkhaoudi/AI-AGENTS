import { AUTH_MODES, SecurityConfigurationError } from "./security-errors.js";

export const DEFAULT_BODY_LIMIT_BYTES = 65536;

// Deliberately conservative: a leader-facing cockpit issues a handful of
// requests per minute, and an approval decision is a rare, high-value action.
export const DEFAULT_RATE_LIMITS = Object.freeze({
  read: Object.freeze({ max: 240, timeWindow: 60000 }),
  write: Object.freeze({ max: 60, timeWindow: 60000 }),
  decision: Object.freeze({ max: 20, timeWindow: 60000 })
});

export function createSecurityConfig(env = process.env) {
  const environment = env.NODE_ENV ?? "development";
  const authMode = normalizeAuthMode(env.AUTH_MODE);

  // Demo mode hands out a real token automatically. That convenience must never
  // be reachable in production, whatever the deployment sets.
  if (authMode === "demo" && environment === "production") {
    throw new SecurityConfigurationError(
      "AUTH_MODE=demo is refused when NODE_ENV=production.",
      { authMode, environment }
    );
  }

  return Object.freeze({
    environment,
    authMode,
    demoModeEnabled: authMode === "demo",
    bodyLimitBytes: normalizePositiveInteger(env.API_BODY_LIMIT_BYTES, DEFAULT_BODY_LIMIT_BYTES),
    rateLimits: Object.freeze({
      read: normalizeRateLimit(env.RATE_LIMIT_READ_MAX, DEFAULT_RATE_LIMITS.read),
      write: normalizeRateLimit(env.RATE_LIMIT_WRITE_MAX, DEFAULT_RATE_LIMITS.write),
      decision: normalizeRateLimit(env.RATE_LIMIT_DECISION_MAX, DEFAULT_RATE_LIMITS.decision)
    })
  });
}

function normalizeAuthMode(authMode = "token") {
  const normalized = authMode || "token";
  if (!AUTH_MODES.includes(normalized)) {
    throw new SecurityConfigurationError(`Unsupported AUTH_MODE: ${authMode}`, {
      authMode,
      supportedModes: AUTH_MODES
    });
  }
  return normalized;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeRateLimit(maxValue, fallback) {
  return Object.freeze({
    max: normalizePositiveInteger(maxValue, fallback.max),
    timeWindow: fallback.timeWindow
  });
}
