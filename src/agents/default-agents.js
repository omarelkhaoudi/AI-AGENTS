import { createAgentDefinition, createContractSchema } from "./contract.js";
import { AgentRegistry } from "./registry.js";

export const MVP_AGENT_IDS = Object.freeze([
  "director",
  "commercial",
  "finance",
  "production",
  "purchasing"
]);

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

const DESCRIPTIONS = Object.freeze({
  director: "Central technical orchestrator placeholder.",
  commercial: "Commercial agent technical placeholder.",
  finance: "Finance and administration agent technical placeholder.",
  production: "Production agent technical placeholder.",
  purchasing: "Purchasing agent technical placeholder."
});

export function createMvpAgentDefinitions() {
  return MVP_AGENT_IDS.map((id) =>
    createAgentDefinition({
      id,
      name: toTitle(id),
      description: DESCRIPTIONS[id],
      capabilities: [],
      input: placeholderInput,
      output: placeholderOutput,
      tools: [],
      permissions: [],
      status: "available",
      metadata: {
        phase: "0",
        businessRulesConfirmed: false
      }
    })
  );
}

export function createDefaultAgentRegistry() {
  const registry = new AgentRegistry();
  for (const agent of createMvpAgentDefinitions()) {
    registry.register(agent);
  }
  return registry;
}

function toTitle(value) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
