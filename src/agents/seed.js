import { createMvpAgentDefinitions } from "./default-agents.js";
import { createPermission } from "../security/permissions.js";

const AGENT_ROLES = Object.freeze({
  director: "orchestrator",
  commercial: "specialized_agent",
  finance: "specialized_agent",
  production: "specialized_agent",
  purchasing: "specialized_agent"
});

export function createMvpAgentSeedRecords() {
  return createMvpAgentDefinitions().map((agent) => ({
    ...agent,
    role: AGENT_ROLES[agent.id],
    status: "available",
    permissions: [
      createPermission({
        kind: "read_analyze",
        resource: "request:*",
        scope: "mvp_orchestration"
      })
    ],
    metadata: {
      ...agent.metadata,
      phase: "1",
      seeded: true,
      active: true
    }
  }));
}

export async function seedMvpAgents(repository) {
  const seeded = [];
  for (const agent of createMvpAgentSeedRecords()) {
    seeded.push(await repository.upsertAgent(agent));
  }
  return Object.freeze(seeded);
}
