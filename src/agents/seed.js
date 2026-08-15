import { createMvpAgentDefinitions } from "./default-agents.js";
import { createPermission } from "../security/permissions.js";

const AGENT_ROLES = Object.freeze({
  director: "orchestrator",
  commercial: "specialized_agent",
  finance: "specialized_agent",
  production: "specialized_agent",
  purchasing: "specialized_agent",
  hr: "specialized_agent",
  after_sales: "specialized_agent",
  marketing: "specialized_agent",
  community_manager: "specialized_agent",
  legal: "specialized_agent"
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
      }),
      ...(agent.id === "finance"
        ? [
            createPermission({
              kind: "prepare_action",
              resource: "request:*",
              scope: "mvp_sensitive_action_preparation"
            })
          ]
        : [])
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
    const existing = await repository.getAgent(agent.id);
    seeded.push(await repository.upsertAgent({
      ...agent,
      permissions: existing?.permissions?.length ? existing.permissions : agent.permissions
    }));
  }
  return Object.freeze(seeded);
}
