import { WorkflowBoundaryError } from "./workflow-boundary.js";

// How much of a failing response is worth keeping. Enough to recognise what n8n
// complained about, short enough that an unexpected payload cannot flood the
// audit trail.
export const N8N_ERROR_BODY_LIMIT = 200;

// The HTTP client for the n8n workflow boundary. It builds the request, applies
// the timeout, and turns every failure into a WorkflowBoundaryError: a timeout,
// a refused connection and an unexpected status are all failures of the same
// boundary. The adapter layer will raise ToolAdapterError later, on top of this.
//
// The token is held in a closure, never as a property: the returned client can
// be logged or serialised without carrying a secret.
export function createN8nClient({
  baseUrl,
  webhookPath,
  apiKeyHeader,
  apiKey,
  timeoutMs,
  fetchImpl = globalThis.fetch
} = {}) {
  requireText(baseUrl, "baseUrl");
  requireText(webhookPath, "webhookPath");
  requireText(apiKeyHeader, "apiKeyHeader");
  requireText(apiKey, "apiKey");

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new WorkflowBoundaryError(
      "timeoutMs must be a positive integer number of milliseconds.",
      "N8N_CLIENT_MISCONFIGURED",
      { setting: "timeoutMs" }
    );
  }

  if (typeof fetchImpl !== "function") {
    throw new WorkflowBoundaryError("fetchImpl must be a function.", "N8N_CLIENT_MISCONFIGURED", {
      setting: "fetchImpl"
    });
  }

  const url = joinUrl(baseUrl, webhookPath);
  // Computed once, from the same url every error will report. WORKFLOW_BASE_URL
  // is a free-form variable and may carry credentials; they must never reach an
  // audit trail.
  const safeUrl = sanitizeUrl(url);

  async function postWorkflowEvent(event) {
    const startedAt = Date.now();
    let response;

    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [apiKeyHeader]: apiKey
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (cause) {
      // AbortSignal.timeout rejects with a TimeoutError; anything else from
      // fetch is a network failure. The raw message is dropped: it is free text
      // and can name hosts or credentials.
      const timedOut = cause?.name === "TimeoutError";
      throw new WorkflowBoundaryError(
        timedOut ? "The n8n webhook did not answer in time." : "The n8n webhook could not be reached.",
        timedOut ? "N8N_REQUEST_TIMEOUT" : "N8N_REQUEST_FAILED",
        { url: safeUrl, timeoutMs, durationMs: Date.now() - startedAt }
      );
    }

    const durationMs = Date.now() - startedAt;
    const text = await readBody(response);

    if (!response.ok) {
      throw new WorkflowBoundaryError("The n8n webhook answered with an unexpected status.", "N8N_UNEXPECTED_STATUS", {
        url: safeUrl,
        httpStatus: response.status,
        durationMs,
        // Redacted before truncation: a response that echoes the token back
        // must not put it in the audit trail.
        body: truncate(redactSecret(text, apiKey), N8N_ERROR_BODY_LIMIT)
      });
    }

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new WorkflowBoundaryError("The n8n webhook answered with a body that is not JSON.", "N8N_INVALID_RESPONSE", {
        url: safeUrl,
        httpStatus: response.status,
        durationMs,
        body: truncate(redactSecret(text, apiKey), N8N_ERROR_BODY_LIMIT)
      });
    }

    return Object.freeze({ httpStatus: response.status, body, durationMs });
  }

  return Object.freeze({ postWorkflowEvent });
}

function requireText(value, setting) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkflowBoundaryError(`${setting} is required to build the n8n client.`, "N8N_CLIENT_MISCONFIGURED", {
      setting
    });
  }
}

function joinUrl(baseUrl, webhookPath) {
  return `${baseUrl.replace(/\/+$/, "")}/${webhookPath.replace(/^\/+/, "")}`;
}

// Origin and path only. A base URL of the form https://user:secret@host would
// otherwise put its credentials into every error it causes.
function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function truncate(text, limit) {
  if (typeof text !== "string") {
    return null;
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function redactSecret(text, secret) {
  if (typeof text !== "string" || typeof secret !== "string" || secret === "") {
    return text;
  }
  return text.split(secret).join("[REDACTED]");
}

async function readBody(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
