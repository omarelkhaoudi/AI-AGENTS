import { PLANNER_PLAN_VERSION, createPlanner } from "./planner-contract.js";

const GLOBAL_PATTERNS = [
  "point sur mon entreprise",
  "point entreprise",
  "mon entreprise",
  "entreprise",
  "global",
  "synthese",
  "tableau de bord"
];

const CDC_PRIORITY_PATTERNS = [
  "point complet",
  "problemes urgents",
  "problemes importants",
  "important aujourd"
];

const COMMUNICATION_PATTERNS = Object.freeze([
  "communication",
  "communiquer",
  "communique",
  "publier",
  "planning editorial",
  "calendrier editorial"
]);

const SENSITIVE_PAYMENT_PATTERNS = Object.freeze([
  "effectue le paiement",
  "execute le paiement",
  "payer cette facture",
  "paiement de cette facture"
]);

const AGENT_PATTERNS = Object.freeze([
  {
    agentId: "finance",
    reason: "The request contains finance or cash collection intent.",
    patterns: ["encaisser", "encaisse", "paiement", "finance", "tresorerie", "facture", "factures"]
  },
  {
    agentId: "commercial",
    reason: "The request contains customer follow-up or sales intent.",
    patterns: ["client", "clients", "relancer", "relance", "commercial", "vente", "ventes", "devis", "prospect"]
  },
  {
    agentId: "production",
    reason: "The request contains production, order, delivery, or delay intent.",
    patterns: ["production", "commandes", "retard", "retards", "livraison", "livrer"]
  },
  {
    agentId: "purchasing",
    reason: "The request contains purchasing or procurement intent.",
    patterns: ["commander", "commande fournisseur", "achat", "achats", "acheter", "fournisseur", "approvisionnement"]
  },
  {
    agentId: "hr",
    reason: "The request contains HR, attendance, leave, hiring, or workforce administration intent.",
    patterns: ["rh", "ressources humaines", "salarie", "salaries", "presence", "presences", "absence", "absences", "conge", "conges", "recrutement", "recrutements", "personnel"]
  },
  {
    agentId: "after_sales",
    reason: "The request contains after-sales, support, quality, or customer issue intent.",
    patterns: ["sav", "qualite", "support", "reclamation", "reclamations", "probleme client", "problemes clients"]
  },
  {
    agentId: "marketing",
    reason: "The request contains marketing, campaign, content, or performance intent.",
    patterns: ["marketing", "campagne", "campagnes", "contenu", "performance marketing", "acquisition", "communication"]
  },
  {
    agentId: "community_manager",
    reason: "The request contains community management, social content, or editorial intent.",
    patterns: ["community", "community manager", "reseaux sociaux", "social", "publication", "publications", "editorial"]
  },
  {
    agentId: "legal",
    reason: "The request contains legal, contract, compliance, or juridical intent.",
    patterns: ["juridique", "legal", "contrat", "contrats", "conformite", "litige", "litiges"]
  }
]);

const GLOBAL_AGENT_IDS = Object.freeze([
  "finance",
  "commercial",
  "production",
  "purchasing",
  "after_sales"
]);

const EXTENDED_GLOBAL_AGENT_IDS = Object.freeze([
  "finance",
  "commercial",
  "production",
  "purchasing",
  "hr",
  "after_sales",
  "marketing",
  "community_manager",
  "legal"
]);

const COMMUNICATION_AGENT_IDS = Object.freeze(["marketing", "community_manager"]);

const DEFAULT_TOOL_BY_AGENT = Object.freeze({
  finance: "get_pending_payments",
  commercial: "get_pending_quotes",
  production: "get_delayed_production_orders",
  purchasing: "get_purchase_needs",
  hr: "get_hr_overview",
  after_sales: "get_after_sales_overview",
  marketing: "get_marketing_overview",
  community_manager: "get_community_overview",
  legal: "get_legal_overview"
});

const INTENT_TOOL_BY_AGENT = Object.freeze({
  finance: "get_pending_payments",
  commercial: "get_pending_quotes",
  production: "get_delayed_production_orders",
  purchasing: "get_purchase_needs",
  hr: "get_hr_overview",
  after_sales: "get_after_sales_overview",
  marketing: "get_marketing_overview",
  community_manager: "get_community_overview",
  legal: "get_legal_overview"
});

export function createDeterministicPlanner() {
  return createPlanner({
    id: "deterministic",
    kind: "deterministic",
    description: "Deterministic MVP planner generated from request wording.",
    plan: async ({ request }) => createDeterministicPlan(request)
  });
}

export function createDeterministicPlan(request) {
  const text = normalizeRequestText(request);
  const agentIds = selectAgentIds(text);
  const requestId = request.id ?? request.requestId;

  return Object.freeze({
    version: PLANNER_PLAN_VERSION,
    requestId,
    intent: inferIntent(text, agentIds),
    summary: "Deterministic MVP plan generated from request wording.",
    planner: "deterministic",
    agents: agentIds,
    steps: agentIds.map((agentId, index) => {
      const definition = AGENT_PATTERNS.find((pattern) => pattern.agentId === agentId);
      const sensitivePayment = agentId === "finance" && isSensitivePaymentRequest(text);
      return Object.freeze({
        id: createStepId(requestId, agentId, index),
        agentId,
        sequence: index + 1,
        actionKind: sensitivePayment ? "execute_action" : "read_analyze",
        actionType: sensitivePayment ? "execute_invoice_payment" : "analyze_request",
        toolName: selectToolName(agentId, text),
        resource: `request:${requestId}`,
        reason: sensitivePayment
          ? "The request asks for a sensitive payment action that requires human approval."
          : definition?.reason ?? "Global company overview requires this specialized agent.",
        input: {
          requestId,
          planner: "deterministic",
          ...(agentId === "marketing" && agentIds.includes("community_manager")
            ? { supervisedAgentIds: ["community_manager"] }
            : {}),
          ...(agentId === "community_manager" && agentIds.includes("marketing")
            ? { delegatedByAgentId: "marketing", reportsToAgentId: "marketing" }
            : {})
        },
        requiresApproval: sensitivePayment
      });
    }),
    metadata: {
      planner: "deterministic",
      matchedText: text
    }
  });
}

function selectToolName(agentId, text) {
  if (agentId === "finance" && isSensitivePaymentRequest(text)) {
    return "execute_invoice_payment";
  }

  if (agentId === "finance" && AGENT_PATTERNS[0].patterns.some((pattern) => text.includes(pattern))) {
    return INTENT_TOOL_BY_AGENT.finance;
  }

  return DEFAULT_TOOL_BY_AGENT[agentId] ?? null;
}

function inferIntent(text, agentIds) {
  if (isSensitivePaymentRequest(text)) {
    return "sensitive_invoice_payment";
  }
  if (agentIds.length > 1) {
    return "global_company_overview";
  }
  return AGENT_PATTERNS.find((entry) => entry.agentId === agentIds[0])?.agentId ?? text;
}

function createStepId(requestId, agentId, index) {
  return `${requestId}:deterministic:${index + 1}:${agentId}`;
}

export function selectAgentIds(text) {
  if (isSensitivePaymentRequest(text)) {
    return ["finance"];
  }

  if (COMMUNICATION_PATTERNS.some((pattern) => text.includes(pattern))) {
    return [...COMMUNICATION_AGENT_IDS];
  }

  if (CDC_PRIORITY_PATTERNS.some((pattern) => text.includes(pattern))) {
    return [...GLOBAL_AGENT_IDS];
  }

  if (GLOBAL_PATTERNS.some((pattern) => text.includes(pattern))) {
    return [...EXTENDED_GLOBAL_AGENT_IDS];
  }

  const selected = AGENT_PATTERNS
    .filter((entry) => entry.patterns.some((pattern) => text.includes(pattern)))
    .map((entry) => entry.agentId);

  return selected.length > 0 ? selected : [...GLOBAL_AGENT_IDS];
}

function isSensitivePaymentRequest(text) {
  return SENSITIVE_PAYMENT_PATTERNS.some((pattern) => text.includes(pattern));
}

function normalizeRequestText(request = {}) {
  return [
    request.title,
    request.payload?.question,
    request.payload?.message,
    request.payload?.text,
    request.payload?.objective
  ]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}
