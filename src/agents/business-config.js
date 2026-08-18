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
    mission: "Centralize post-delivery issues, quality claims, warranty follow-up, interventions, and customer satisfaction until closure preparation.",
    responsibilities: [
      "Review after-sales cases",
      "Review customer claims",
      "Review quality issues",
      "Track warranty status",
      "Track interventions",
      "Track appointments",
      "Identify responsible owners",
      "Review after-sales history",
      "Prepare resolution follow-up",
      "Review customer satisfaction"
    ],
    accessibleInformation: [
      "after_sales_tickets",
      "customers",
      "orders",
      "support_cases",
      "quality_issues",
      "customer_claims",
      "warranty_status",
      "intervention_schedule",
      "after_sales_history",
      "customer_satisfaction"
    ],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action"],
    tools: ["get_after_sales_overview"],
    sensitivity: "medium"
  }),
  marketing: createAgentBusinessConfig({
    name: "Marketing",
    description: "Marketing agent responsible for campaign, content, and performance overview.",
    mission: "Analyze marketing priorities, campaign signals, content needs, and supervise community management work.",
    responsibilities: [
      "Review marketing strategy signals",
      "Review active campaigns",
      "Review editorial calendar",
      "Identify content ideas",
      "Analyze marketing performance",
      "Prepare campaign recommendations",
      "Supervise Community Manager preparation"
    ],
    accessibleInformation: [
      "campaigns",
      "content",
      "marketing_performance",
      "marketing_strategy",
      "editorial_calendar",
      "campaign_objectives",
      "community_signals_supervised"
    ],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action"],
    tools: ["get_marketing_overview"],
    sensitivity: "medium"
  }),
  community_manager: createAgentBusinessConfig({
    name: "Community Manager",
    description: "Community management agent reporting to Marketing and responsible for public content and editorial priorities.",
    mission: "Review community and editorial priorities for Marketing without accessing unrelated confidential data.",
    responsibilities: [
      "Review publication calendar",
      "Prepare captions",
      "Prepare public response suggestions",
      "Review comments and messages",
      "Identify content opportunities",
      "Track engagement signals",
      "Escalate community issues to Marketing"
    ],
    accessibleInformation: [
      "public_content",
      "editorial_calendar",
      "community_signals",
      "publication_calendar",
      "captions",
      "comments",
      "messages",
      "engagement_demo"
    ],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action"],
    tools: ["get_community_overview"],
    sensitivity: "low"
  }),
  legal: createAgentBusinessConfig({
    name: "Juridique",
    description: "Legal agent responsible for legal subjects, contracts, and compliance signals.",
    mission: "Identify legal priorities, contract risks, clauses, deadlines, and documents requiring leader or lawyer validation.",
    responsibilities: [
      "Review contracts",
      "Review legal documents",
      "Review commercial terms",
      "Identify risky clauses",
      "Identify legal risks",
      "Prepare legal response drafts",
      "Track legal cases",
      "Prepare recommendations",
      "Escalate items requiring a lawyer or human validation"
    ],
    accessibleInformation: [
      "contracts",
      "legal_documents",
      "commercial_terms",
      "clauses",
      "legal_risks",
      "legal_cases",
      "contract_deadlines",
      "compliance_signals"
    ],
    authorizedActions: ["read_analyze", "prepare_action"],
    approvalRequiredActions: ["execute_action", "human_approval_required"],
    tools: ["get_legal_overview"],
    sensitivity: "high"
  })
});

export const SENSITIVE_BUSINESS_ACTIONS_REQUIRING_APPROVAL = Object.freeze([
  "execute_payment",
  "execute_invoice_payment",
  "execute_bank_transfer",
  "change_invoice_status",
  "apply_large_discount",
  "sign_document",
  "sign_or_send_legal_document",
  "approve_legal_contract",
  "engage_company_contractually",
  "modify_hr_record",
  "approve_leave",
  "change_contract",
  "decide_recruitment",
  "terminate_employee",
  "apply_hr_sanction",
  "change_hr_contract_sensitive",
  "commit_hr_sensitive_decision",
  "commit_hr_financial_obligation",
  "prepare_hr_sensitive_decision",
  "prepare_legal_sensitive_decision",
  "publish_content",
  "send_public_reply",
  "place_purchase_order",
  "change_production_schedule",
  "commit_customer_resolution",
  "commit_legal_position"
]);

export const AGENT_SECURITY_BOUNDARIES = Object.freeze({
  marketing: createAgentSecurityBoundary({
    forbiddenInformation: ["payment", "payments", "invoice", "invoices", "receivable", "receivables", "finance", "banking", "hr_", "employee", "attendance", "absence", "leave"],
    forbiddenTools: ["get_pending_payments", "execute_invoice_payment", "get_hr_overview"]
  }),
  production: createAgentSecurityBoundary({
    forbiddenInformation: ["hr_", "employee", "attendance", "absence", "leave", "contract"],
    forbiddenTools: ["get_hr_overview"]
  }),
  community_manager: createAgentSecurityBoundary({
    forbiddenInformation: ["payment", "payments", "invoice", "invoices", "hr_", "employee", "legal_documents", "contracts"],
    forbiddenTools: ["get_pending_payments", "execute_invoice_payment", "get_hr_overview", "get_legal_overview"],
    supervisorAgentId: "marketing"
  }),
  legal: createAgentSecurityBoundary({
    forbiddenInformation: ["banking", "payments", "receivables", "hr_", "employee", "attendance", "absence", "leave"],
    forbiddenTools: ["get_pending_payments", "execute_invoice_payment", "get_hr_overview"]
  }),
  hr: createAgentSecurityBoundary({
    forbiddenInformation: ["finance", "payment", "payments", "invoice", "invoices", "receivable", "marketing", "production"],
    forbiddenTools: ["get_pending_payments", "get_marketing_overview", "get_delayed_production_orders"],
    requiresHumanApprovalForSensitiveActions: true
  }),
  after_sales: createAgentSecurityBoundary({
    forbiddenInformation: ["payment", "payments", "invoice", "invoices", "banking", "hr_", "employee", "legal_documents", "legal_cases"],
    forbiddenTools: ["get_pending_payments", "execute_invoice_payment", "get_hr_overview", "get_legal_overview"]
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
  validateAgentSecurityBoundary(agentId, config, errors);
  if (!Array.isArray(config?.promptInstructions)) {
    errors.push("promptInstructions must be an array");
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors
  });
}

export function validateSensitiveBusinessActionApproval(action) {
  if (!SENSITIVE_BUSINESS_ACTIONS_REQUIRING_APPROVAL.includes(action)) {
    return true;
  }

  return Object.freeze({
    action,
    requiresHumanApproval: true
  });
}

export function listSensitiveBusinessActionsRequiringApproval() {
  return [...SENSITIVE_BUSINESS_ACTIONS_REQUIRING_APPROVAL];
}

function createAgentSecurityBoundary({
  forbiddenInformation = [],
  forbiddenTools = [],
  supervisorAgentId = null,
  requiresHumanApprovalForSensitiveActions = false
} = {}) {
  return Object.freeze({
    forbiddenInformation: Object.freeze([...forbiddenInformation]),
    forbiddenTools: Object.freeze([...forbiddenTools]),
    supervisorAgentId,
    requiresHumanApprovalForSensitiveActions
  });
}

function validateAgentSecurityBoundary(agentId, config, errors) {
  const boundary = AGENT_SECURITY_BOUNDARIES[agentId];
  if (!boundary || !config) {
    return;
  }

  for (const forbidden of boundary.forbiddenInformation) {
    if (config.accessibleInformation?.some((entry) => entry.includes(forbidden))) {
      errors.push(`${agentId} accessibleInformation must not include ${forbidden}`);
    }
  }

  for (const toolId of boundary.forbiddenTools) {
    if (config.tools?.includes(toolId)) {
      errors.push(`${agentId} tools must not include ${toolId}`);
    }
  }

  if (
    boundary.requiresHumanApprovalForSensitiveActions &&
    !config.approvalRequiredActions?.includes("human_approval_required")
  ) {
    errors.push(`${agentId} must require human approval for sensitive actions`);
  }
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
