import { AGENT_BUSINESS_CONFIG, createAgentBusinessMetadata } from "./business-config.js";
import { createAgentDefinition, createContractSchema } from "./contract.js";
import { AgentRegistry } from "./registry.js";

export const MVP_AGENT_IDS = Object.freeze([
  "director",
  "commercial",
  "finance",
  "production",
  "purchasing",
  "hr",
  "after_sales",
  "marketing",
  "community_manager",
  "legal"
]);

export const MVP_AGENT_SUPERVISORS = Object.freeze({
  director: null,
  commercial: "director",
  finance: "director",
  production: "director",
  purchasing: "director",
  hr: "director",
  after_sales: "director",
  marketing: "director",
  community_manager: "marketing",
  legal: "director"
});

export const MVP_AGENT_SUPERVISED_AGENTS = Object.freeze({
  director: Object.freeze(["commercial", "finance", "production", "purchasing", "hr", "after_sales", "marketing", "legal"]),
  marketing: Object.freeze(["community_manager"])
});

const placeholderInput = createContractSchema({
  description: "Technical request envelope. Business fields require client confirmation.",
  properties: {
    requestId: { type: "string" },
    payload: { type: "object" }
  }
});

const placeholderOutput = createContractSchema({
  description: "Technical response envelope. Business outputs require client confirmation.",
  properties: {
    requestId: { type: "string" },
    result: { type: "object" }
  }
});

export const MVP_AGENT_PROFILES = AGENT_BUSINESS_CONFIG;

export function createMvpAgentDefinitions() {
  return MVP_AGENT_IDS.map((id) => {
    const businessMetadata = createAgentBusinessMetadata(id);
    return createAgentDefinition({
      id,
      name: MVP_AGENT_PROFILES[id].name,
      description: MVP_AGENT_PROFILES[id].description,
      capabilities: [...MVP_AGENT_PROFILES[id].responsibilities],
      input: placeholderInput,
      output: placeholderOutput,
      tools: MVP_AGENT_PROFILES[id].tools,
      permissions: [],
      status: "available",
      metadata: {
        phase: "0",
        businessRulesConfirmed: false,
        ...businessMetadata,
        supervisorAgentId: MVP_AGENT_SUPERVISORS[id],
        supervisedAgentIds: MVP_AGENT_SUPERVISED_AGENTS[id] ? [...MVP_AGENT_SUPERVISED_AGENTS[id]] : [],
      }
    });
  });
}

export function createMvpAgentHierarchy() {
  return Object.freeze(
    MVP_AGENT_IDS.map((id) => Object.freeze({
      agentId: id,
      supervisorAgentId: MVP_AGENT_SUPERVISORS[id],
      supervisedAgentIds: MVP_AGENT_SUPERVISED_AGENTS[id] ? [...MVP_AGENT_SUPERVISED_AGENTS[id]] : []
    }))
  );
}

export function createDefaultAgentRegistry() {
  const registry = new AgentRegistry();
  for (const agent of createMvpAgentDefinitions()) {
    registry.register(agent);
  }
  return registry;
}
