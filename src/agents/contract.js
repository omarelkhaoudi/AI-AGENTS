export const AGENT_STATUSES = Object.freeze([
  "idle",
  "available",
  "executing",
  "disabled",
  "error"
]);

export const DEFAULT_AGENT_STATUS = "idle";

export class AgentContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "AgentContractError";
    this.details = details;
  }
}

export function createContractSchema({
  type = "object",
  description = "",
  required = [],
  properties = {}
} = {}) {
  return Object.freeze({
    type,
    description,
    required: [...required],
    properties: Object.freeze({ ...properties })
  });
}

export function createAgentDefinition({
  id,
  name,
  description,
  capabilities = [],
  input = createContractSchema(),
  output = createContractSchema(),
  tools = [],
  permissions = [],
  status = DEFAULT_AGENT_STATUS,
  metadata = {},
  execute
}) {
  const agent = {
    id,
    name,
    description,
    capabilities: [...capabilities],
    input,
    output,
    tools: [...tools],
    permissions: [...permissions],
    status,
    metadata: { ...metadata },
    execute
  };

  validateAgentDefinition(agent);
  return Object.freeze(agent);
}

export function validateAgentDefinition(agent) {
  const errors = [];

  if (!agent || typeof agent !== "object") {
    throw new AgentContractError("Agent definition must be an object.", [
      "agent must be a non-null object"
    ]);
  }

  requireNonEmptyString(agent.id, "id", errors);
  requireNonEmptyString(agent.name, "name", errors);
  requireNonEmptyString(agent.description, "description", errors);
  requireArray(agent.capabilities, "capabilities", errors);
  requireArray(agent.tools, "tools", errors);
  requireArray(agent.permissions, "permissions", errors);
  requireSchema(agent.input, "input", errors);
  requireSchema(agent.output, "output", errors);

  if (!AGENT_STATUSES.includes(agent.status)) {
    errors.push(`status must be one of: ${AGENT_STATUSES.join(", ")}`);
  }

  if (agent.metadata == null || typeof agent.metadata !== "object" || Array.isArray(agent.metadata)) {
    errors.push("metadata must be an object");
  }

  if (agent.execute !== undefined && typeof agent.execute !== "function") {
    errors.push("execute must be a function when provided");
  }

  if (errors.length > 0) {
    throw new AgentContractError("Invalid agent definition.", errors);
  }

  return true;
}

function requireNonEmptyString(value, field, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`);
  }
}

function requireArray(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
  }
}

function requireSchema(value, field, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${field} must be an object schema`);
    return;
  }

  if (typeof value.type !== "string" || value.type.trim().length === 0) {
    errors.push(`${field}.type must be a non-empty string`);
  }

  if (!Array.isArray(value.required)) {
    errors.push(`${field}.required must be an array`);
  }

  if (!value.properties || typeof value.properties !== "object" || Array.isArray(value.properties)) {
    errors.push(`${field}.properties must be an object`);
  }
}
