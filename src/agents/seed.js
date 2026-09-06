import { createMvpAgentDefinitions } from "./default-agents.js";
import { createPermission } from "../security/permissions.js";
import { agentSecurityDomains, domainResource } from "../security/tool-domains.js";

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

// Agents allowed to prepare a sensitive action for human approval. Every other
// agent is read/analyze only: it can never bring a sensitive action into being.
// production joins the list for notify_delay_alert. What this actually grants
// is prepare_action on request:*, which is what lets evaluateActionPolicy return
// prepare_only instead of denied, so the call reaches the approval mechanism
// rather than being refused before an approval can exist. The domain scoped
// prepare_action rows it also produces grant nothing new: the domain check is
// kind agnostic and read_analyze already covers those same domains.
//
// commercial joins it for prepare_quote_from_datasheet. CDC section 4 gives
// that agent the preparation of quotes, and without this the tool was refused
// before an approval could exist: the call answered PERMISSION_DENIED, so the
// human decision the tool exists to ask for was never asked. No domain is
// added, for the reason stated just above.
export const SENSITIVE_PREPARATION_AGENT_IDS = Object.freeze([
  "finance",
  "hr",
  "legal",
  "production",
  "commercial"
]);

// Minimum necessary access: the request scope lets an agent take part in an
// orchestration, and the domain scopes bound it to its own business perimeter.
export function createMvpAgentPermissions(agentId) {
  const domains = agentSecurityDomains(agentId);
  return [
    createPermission({
      kind: "read_analyze",
      resource: "request:*",
      scope: "mvp_orchestration"
    }),
    ...domains.map((domain) => createPermission({
      kind: "read_analyze",
      resource: domainResource(domain),
      scope: "mvp_business_domain"
    })),
    ...(SENSITIVE_PREPARATION_AGENT_IDS.includes(agentId)
      ? [
          createPermission({
            kind: "prepare_action",
            resource: "request:*",
            scope: "mvp_sensitive_action_preparation"
          }),
          ...domains.map((domain) => createPermission({
            kind: "prepare_action",
            resource: domainResource(domain),
            scope: "mvp_sensitive_action_preparation"
          }))
        ]
      : [])
  ];
}

export function createMvpAgentSeedRecords() {
  return createMvpAgentDefinitions().map((agent) => ({
    ...agent,
    role: AGENT_ROLES[agent.id],
    status: "available",
    permissions: createMvpAgentPermissions(agent.id),
    metadata: {
      ...agent.metadata,
      phase: "1",
      seeded: true,
      active: true
    }
  }));
}

// The seed used to keep whatever permissions a stored agent already had, which
// meant an agent seeded before a lot never received the permissions that lot
// introduced. PostgreSQL therefore held pre-Lot-1 permissions while the code had
// moved on, and the Director could execute only the first step of its plan.
//
// createMvpAgentPermissions is the source of truth for the least privilege
// model, frozen by security-no-permission-drift. Anything else stored on an
// agent row is drift, not customisation, so the seed restores it.
export async function seedMvpAgents(repository) {
  const seeded = [];
  for (const agent of createMvpAgentSeedRecords()) {
    seeded.push(await repository.upsertAgent(agent));
  }
  return Object.freeze(seeded);
}
