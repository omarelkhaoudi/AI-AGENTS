import { validateAgentDefinition } from "./contract.js";

export class AgentRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentRegistryError";
  }
}

export class AgentRegistry {
  #agents = new Map();

  register(agent) {
    validateAgentDefinition(agent);

    if (this.#agents.has(agent.id)) {
      throw new AgentRegistryError(`Agent already registered: ${agent.id}`);
    }

    this.#agents.set(agent.id, agent);
    return agent;
  }

  get(agentId) {
    return this.#agents.get(agentId);
  }

  require(agentId) {
    const agent = this.get(agentId);
    if (!agent) {
      throw new AgentRegistryError(`Agent is not registered: ${agentId}`);
    }
    return agent;
  }

  list() {
    return [...this.#agents.values()];
  }

  has(agentId) {
    return this.#agents.has(agentId);
  }
}
