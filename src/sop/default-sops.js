import { createSopDefinition } from "./contract.js";

export const DEFAULT_AGENT_SOPS = Object.freeze([
  createSopDefinition({
    id: "commercial-quote-follow-up-draft",
    agentId: "commercial",
    name: "Draft quote follow-up",
    description: "Draft CDC structure for reviewing pending quotes and preparing customer follow-up recommendations.",
    status: "draft",
    steps: createDraftSteps([
      "Review accessible quote signals.",
      "Identify quotes requiring follow-up.",
      "Prepare a recommendation for the Director without executing customer actions."
    ]),
    inputs: createEntries(["quotes", "customers"]),
    outputs: createEntries(["quote_follow_up_recommendation"]),
    requiredApprovals: createApprovals(["execute_customer_action", "apply_large_discount"]),
    relatedDomains: ["quotes", "customers"],
    metadata: createDraftMetadata({ source: "cdc", executesTools: false })
  }),
  createSopDefinition({
    id: "finance-receivables-follow-up-draft",
    agentId: "finance",
    name: "Draft payment and receivables follow-up",
    description: "Draft CDC structure for reviewing payments, receivables, invoices, and preparing finance priorities.",
    status: "draft",
    steps: createDraftSteps([
      "Review accessible payment and invoice signals.",
      "Identify receivables requiring attention.",
      "Prepare finance recommendations for the Director."
    ]),
    inputs: createEntries(["payments", "invoices", "customers"]),
    outputs: createEntries(["receivables_priority_summary"]),
    requiredApprovals: createApprovals(["execute_payment", "execute_invoice_payment", "execute_bank_transfer", "change_invoice_status"]),
    relatedDomains: ["payments", "invoices", "customers"],
    metadata: createDraftMetadata({ source: "cdc", executesTools: false })
  }),
  createSopDefinition({
    id: "production-delay-follow-up-draft",
    agentId: "production",
    name: "Draft order and delay follow-up",
    description: "Draft CDC structure for reviewing production order status and delay risks.",
    status: "draft",
    steps: createDraftSteps([
      "Review accessible order and production signals.",
      "Identify orders at risk of delay.",
      "Prepare operational recommendations for the Director."
    ]),
    inputs: createEntries(["orders", "production"]),
    outputs: createEntries(["production_delay_summary"]),
    requiredApprovals: createApprovals(["change_production_schedule"]),
    relatedDomains: ["orders", "production"],
    metadata: createDraftMetadata({ source: "cdc", executesTools: false })
  }),
  createSopDefinition({
    id: "purchasing-needs-identification-draft",
    agentId: "purchasing",
    name: "Draft purchase needs identification",
    description: "Draft CDC structure for identifying purchasing needs and preparing supplier actions.",
    status: "draft",
    steps: createDraftSteps([
      "Review accessible purchase need and supplier signals.",
      "Identify urgent purchasing needs.",
      "Prepare purchasing recommendations for the Director."
    ]),
    inputs: createEntries(["purchase_needs", "suppliers", "orders"]),
    outputs: createEntries(["purchase_need_summary"]),
    requiredApprovals: createApprovals(["place_purchase_order"]),
    relatedDomains: ["purchase_needs", "suppliers", "orders"],
    metadata: createDraftMetadata({ source: "cdc", executesTools: false })
  }),
  createSopDefinition({
    id: "after-sales-claim-resolution-draft",
    agentId: "after_sales",
    name: "Draft after-sales claim follow-up",
    description: "Draft CDC structure for following an after-sales claim until resolution preparation.",
    status: "draft",
    steps: createDraftSteps([
      "Review accessible after-sales ticket signals.",
      "Identify unresolved or urgent customer claims.",
      "Qualify warranty status, intervention needs, appointment status, responsible owner, and priority.",
      "Escalate blocked or critical quality issues when needed.",
      "Prepare resolution and closure follow-up recommendations for the Director.",
      "Track customer satisfaction signals without contacting customers directly."
    ]),
    inputs: createEntries(["after_sales_tickets", "customers", "orders", "warranty_status", "intervention_schedule", "customer_satisfaction"]),
    outputs: createEntries(["after_sales_resolution_summary", "warranty_follow_up_summary", "intervention_priority_summary", "satisfaction_follow_up_summary"]),
    requiredApprovals: createApprovals(["commit_customer_resolution"]),
    relatedDomains: ["after_sales_tickets", "customers", "orders"],
    metadata: createDraftMetadata({ source: "cdc", executesTools: false })
  }),
  createSopDefinition({
    id: "hr-administrative-follow-up-draft",
    agentId: "hr",
    name: "Draft HR administrative follow-up",
    description: "Draft CDC structure for HR administrative follow-up in demo mode without real personal data exposure.",
    status: "draft",
    steps: createDraftSteps([
      "Review authorized HR demo signals.",
      "Identify absence, leave, recruitment, incident, evaluation, and staffing subjects.",
      "Prepare HR documents or administrative follow-up as drafts only.",
      "Identify HR administrative subjects requiring attention.",
      "Escalate recruitment, dismissal, sanction, contract change, or HR financial commitment decisions for human approval.",
      "Prepare recommendations for the Director and request human approval for sensitive actions."
    ]),
    inputs: createEntries(["hr_demo_overview", "employees", "attendance", "absences", "leaves", "hr_documents", "hr_contracts", "recruitments", "hr_tasks", "hr_incidents", "evaluations", "staffing_needs"]),
    outputs: createEntries(["hr_administrative_summary", "absence_leave_summary", "recruitment_need_summary", "hr_incident_summary", "sensitive_hr_decision_preparation"]),
    requiredApprovals: createApprovals(["modify_hr_record", "approve_leave", "change_contract", "decide_recruitment", "terminate_employee", "apply_hr_sanction", "change_hr_contract_sensitive", "commit_hr_sensitive_decision", "commit_hr_financial_obligation", "prepare_hr_sensitive_decision"]),
    relatedDomains: ["hr_demo_overview"],
    metadata: createDraftMetadata({ source: "cdc", executesTools: false, sensitive: true })
  }),
  createSopDefinition({
    id: "marketing-content-preparation-draft",
    agentId: "marketing",
    name: "Draft content preparation",
    description: "Draft CDC structure for preparing marketing content and supervising Community Manager preparation.",
    status: "draft",
    steps: createDraftSteps([
      "Review accessible marketing signals.",
      "Identify content preparation priorities.",
      "Prepare the weekly editorial calendar as a draft.",
      "Compare campaign performance and identify the best opportunities.",
      "Coordinate Community Manager preparation when public content is involved."
    ]),
    inputs: createEntries(["marketing_demo_overview", "campaigns", "editorial_calendar", "marketing_performance"]),
    outputs: createEntries(["content_preparation_summary", "campaign_recommendation", "weekly_marketing_calendar"]),
    requiredApprovals: createApprovals(["publish_content"]),
    relatedDomains: [],
    metadata: createDraftMetadata({
      source: "cdc",
      executesTools: false,
      supervisedAgentIds: ["community_manager"]
    })
  }),
  createSopDefinition({
    id: "community-publication-preparation-draft",
    agentId: "community_manager",
    name: "Draft publication and response preparation",
    description: "Draft CDC structure for preparing publications and responses under Marketing supervision.",
    status: "draft",
    steps: createDraftSteps([
      "Review accessible public content signals.",
      "Prepare captions and publication ideas.",
      "Review comments and messages requiring a prepared response.",
      "Prepare publication or response suggestions.",
      "Escalate sensitive community issues to Marketing.",
      "Return preparation to Marketing supervision before Director synthesis."
    ]),
    inputs: createEntries(["public_content", "editorial_calendar", "comments", "messages", "engagement_demo"]),
    outputs: createEntries(["publication_preparation_summary", "prepared_caption", "prepared_public_reply", "community_escalation_summary"]),
    requiredApprovals: createApprovals(["publish_content", "send_public_reply"]),
    relatedDomains: [],
    metadata: createDraftMetadata({
      source: "cdc",
      executesTools: false,
      supervisorAgentId: "marketing"
    })
  }),
  createSopDefinition({
    id: "legal-attention-identification-draft",
    agentId: "legal",
    name: "Draft legal attention identification",
    description: "Draft CDC structure for identifying legal subjects requiring Director attention.",
    status: "draft",
    steps: createDraftSteps([
      "Review authorized legal demo signals.",
      "Identify contracts approaching deadline.",
      "Identify risky clauses and commercial terms.",
      "Prepare a non-binding response draft when requested.",
      "Identify legal subjects requiring attention.",
      "Signal items requiring lawyer review or human validation.",
      "Prepare a legal attention summary for the Director without executing legal actions."
    ]),
    inputs: createEntries(["legal_demo_overview", "contracts", "legal_documents", "commercial_terms", "clauses", "legal_cases"]),
    outputs: createEntries(["legal_attention_summary", "contract_deadline_watch", "legal_risk_summary", "legal_response_draft"]),
    requiredApprovals: createApprovals(["commit_legal_position", "sign_document", "sign_or_send_legal_document", "approve_legal_contract", "engage_company_contractually", "prepare_legal_sensitive_decision"]),
    relatedDomains: [],
    metadata: createDraftMetadata({ source: "cdc", executesTools: false, sensitive: true })
  })
]);

export function listDefaultSops() {
  return [...DEFAULT_AGENT_SOPS];
}

function createDraftSteps(descriptions) {
  return descriptions.map((description, index) => Object.freeze({
    id: `step-${index + 1}`,
    order: index + 1,
    description
  }));
}

function createEntries(names) {
  return names.map((name) => Object.freeze({
    name,
    description: "Draft CDC placeholder. Client-specific details are not confirmed."
  }));
}

function createApprovals(actions) {
  return actions.map((action) => Object.freeze({
    action,
    required: true,
    reason: "Draft CDC safeguard: human validation is required before any sensitive or external action."
  }));
}

function createDraftMetadata(extra = {}) {
  return Object.freeze({
    draft: true,
    confirmedByClient: false,
    operationalUse: "planning_reference_only",
    executesTools: false,
    ...extra
  });
}
