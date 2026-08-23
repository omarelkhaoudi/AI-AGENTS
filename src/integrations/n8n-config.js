import { WorkflowBoundaryError } from "./workflow-boundary.js";

// A leader-facing workflow call is a notification, not a batch job. Five seconds
// is generous for a webhook that acknowledges immediately, and short enough that
// an unreachable n8n does not hold an orchestration step open.
export const DEFAULT_N8N_TIMEOUT_MS = 5000;

// What n8n needs beyond the workflow boundary itself: where the webhook lives,
// which header carries the token, and how long a call may take. The base URL is
// deliberately not here: WORKFLOW_BASE_URL already holds it, and two variables
// meaning the same thing is one variable too many.
//
// The token value is read but never returned. This object reaches logs and error
// payloads, and redact() masks by key name: the safest key is one that is never
// there at all.
export function createN8nConfig(env = process.env, { enabled = false } = {}) {
  const timeoutMs = normalizeTimeout(env.N8N_TIMEOUT_MS);
  const webhookPath = normalizeText(env.N8N_WEBHOOK_PATH);
  const apiKeyHeader = normalizeText(env.N8N_API_KEY_HEADER);
  const apiKey = normalizeText(env.N8N_API_KEY);

  // Nothing is required while n8n is off: the defaults must let the application
  // start without anyone configuring a workflow they do not use.
  if (enabled === true) {
    requireSetting(webhookPath, "N8N_WEBHOOK_PATH");
    requireSetting(apiKeyHeader, "N8N_API_KEY_HEADER");
    requireSetting(apiKey, "N8N_API_KEY");
  }

  return Object.freeze({
    enabled: enabled === true,
    webhookPath,
    apiKeyHeader,
    hasApiKey: apiKey !== null,
    timeoutMs
  });
}

function requireSetting(value, name) {
  if (value === null) {
    throw new WorkflowBoundaryError(
      `${name} is required when the n8n workflow boundary is enabled.`,
      "N8N_SETTING_REQUIRED",
      { setting: name }
    );
  }
}

function normalizeText(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value.trim();
}

// A timeout that is absent falls back to the default. A timeout that is present
// but meaningless is a configuration mistake, and silently replacing it would
// hide the very thing the operator got wrong.
function normalizeTimeout(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return DEFAULT_N8N_TIMEOUT_MS;
  }

  const timeoutMs = Number(value);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new WorkflowBoundaryError(
      "N8N_TIMEOUT_MS must be a positive integer number of milliseconds.",
      "N8N_TIMEOUT_INVALID",
      { timeoutMs: value }
    );
  }

  return timeoutMs;
}
