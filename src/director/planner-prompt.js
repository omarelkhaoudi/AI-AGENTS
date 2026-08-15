import { redact } from "../observability/logger.js";

export const DEFAULT_PLANNER_SECURITY_CONSTRAINTS = Object.freeze([
  "The planner must only produce a structured plan.",
  "The planner must never execute a tool.",
  "The planner must never bypass permissions or human approvals.",
  "Use only listed agent ids.",
  "Use only listed tool names.",
  "Set requiresApproval=true for sensitive actions.",
  "Do not include secrets, API keys, credentials, tokens, or passwords."
]);

export function buildPlannerPrompt({
  request,
  agents = [],
  tools = [],
  securityConstraints = DEFAULT_PLANNER_SECURITY_CONSTRAINTS
} = {}) {
  const safeRequest = redact({
    id: request?.id ?? request?.requestId,
    title: request?.title ?? null,
    payload: request?.payload ?? {}
  });
  const outputContract = {
    version: "1",
    requestId: "string",
    intent: "string",
    summary: "string",
    planner: "string",
    agents: ["agentId"],
    steps: [
      {
        id: "string",
        agentId: "string",
        sequence: "positive integer",
        actionType: "string",
        actionKind: "read_analyze | prepare_action | execute_action | human_approval_required",
        toolName: "string",
        resource: "request:<requestId>",
        reason: "string",
        input: { requestId: "string" },
        requiresApproval: "boolean"
      }
    ]
  };

  return Object.freeze({
    system: [
      "You are a planning component for an enterprise AI agent operating system.",
      "Return only valid JSON matching the provided planner contract.",
      "Use version 1, the provided request id, stable unique step ids, and only known agents/tools.",
      "Do not execute tools, call APIs, request secrets, invent tools, or produce prose outside JSON."
    ].join(" "),
    user: JSON.stringify({
      request: safeRequest,
      availableAgents: agents.map(summarizeAgent),
      availableTools: tools.map(summarizeTool),
      securityConstraints,
      outputContract
    })
  });
}

function summarizeAgent(agent) {
  return redact({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    description: agent.description,
    status: agent.status,
    permissions: agent.permissions,
    capabilities: agent.capabilities,
    mission: agent.metadata?.mission,
    responsibilities: agent.metadata?.responsibilities,
    accessibleInformation: agent.metadata?.accessibleInformation,
    authorizedActions: agent.metadata?.authorizedActions,
    approvalRequiredActions: agent.metadata?.approvalRequiredActions,
    businessRules: agent.metadata?.businessRules,
    procedures: agent.metadata?.procedures,
    promptInstructions: agent.metadata?.promptInstructions,
    supervisorAgentId: agent.metadata?.supervisorAgentId,
    supervisedAgentIds: agent.metadata?.supervisedAgentIds,
    sensitivity: agent.metadata?.sensitivity
  });
}

function summarizeTool(tool) {
  return redact({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    category: tool.category,
    requiredPermission: tool.requiredPermission,
    allowedAgents: tool.allowedAgents,
    inputSchema: tool.inputSchema
  });
}
