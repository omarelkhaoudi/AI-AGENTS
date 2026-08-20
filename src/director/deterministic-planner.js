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
  "point complet"
];

const EXTENDED_ISSUES_PATTERNS = [
  "problemes urgents",
  "problemes importants",
  "important aujourd"
];

const COMMUNICATION_PATTERNS = Object.freeze([
  "communication",
  "communiquer",
  "communique",
  "publier",
  "publication",
  "publications",
  "publications de cette semaine",
  "contenus dois-je publier",
  "contenu dois-je publier",
  "commentaire",
  "commentaires",
  "messages necessitent une reponse",
  "message necessite une reponse",
  "caption",
  "captions",
  "engagement",
  "reseaux sociaux",
  "planning editorial",
  "calendrier editorial"
]);

const MATERIAL_NEEDS_PATTERNS = Object.freeze([
  "besoin matiere",
  "besoins matiere",
  "besoin matieres",
  "besoins matieres",
  "matiere premiere",
  "matieres premieres",
  "manque matiere",
  "rupture matiere"
]);

const FINANCE_RECEIVABLE_PATTERNS = Object.freeze([
  "creance",
  "creances",
  "impaye",
  "impayes",
  "encaissement",
  "encaissements",
  "paiements sont en retard",
  "paiements en retard",
  "paiement est en retard",
  "paiement en retard"
]);

const COMMERCIAL_ORDER_PATTERNS = Object.freeze([
  "commande commerciale",
  "commandes commerciales"
]);

const AFTER_SALES_ONLY_PATTERNS = Object.freeze([
  "sav",
  "reclamation",
  "reclamations",
  "garantie",
  "garanties",
  "intervention",
  "interventions",
  "satisfaction client"
]);

const SENSITIVE_PAYMENT_PATTERNS = Object.freeze([
  "effectue le paiement",
  "execute le paiement",
  "payer cette facture",
  "paiement de cette facture"
]);

const SENSITIVE_HR_PATTERNS = Object.freeze([
  "decision de recrutement",
  "decider de recruter",
  "licencier",
  "licenciement",
  "sanction",
  "modifier le contrat",
  "modification contractuelle",
  "decision rh sensible"
]);

const SENSITIVE_LEGAL_PATTERNS = Object.freeze([
  "signe ce contrat",
  "signer ce contrat",
  "signature du contrat",
  "signature juridique",
  "valide ce contrat",
  "validation juridique sensible",
  "engage juridiquement",
  "engager juridiquement",
  "engagement juridique",
  "engagement contractuel sensible"
]);

const AGENT_PATTERNS = Object.freeze([
  {
    agentId: "finance",
    reason: "The request contains finance or cash collection intent.",
    patterns: ["encaisser", "encaisse", "paiement", "paiements", "finance", "tresorerie", "facture", "factures", "creance", "creances", "impaye", "impayes"]
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
    patterns: ["rh", "ressources humaines", "salarie", "salaries", "presence", "presences", "absent", "absents", "absence", "absences", "conge", "conges", "recruter", "recrutement", "recrutements", "personnel", "dossiers rh"]
  },
  {
    agentId: "after_sales",
    reason: "The request contains after-sales, support, quality, or customer issue intent.",
    patterns: ["sav", "qualite", "support", "reclamation", "reclamations", "garantie", "garanties", "intervention", "interventions", "probleme client", "problemes clients", "problemes sav", "dossiers sav", "satisfaction client"]
  },
  {
    agentId: "marketing",
    reason: "The request contains marketing, campaign, content, or performance intent.",
    patterns: ["marketing", "campagne", "campagnes", "contenu", "contenus", "performance marketing", "performent", "acquisition", "communication", "calendrier marketing", "actions marketing"]
  },
  {
    agentId: "community_manager",
    reason: "The request contains community management, social content, or editorial intent.",
    patterns: ["community", "community manager", "reseaux sociaux", "social", "publication", "publications", "editorial", "commentaire", "commentaires", "messages", "caption", "captions", "engagement"]
  },
  {
    agentId: "legal",
    reason: "The request contains legal, contract, compliance, or juridical intent.",
    patterns: ["juridique", "legal", "contrat", "contrats", "conditions commerciales", "clause", "clauses", "echeance", "echeances", "engagement contractuel", "engagements contractuels", "conformite", "litige", "litiges"]
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
const MATERIAL_NEEDS_AGENT_IDS = Object.freeze(["production", "purchasing"]);

// Tools an agent contributes to a plan, in order. The list shape lets an agent
// carry several steps; every agent holds exactly one tool today, so the plans
// produced are unchanged.
export const DEFAULT_TOOLS_BY_AGENT = Object.freeze({
  finance: Object.freeze(["get_pending_payments"]),
  commercial: Object.freeze(["get_pending_quotes"]),
  production: Object.freeze(["get_delayed_production_orders"]),
  purchasing: Object.freeze(["get_purchase_needs"]),
  hr: Object.freeze(["get_hr_overview"]),
  after_sales: Object.freeze(["get_after_sales_overview"]),
  marketing: Object.freeze(["get_marketing_overview"]),
  community_manager: Object.freeze(["get_community_overview"]),
  legal: Object.freeze(["get_legal_overview"])
});

export function createDeterministicPlanner() {
  return createPlanner({
    id: "deterministic",
    kind: "deterministic",
    description: "Deterministic MVP planner generated from request wording.",
    plan: async ({ request }) => createDeterministicPlan(request)
  });
}

// toolNamesByAgent is a seam: it defaults to the production table and lets a
// test exercise an agent carrying several tools without touching that table.
export function createDeterministicPlan(request, { toolNamesByAgent = DEFAULT_TOOLS_BY_AGENT } = {}) {
  const text = normalizeRequestText(request);
  const agentIds = selectAgentIds(text);
  const requestId = request.id ?? request.requestId;
  let stepIndex = 0;

  return Object.freeze({
    version: PLANNER_PLAN_VERSION,
    requestId,
    intent: inferIntent(text, agentIds),
    summary: "Deterministic MVP plan generated from request wording.",
    planner: "deterministic",
    agents: agentIds,
    // Steps are numbered across the whole plan, not per agent: a plan step
    // sequence and a step id must stay unique however many steps an agent
    // contributes.
    steps: agentIds.flatMap((agentId) => {
      const definition = AGENT_PATTERNS.find((pattern) => pattern.agentId === agentId);
      const sensitivePayment = agentId === "finance" && isSensitivePaymentRequest(text);
      const sensitiveHr = agentId === "hr" && isSensitiveHrRequest(text);
      const sensitiveLegal = agentId === "legal" && isSensitiveLegalRequest(text);
      return selectToolNames(agentId, text, toolNamesByAgent).map((toolName) => {
      const index = stepIndex;
      stepIndex += 1;
      return Object.freeze({
        id: createStepId(requestId, agentId, index),
        agentId,
        sequence: index + 1,
        actionKind: sensitivePayment ? "execute_action" : sensitiveHr || sensitiveLegal ? "prepare_action" : "read_analyze",
        actionType: sensitivePayment
          ? "execute_invoice_payment"
          : sensitiveHr
            ? "prepare_hr_sensitive_decision"
            : sensitiveLegal
              ? "prepare_legal_sensitive_decision"
              : "analyze_request",
        toolName,
        resource: `request:${requestId}`,
        reason: sensitivePayment
          ? "The request asks for a sensitive payment action that requires human approval."
          : sensitiveHr
            ? "The request asks for a sensitive HR decision that requires human approval."
            : sensitiveLegal
              ? "The request asks for a sensitive legal commitment that requires human approval."
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
        requiresApproval: sensitivePayment || sensitiveHr || sensitiveLegal
      });
      });
    }),
    metadata: {
      planner: "deterministic",
      matchedText: text
    }
  });
}

// A sensitive request replaces the agent tools with the single tool that must go
// through human approval. Otherwise the agent contributes its declared list.
function selectToolNames(agentId, text, toolNamesByAgent = DEFAULT_TOOLS_BY_AGENT) {
  if (agentId === "finance" && isSensitivePaymentRequest(text)) {
    return ["execute_invoice_payment"];
  }
  if (agentId === "hr" && isSensitiveHrRequest(text)) {
    return ["prepare_hr_sensitive_decision"];
  }
  if (agentId === "legal" && isSensitiveLegalRequest(text)) {
    return ["prepare_legal_sensitive_decision"];
  }

  return [...(toolNamesByAgent[agentId] ?? [])];
}

function inferIntent(text, agentIds) {
  if (isSensitivePaymentRequest(text)) {
    return "sensitive_invoice_payment";
  }
  if (isSensitiveHrRequest(text)) {
    return "sensitive_hr_decision";
  }
  if (isSensitiveLegalRequest(text)) {
    return "sensitive_legal_decision";
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
  if (isSensitiveHrRequest(text)) {
    return ["hr"];
  }
  if (isSensitiveLegalRequest(text)) {
    return ["legal"];
  }

  if (COMMUNICATION_PATTERNS.some((pattern) => text.includes(pattern))) {
    return [...COMMUNICATION_AGENT_IDS];
  }

  if (MATERIAL_NEEDS_PATTERNS.some((pattern) => text.includes(pattern))) {
    return [...MATERIAL_NEEDS_AGENT_IDS];
  }

  if (
    AFTER_SALES_ONLY_PATTERNS.some((pattern) => text.includes(pattern)) &&
    !["commande", "commandes", "production"].some((pattern) => text.includes(pattern))
  ) {
    return ["after_sales"];
  }

  if (
    FINANCE_RECEIVABLE_PATTERNS.some((pattern) => text.includes(pattern)) &&
    !hasExplicitMultiDomainIntent(text)
  ) {
    return ["finance"];
  }

  if (COMMERCIAL_ORDER_PATTERNS.some((pattern) => text.includes(pattern))) {
    return ["commercial"];
  }

  if (CDC_PRIORITY_PATTERNS.some((pattern) => text.includes(pattern))) {
    return [...GLOBAL_AGENT_IDS];
  }

  if (EXTENDED_ISSUES_PATTERNS.some((pattern) => text.includes(pattern))) {
    return [...EXTENDED_GLOBAL_AGENT_IDS];
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

function isSensitiveHrRequest(text) {
  return SENSITIVE_HR_PATTERNS.some((pattern) => text.includes(pattern));
}

function isSensitiveLegalRequest(text) {
  return SENSITIVE_LEGAL_PATTERNS.some((pattern) => text.includes(pattern));
}

function hasExplicitMultiDomainIntent(text) {
  return [
    "devis",
    "relancer",
    "relance",
    "commercial",
    "prospect",
    "vente",
    "production",
    "commande",
    "commandes",
    "livraison",
    "livrer",
    "achat",
    "achats",
    "acheter",
    "fournisseur",
    "approvisionnement",
    "sav",
    "qualite",
    "support",
    "reclamation"
  ].some((pattern) => text.includes(pattern));
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
