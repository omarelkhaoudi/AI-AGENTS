import { createAgentDefinition, createContractSchema } from "./contract.js";
import { AgentRegistry } from "./registry.js";

export const MVP_AGENT_IDS = Object.freeze([
  "director",
  "commercial",
  "finance",
  "production",
  "purchasing",
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
  after_sales: "director",
  marketing: "director",
  community_manager: "marketing",
  legal: "director"
});

export const MVP_AGENT_SUPERVISED_AGENTS = Object.freeze({
  director: Object.freeze(["commercial", "finance", "production", "purchasing", "after_sales", "marketing", "legal"]),
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

export const MVP_AGENT_PROFILES = Object.freeze({
  director: Object.freeze({
    name: "Director",
    description: "Central AI orchestrator coordinating specialized MVP agents.",
    mission: "Understand the leader request, create a safe plan, delegate to specialized agents, and consolidate results.",
    responsibilities: [
      "Plan multi-agent work",
      "Select specialized agents",
      "Keep execution behind ToolExecutionService",
      "Request human approval when required",
      "Produce consolidated recommendations"
    ],
    accessibleInformation: ["request_context", "agent_catalog", "tool_catalog", "execution_status"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action", "human_approval_required"],
    tools: ["get_company_overview"],
    sensitivity: "medium"
  }),
  commercial: Object.freeze({
    name: "Commercial",
    description: "Sales agent responsible for customer follow-ups and quote pipeline analysis.",
    mission: "Identify commercial priorities, quote follow-ups, and customer actions to prepare.",
    responsibilities: ["Review pending quotes", "Prioritize customer follow-ups", "Prepare commercial recommendations"],
    accessibleInformation: ["customers", "quotes", "commercial_pipeline"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action"],
    tools: ["get_pending_quotes"],
    sensitivity: "medium"
  }),
  finance: Object.freeze({
    name: "Administration / Finance",
    description: "Administration and finance agent responsible for cash collection and finance signals.",
    mission: "Analyze receivables, payment priorities, and finance administration signals.",
    responsibilities: ["Review pending payments", "Identify collection priorities", "Prepare finance recommendations"],
    accessibleInformation: ["receivables", "invoices", "finance_overview"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action", "human_approval_required"],
    tools: ["get_company_overview", "get_pending_payments"],
    sensitivity: "high"
  }),
  production: Object.freeze({
    name: "Production",
    description: "Production agent responsible for order delay risks and operational production signals.",
    mission: "Identify delayed or at-risk production orders and prepare operational recommendations.",
    responsibilities: ["Review production order risks", "Identify delay causes", "Prepare production priorities"],
    accessibleInformation: ["production_orders", "delivery_risks", "capacity_signals"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action"],
    tools: ["get_delayed_production_orders"],
    sensitivity: "medium"
  }),
  purchasing: Object.freeze({
    name: "Achats",
    description: "Purchasing agent responsible for procurement needs and supplier preparation.",
    mission: "Identify purchase needs and prepare procurement recommendations.",
    responsibilities: ["Review stock needs", "Identify procurement urgency", "Prepare purchasing actions"],
    accessibleInformation: ["purchase_needs", "supplier_items", "stock_signals"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action"],
    tools: ["get_purchase_needs"],
    sensitivity: "medium"
  }),
  after_sales: Object.freeze({
    name: "SAV / Qualite",
    description: "After-sales and quality agent responsible for support issues and quality signals.",
    mission: "Identify urgent after-sales, support, and quality issues for the leader.",
    responsibilities: ["Review support issues", "Identify quality risks", "Prepare after-sales priorities"],
    accessibleInformation: ["support_cases", "quality_issues", "customer_claims"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action"],
    tools: ["get_after_sales_overview"],
    sensitivity: "medium"
  }),
  marketing: Object.freeze({
    name: "Marketing",
    description: "Marketing agent responsible for campaign, content, and performance overview.",
    mission: "Analyze marketing priorities, campaign signals, content needs, and supervise community management work.",
    responsibilities: ["Review marketing performance", "Identify campaign priorities", "Prepare content recommendations"],
    accessibleInformation: ["campaigns", "content", "marketing_performance"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action"],
    tools: ["get_marketing_overview"],
    sensitivity: "medium"
  }),
  community_manager: Object.freeze({
    name: "Community Manager",
    description: "Community management agent reporting to Marketing and responsible for public content and editorial priorities.",
    mission: "Review community and editorial priorities for Marketing without accessing unrelated confidential data.",
    responsibilities: ["Review editorial calendar", "Prepare public response suggestions", "Identify urgent content actions"],
    accessibleInformation: ["public_content", "editorial_calendar", "community_signals"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action"],
    tools: ["get_community_overview"],
    sensitivity: "low"
  }),
  legal: Object.freeze({
    name: "Juridique",
    description: "Legal agent responsible for legal subjects, contracts, and compliance signals.",
    mission: "Identify legal priorities and documents requiring leader attention.",
    responsibilities: ["Review legal subjects", "Identify contract deadlines", "Prepare legal risk summaries"],
    accessibleInformation: ["contracts", "legal_documents", "compliance_signals"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action", "human_approval_required"],
    tools: ["get_legal_overview"],
    sensitivity: "high"
  })
});

export function createMvpAgentDefinitions() {
  return MVP_AGENT_IDS.map((id) =>
    createAgentDefinition({
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
        mission: MVP_AGENT_PROFILES[id].mission,
        responsibilities: MVP_AGENT_PROFILES[id].responsibilities,
        accessibleInformation: MVP_AGENT_PROFILES[id].accessibleInformation,
        authorizedActions: MVP_AGENT_PROFILES[id].authorizedActions,
        approvalRequiredActions: MVP_AGENT_PROFILES[id].approvalRequiredActions,
        supervisorAgentId: MVP_AGENT_SUPERVISORS[id],
        supervisedAgentIds: MVP_AGENT_SUPERVISED_AGENTS[id] ? [...MVP_AGENT_SUPERVISED_AGENTS[id]] : [],
        sensitivity: MVP_AGENT_PROFILES[id].sensitivity
      }
    })
  );
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
