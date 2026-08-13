import { createPlanner } from "./planner-contract.js";

const GLOBAL_PATTERNS = [
  "point sur mon entreprise",
  "point entreprise",
  "mon entreprise",
  "entreprise",
  "global",
  "synthese",
  "tableau de bord"
];

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
  }
]);

const GLOBAL_AGENT_IDS = Object.freeze(["finance", "commercial", "production", "purchasing"]);

const DEFAULT_TOOL_BY_AGENT = Object.freeze({
  finance: "get_company_overview",
  commercial: "get_pending_quotes",
  production: "get_delayed_production_orders",
  purchasing: "get_purchase_needs"
});

const INTENT_TOOL_BY_AGENT = Object.freeze({
  finance: "get_pending_payments",
  commercial: "get_pending_quotes",
  production: "get_delayed_production_orders",
  purchasing: "get_purchase_needs"
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

  return Object.freeze({
    summary: "Deterministic MVP plan generated from request wording.",
    planner: "deterministic",
    agents: agentIds,
    steps: agentIds.map((agentId, index) => {
      const definition = AGENT_PATTERNS.find((pattern) => pattern.agentId === agentId);
      return Object.freeze({
        agentId,
        sequence: index + 1,
        actionKind: "read_analyze",
        actionType: "analyze_request",
        toolName: selectToolName(agentId, text),
        resource: `request:${request.id ?? request.requestId}`,
        reason: definition?.reason ?? "Global company overview requires this specialized agent.",
        input: {
          requestId: request.id ?? request.requestId,
          planner: "deterministic"
        },
        requiresApproval: false
      });
    }),
    metadata: {
      planner: "deterministic",
      matchedText: text
    }
  });
}

function selectToolName(agentId, text) {
  if (agentId === "finance" && AGENT_PATTERNS[0].patterns.some((pattern) => text.includes(pattern))) {
    return INTENT_TOOL_BY_AGENT.finance;
  }

  return DEFAULT_TOOL_BY_AGENT[agentId] ?? null;
}

export function selectAgentIds(text) {
  if (GLOBAL_PATTERNS.some((pattern) => text.includes(pattern))) {
    return [...GLOBAL_AGENT_IDS];
  }

  const selected = AGENT_PATTERNS
    .filter((entry) => entry.patterns.some((pattern) => text.includes(pattern)))
    .map((entry) => entry.agentId);

  return selected.length > 0 ? selected : [...GLOBAL_AGENT_IDS];
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
