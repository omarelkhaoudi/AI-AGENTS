import { redact } from "../../observability/logger.js";

export const TOOL_ADAPTER_KINDS = Object.freeze([
  "mock",
  "database",
  "api",
  "n8n"
]);

export class ToolAdapterError extends Error {
  constructor(message, code = "ADAPTER_FAILED", details = {}) {
    super(message);
    this.name = "ToolAdapterError";
    this.code = code;
    this.details = details;
  }
}

export function createToolAdapter({
  toolId,
  kind,
  validateInput,
  execute,
  getMetadata = () => ({})
} = {}) {
  const adapter = {
    toolId,
    kind,
    validateInput,
    execute,
    getMetadata
  };

  validateToolAdapter(adapter);
  return Object.freeze(adapter);
}

export function validateToolAdapter(adapter) {
  const errors = [];

  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter)) {
    throw new ToolAdapterError("Tool adapter must be an object.", "INVALID_ADAPTER");
  }

  requireText(adapter.toolId, "toolId", errors);

  if (!TOOL_ADAPTER_KINDS.includes(adapter.kind)) {
    errors.push(`kind must be one of: ${TOOL_ADAPTER_KINDS.join(", ")}`);
  }

  if (typeof adapter.validateInput !== "function") {
    errors.push("validateInput must be a function");
  }

  if (typeof adapter.execute !== "function") {
    errors.push("execute must be a function");
  }

  if (typeof adapter.getMetadata !== "function") {
    errors.push("getMetadata must be a function");
  }

  if (errors.length > 0) {
    throw new ToolAdapterError("Invalid tool adapter.", "INVALID_ADAPTER", { errors });
  }

  return true;
}

export async function executeToolAdapter(adapter, context, input) {
  validateToolAdapter(adapter);
  adapter.validateInput(input);
  const output = await adapter.execute(context, input);
  return normalizeAdapterResult(output);
}

export function getToolAdapterMetadata(adapter) {
  validateToolAdapter(adapter);
  const metadata = adapter.getMetadata();
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ToolAdapterError("Tool adapter metadata must be an object.", "INVALID_ADAPTER_METADATA", {
      toolId: adapter.toolId
    });
  }
  return redact(metadata);
}

function normalizeAdapterResult(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new ToolAdapterError("Tool adapter result must be an object.", "INVALID_ADAPTER_RESULT");
  }

  return Object.freeze({
    ...output
  });
}

function requireText(value, field, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`);
  }
}
