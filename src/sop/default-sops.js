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
    requiredApprovals: createApprovals(["execute_customer_action"]),
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
    requiredApprovals: createApprovals(["execute_payment", "change_invoice_status"]),
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
      "Prepare resolution follow-up recommendations for the Director."
    ]),
    inputs: createEntries(["after_sales_tickets", "customers", "orders"]),
    outputs: createEntries(["after_sales_resolution_summary"]),
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
      "Identify HR administrative subjects requiring attention.",
      "Prepare recommendations for the Director and request human approval for sensitive actions."
    ]),
    inputs: createEntries(["hr_demo_overview"]),
    outputs: createEntries(["hr_administrative_summary"]),
    requiredApprovals: createApprovals(["modify_hr_record", "approve_leave", "change_contract"]),
    relatedDomains: [],
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
      "Coordinate Community Manager preparation when public content is involved."
    ]),
    inputs: createEntries(["marketing_demo_overview"]),
    outputs: createEntries(["content_preparation_summary"]),
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
      "Prepare publication or response suggestions.",
      "Return preparation to Marketing supervision before Director synthesis."
    ]),
    inputs: createEntries(["public_content", "editorial_calendar"]),
    outputs: createEntries(["publication_preparation_summary"]),
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
      "Identify legal subjects requiring attention.",
      "Prepare a legal attention summary for the Director without executing legal actions."
    ]),
    inputs: createEntries(["legal_demo_overview"]),
    outputs: createEntries(["legal_attention_summary"]),
    requiredApprovals: createApprovals(["commit_legal_position", "sign_or_send_legal_document"]),
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
