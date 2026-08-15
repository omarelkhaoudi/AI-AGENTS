export const AGENT_BUSINESS_CONFIG = Object.freeze({
  director: createAgentBusinessConfig({
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
  commercial: createAgentBusinessConfig({
    name: "Commercial",
    description: "Sales agent responsible for customer follow-ups and quote pipeline analysis.",
    mission: "Identify commercial priorities, quote follow-ups, and customer actions to prepare.",
    responsibilities: ["Review pending quotes", "Prioritize customer follow-ups", "Prepare commercial recommendations"],
    accessibleInformation: ["customers", "quotes", "orders", "commercial_pipeline"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action"],
    tools: ["get_pending_quotes"],
    sensitivity: "medium"
  }),
  finance: createAgentBusinessConfig({
    name: "Administration / Finance",
    description: "Administration and finance agent responsible for cash collection and finance signals.",
    mission: "Analyze receivables, payment priorities, and finance administration signals.",
    responsibilities: ["Review pending payments", "Identify collection priorities", "Prepare finance recommendations"],
    accessibleInformation: ["payments", "receivables", "invoices", "customers", "finance_overview"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action", "human_approval_required"],
    tools: ["get_company_overview", "get_pending_payments"],
    sensitivity: "high"
  }),
  production: createAgentBusinessConfig({
    name: "Production",
    description: "Production agent responsible for order delay risks and operational production signals.",
    mission: "Identify delayed or at-risk production orders and prepare operational recommendations.",
    responsibilities: ["Review production order risks", "Identify delay causes", "Prepare production priorities"],
    accessibleInformation: ["orders", "production", "production_orders", "delivery_risks", "capacity_signals"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action"],
    tools: ["get_delayed_production_orders"],
    sensitivity: "medium"
  }),
  purchasing: createAgentBusinessConfig({
    name: "Achats",
    description: "Purchasing agent responsible for procurement needs and supplier preparation.",
    mission: "Identify purchase needs and prepare procurement recommendations.",
    responsibilities: ["Review stock needs", "Identify procurement urgency", "Prepare purchasing actions"],
    accessibleInformation: ["purchase_needs", "suppliers", "orders", "supplier_items", "stock_signals"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action"],
    tools: ["get_purchase_needs"],
    sensitivity: "medium"
  }),
  hr: createAgentBusinessConfig({
    name: "Ressources Humaines",
    description: "Human resources agent responsible for HR administration signals and workforce follow-up.",
    mission: "Analyze HR administration, workforce needs, absences, contracts, incidents, and staffing signals without exposing real personal data.",
    responsibilities: [
      "Review employees",
      "Review attendance",
      "Review absences",
      "Review leave requests",
      "Review documents",
      "Review contracts",
      "Review recruitments",
      "Review administrative follow-up",
      "Review tasks",
      "Review incidents",
      "Review evaluations",
      "Review staffing needs"
    ],
    accessibleInformation: [
      "hr_demo_overview",
      "employee_status_demo",
      "attendance_demo",
      "absence_demo",
      "leave_demo",
      "hr_documents_demo",
      "hr_contracts_demo",
      "recruitment_demo",
      "hr_tasks_demo",
      "hr_incidents_demo",
      "evaluations_demo",
      "staffing_needs_demo"
    ],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action", "human_approval_required"],
    businessRules: [
      {
        id: "hr-sensitive-action-approval-draft",
        description: "Draft rule: HR sensitive actions must be prepared only and require human approval before execution.",
        trigger: "hr_sensitive_action_requested",
        condition: "actionKind is execute_action or human_approval_required",
        action: "create_human_approval_request",
        requiresApproval: true
      }
    ],
    procedures: [
      {
        id: "hr-admin-review-draft",
        name: "Draft HR administrative review",
        description: "Draft structure for reviewing HR demo signals before recommending actions.",
        steps: ["Collect demo HR signals", "Classify priority", "Prepare recommendation for Director"],
        requiresApproval: false
      }
    ],
    promptInstructions: [
      "Use only demo HR data returned by authorized tools.",
      "Never expose real personal data or credentials.",
      "Prepare sensitive HR actions for human approval instead of executing them."
    ],
    tools: ["get_hr_overview"],
    sensitivity: "high"
  }),
  after_sales: createAgentBusinessConfig({
    name: "SAV / Qualite",
    description: "After-sales and quality agent responsible for support issues and quality signals.",
    mission: "Identify urgent after-sales, support, and quality issues for the leader.",
    responsibilities: ["Review support issues", "Identify quality risks", "Prepare after-sales priorities"],
    accessibleInformation: ["after_sales_tickets", "customers", "orders", "support_cases", "quality_issues", "customer_claims"],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action"],
    tools: ["get_after_sales_overview"],
    sensitivity: "medium"
  }),
  marketing: createAgentBusinessConfig({
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
  community_manager: createAgentBusinessConfig({
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
  legal: createAgentBusinessConfig({
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

export function createAgentBusinessConfig({
  name,
  description,
  mission,
  responsibilities = [],
  accessibleInformation = [],
  authorizedActions = [],
  approvalRequiredActions = [],
  businessRules = [],
  procedures = [],
  promptInstructions = [],
  tools = [],
  sensitivity = "medium"
} = {}) {
  return Object.freeze({
    name,
    description,
    mission,
    responsibilities: Object.freeze([...responsibilities]),
    accessibleInformation: Object.freeze([...accessibleInformation]),
    authorizedActions: Object.freeze([...authorizedActions]),
    approvalRequiredActions: Object.freeze([...approvalRequiredActions]),
    businessRules: Object.freeze(businessRules.map((rule) => Object.freeze({ ...rule }))),
    procedures: Object.freeze(procedures.map((procedure) => Object.freeze({
      ...procedure,
      steps: Object.freeze([...(procedure.steps ?? [])])
    }))),
    promptInstructions: Object.freeze([...promptInstructions]),
    tools: Object.freeze([...tools]),
    sensitivity
  });
}

export function getAgentBusinessConfig(agentId) {
  return AGENT_BUSINESS_CONFIG[agentId] ?? null;
}

export function listAgentBusinessConfigs() {
  return Object.entries(AGENT_BUSINESS_CONFIG).map(([agentId, config]) => Object.freeze({
    agentId,
    config
  }));
}

export function createAgentBusinessMetadata(agentId) {
  const config = getAgentBusinessConfig(agentId);
  if (!config) {
    return null;
  }

  return Object.freeze({
    mission: config.mission,
    responsibilities: config.responsibilities,
    accessibleInformation: config.accessibleInformation,
    authorizedActions: config.authorizedActions,
    approvalRequiredActions: config.approvalRequiredActions,
    businessRules: config.businessRules,
    procedures: config.procedures,
    promptInstructions: config.promptInstructions,
    sensitivity: config.sensitivity
  });
}

export function validateAgentBusinessConfig(agentId, config = getAgentBusinessConfig(agentId)) {
  const errors = [];
  if (!agentId || typeof agentId !== "string") {
    errors.push("agentId must be a non-empty string");
  }
  requireText(config?.name, "name", errors);
  requireText(config?.description, "description", errors);
  requireText(config?.mission, "mission", errors);
  requireNonEmptyArray(config?.responsibilities, "responsibilities", errors);
  requireNonEmptyArray(config?.accessibleInformation, "accessibleInformation", errors);
  requireNonEmptyArray(config?.authorizedActions, "authorizedActions", errors);
  requireNonEmptyArray(config?.approvalRequiredActions, "approvalRequiredActions", errors);
  requireNonEmptyArray(config?.tools, "tools", errors);
  requireText(config?.sensitivity, "sensitivity", errors);
  validateBusinessRules(config?.businessRules ?? [], errors);
  validateProcedures(config?.procedures ?? [], errors);
  if (!Array.isArray(config?.promptInstructions)) {
    errors.push("promptInstructions must be an array");
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors
  });
}

function validateBusinessRules(rules, errors) {
  if (!Array.isArray(rules)) {
    errors.push("businessRules must be an array");
    return;
  }
  for (const [index, rule] of rules.entries()) {
    requireText(rule?.id, `businessRules[${index}].id`, errors);
    requireText(rule?.description, `businessRules[${index}].description`, errors);
    requireText(rule?.trigger, `businessRules[${index}].trigger`, errors);
    requireText(rule?.condition, `businessRules[${index}].condition`, errors);
    requireText(rule?.action, `businessRules[${index}].action`, errors);
    if (typeof rule?.requiresApproval !== "boolean") {
      errors.push(`businessRules[${index}].requiresApproval must be a boolean`);
    }
  }
}

function validateProcedures(procedures, errors) {
  if (!Array.isArray(procedures)) {
    errors.push("procedures must be an array");
    return;
  }
  for (const [index, procedure] of procedures.entries()) {
    requireText(procedure?.id, `procedures[${index}].id`, errors);
    requireText(procedure?.name, `procedures[${index}].name`, errors);
    requireText(procedure?.description, `procedures[${index}].description`, errors);
    requireNonEmptyArray(procedure?.steps, `procedures[${index}].steps`, errors);
    if (typeof procedure?.requiresApproval !== "boolean") {
      errors.push(`procedures[${index}].requiresApproval must be a boolean`);
    }
  }
}

function requireText(value, field, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`);
  }
}

function requireNonEmptyArray(value, field, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${field} must be a non-empty array`);
  }
}
