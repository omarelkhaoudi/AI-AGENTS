import { PERMISSION_KINDS } from "../security/permissions.js";

export class ToolContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "ToolContractError";
    this.details = details;
  }
}

export function createToolDefinition({
  id,
  name,
  description,
  category,
  securityDomain = null,
  requiredPermission,
  allowedAgents = [],
  inputSchema = createToolInputSchema(),
  adapter = null,
  adapterRequired = false,
  execute
}) {
  const tool = {
    id,
    name,
    description,
    category,
    securityDomain,
    requiredPermission,
    allowedAgents: [...allowedAgents],
    inputSchema,
    adapter,
    adapterRequired: adapterRequired || adapter !== null,
    execute
  };

  validateToolDefinition(tool);
  return Object.freeze(tool);
}

export function createToolInputSchema({
  type = "object",
  required = [],
  properties = {}
} = {}) {
  return Object.freeze({
    type,
    required: [...required],
    properties: Object.freeze({ ...properties })
  });
}

export function validateToolDefinition(tool) {
  const errors = [];

  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    throw new ToolContractError("Tool definition must be an object.", [
      "tool must be a non-null object"
    ]);
  }

  requireText(tool.id, "id", errors);
  requireText(tool.name, "name", errors);
  requireText(tool.description, "description", errors);
  requireText(tool.category, "category", errors);

  if (!PERMISSION_KINDS.includes(tool.requiredPermission)) {
    errors.push(`requiredPermission must be one of: ${PERMISSION_KINDS.join(", ")}`);
  }

  if (!Array.isArray(tool.allowedAgents) || tool.allowedAgents.length === 0) {
    errors.push("allowedAgents must be a non-empty array");
  }

  if (tool.allowedAgents?.some((agentId) => typeof agentId !== "string" || agentId.trim() === "")) {
    errors.push("allowedAgents must contain non-empty strings");
  }

  if (tool.securityDomain !== null && (typeof tool.securityDomain !== "string" || tool.securityDomain.trim().length === 0)) {
    errors.push("securityDomain must be a non-empty string when provided");
  }

  validateInputSchema(tool.inputSchema, errors);

  if (tool.adapter !== null && tool.adapter !== undefined) {
    validateAdapterReference(tool, errors);
  }

  if (typeof tool.adapterRequired !== "boolean") {
    errors.push("adapterRequired must be a boolean");
  }

  if (typeof tool.execute !== "function" && !tool.adapter && tool.adapterRequired !== true) {
    errors.push("execute must be a function when no adapter is configured");
  }

  if (errors.length > 0) {
    throw new ToolContractError("Invalid tool definition.", errors);
  }

  return true;
}

export function validateToolInput(inputSchema, input) {
  if (!inputSchema || inputSchema.type !== "object") {
    throw new ToolContractError("Only object input schemas are supported.");
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolContractError("Tool input must be an object.");
  }

  for (const field of inputSchema.required) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      throw new ToolContractError(`Tool input is missing required field: ${field}`);
    }
  }

  for (const [field, definition] of Object.entries(inputSchema.properties)) {
    if (input[field] !== undefined && definition?.type && !matchesType(input[field], definition.type)) {
      throw new ToolContractError(`Tool input field has invalid type: ${field}`);
    }
  }

  return true;
}

function validateAdapterReference(tool, errors) {
  if (!tool.adapter || typeof tool.adapter !== "object" || Array.isArray(tool.adapter)) {
    errors.push("adapter must be an object when provided");
    return;
  }

  if (tool.adapter.toolId !== tool.id) {
    errors.push("adapter.toolId must match tool id");
  }

  if (typeof tool.adapter.execute !== "function") {
    errors.push("adapter.execute must be a function");
  }

  if (typeof tool.adapter.validateInput !== "function") {
    errors.push("adapter.validateInput must be a function");
  }
}

function validateInputSchema(schema, errors) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    errors.push("inputSchema must be an object");
    return;
  }

  if (schema.type !== "object") {
    errors.push("inputSchema.type must be object");
  }

  if (!Array.isArray(schema.required)) {
    errors.push("inputSchema.required must be an array");
  }

  if (!schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) {
    errors.push("inputSchema.properties must be an object");
  }
}

function requireText(value, field, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`);
  }
}

function matchesType(value, type) {
  if (type === "array") {
    return Array.isArray(value);
  }
  if (type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  return typeof value === type;
}
