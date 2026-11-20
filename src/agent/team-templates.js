import { SPECIALISTS, SPECIALIST_IDS } from "./agent-team.js";

// The library of agents (CDC section 10-E, phase 4): a team ready for each kind
// of company, chosen when the company's cockpit is created
// (scripts/tenant.sh create --modele=…, HKIDS_TEAM_TEMPLATE), then adjusted by
// its direction in « Équipe IA » within what its plan allows.
//
// A template says which agents the company needs and what its trade is, told
// to the Director and to every agent. Nothing else changes: the agents keep
// their own instructions, settings and tools.
//
// What each plan opens (CDC section 13):
// - Starter: the template's essential agents, four at most;
// - Business: the whole team of its template;
// - Enterprise, and the pilot (no plan): any agent of the library.

export const TEAM_TEMPLATES = Object.freeze({
  fabricant: Object.freeze({
    label: "Fabricant / atelier",
    hint: "Fabrication sur commande : ventes, atelier, bureau d'études et CNC, achats de matières, finance.",
    agents: Object.freeze([...SPECIALIST_IDS]),
    essentials: Object.freeze(["commercial", "finance", "production", "administration"]),
    trade: ""
  }),
  commerce: Object.freeze({
    label: "Commerce / boutique",
    hint: "Vente de produits en magasin ou en ligne : stock, fournisseurs, ventes, SAV, réseaux sociaux.",
    agents: Object.freeze(["commercial", "finance", "purchasing", "marketing", "community_manager", "after_sales", "administration", "hr", "legal"]),
    essentials: Object.freeze(["commercial", "finance", "purchasing", "administration"]),
    trade: "L'entreprise est un commerce : elle achète et revend des produits, en magasin ou en ligne, sans les fabriquer. Pas d'atelier, de bureau d'études ni de CNC : un délai de livraison dépend du stock et des fournisseurs."
  }),
  restaurant: Object.freeze({
    label: "Restaurant / traiteur",
    hint: "Achats de denrées, caisse du jour, équipe salle et cuisine, réputation en ligne, devis traiteur et événements.",
    agents: Object.freeze(["finance", "purchasing", "hr", "marketing", "community_manager", "commercial", "administration", "legal"]),
    essentials: Object.freeze(["finance", "purchasing", "hr", "marketing"]),
    trade: "L'entreprise est un restaurant (et traiteur) : achats de denrées et fournisseurs, caisse du jour, équipe en salle et en cuisine, avis et réseaux sociaux ; les devis concernent les événements et le traiteur. Pas d'atelier, de bureau d'études ni de CNC."
  }),
  services: Object.freeze({
    label: "Entreprise de services",
    hint: "Prestations facturées au client : devis, contrats, facturation, équipe, suivi des clients.",
    agents: Object.freeze(["commercial", "finance", "hr", "marketing", "community_manager", "after_sales", "administration", "legal"]),
    essentials: Object.freeze(["commercial", "finance", "hr", "administration"]),
    trade: "L'entreprise vend des services (prestations, interventions, abonnements) : devis, contrats, planning de l'équipe, facturation et suivi des clients. Pas de stock de produits fabriqués, pas d'atelier ni de CNC."
  }),
  agence: Object.freeze({
    label: "Agence (communication, immobilier, voyage…)",
    hint: "Clients et mandats, propositions commerciales, campagnes, contrats, facturation.",
    agents: Object.freeze(["commercial", "finance", "marketing", "community_manager", "administration", "legal", "hr"]),
    essentials: Object.freeze(["commercial", "finance", "marketing", "administration"]),
    trade: "L'entreprise est une agence : elle gère des clients et des mandats, prépare des propositions, mène des campagnes et facture ses prestations. Pas d'atelier, de bureau d'études ni de CNC."
  })
});

export const DEFAULT_TEMPLATE_ID = "fabricant";
export const STARTER_MAX_AGENTS = 4;

// An agent only works with the one it depends on: the drawing office under
// Production, the Community Manager under Marketing.
export const AGENT_REQUIRES = Object.freeze({
  dessinateur_2d3d: "production",
  dessinateur_methodes: "production",
  community_manager: "marketing"
});

export class TeamTemplateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TeamTemplateError";
    this.code = code;
  }
}

export function templateFromEnv(env = process.env) {
  const id = typeof env.HKIDS_TEAM_TEMPLATE === "string" ? env.HKIDS_TEAM_TEMPLATE.trim().toLowerCase() : "";
  if (id === "") {
    return DEFAULT_TEMPLATE_ID;
  }
  if (!Object.hasOwn(TEAM_TEMPLATES, id)) {
    throw new TeamTemplateError(`Modèle d'équipe inconnu : ${id}. Modèles : ${Object.keys(TEAM_TEMPLATES).join(", ")}.`, "TEAM_TEMPLATE_UNKNOWN");
  }
  return id;
}

// The agents the company may have, under its template and plan.
export function allowedAgents(templateId, plan) {
  const template = TEAM_TEMPLATES[templateId] ?? TEAM_TEMPLATES[DEFAULT_TEMPLATE_ID];
  if (!plan || plan.id === "enterprise") {
    return [...SPECIALIST_IDS];
  }
  return plan.id === "starter" ? [...template.essentials] : [...template.agents];
}

export function maxAgents(plan) {
  return plan?.id === "starter" ? STARTER_MAX_AGENTS : null;
}

// The team a new cockpit starts with: the template's agents its plan opens.
export function defaultTeam(templateId, plan) {
  const template = TEAM_TEMPLATES[templateId] ?? TEAM_TEMPLATES[DEFAULT_TEMPLATE_ID];
  const allowed = new Set(allowedAgents(templateId, plan));
  const team = (plan?.id === "starter" ? template.essentials : template.agents).filter((id) => allowed.has(id));
  return withDependencies(team).filter((id) => allowed.has(id));
}

function withDependencies(team) {
  return team.filter((id) => !AGENT_REQUIRES[id] || team.includes(AGENT_REQUIRES[id]));
}

// The team after turning one agent on or off, or the reason it cannot be.
export function changeTeam(active, agentId, on, { templateId, plan }) {
  if (!SPECIALISTS[agentId]) {
    throw new TeamTemplateError("Agent inconnu.", "AGENT_UNKNOWN");
  }
  const label = SPECIALISTS[agentId].label;
  if (!on) {
    const dependants = active.filter((id) => AGENT_REQUIRES[id] === agentId);
    if (dependants.length > 0) {
      throw new TeamTemplateError(`Retirez d'abord ${dependants.map((id) => SPECIALISTS[id].label).join(" et ")}, qui travaille${dependants.length > 1 ? "nt" : ""} sous ${label}.`, "TEAM_AGENT_REQUIRED");
    }
    return active.filter((id) => id !== agentId);
  }
  if (active.includes(agentId)) {
    return active;
  }
  if (!allowedAgents(templateId, plan).includes(agentId)) {
    throw new TeamTemplateError(plan?.id === "starter"
      ? `${label} n'est pas compris dans l'offre Starter. Passez à l'offre Business pour toute l'équipe de votre modèle.`
      : `${label} ne fait pas partie de l'équipe « ${TEAM_TEMPLATES[templateId]?.label ?? templateId} » de l'offre ${plan?.label ?? ""}. L'offre Enterprise ouvre tous les agents.`, "TEAM_AGENT_NOT_IN_PLAN");
  }
  const needed = AGENT_REQUIRES[agentId];
  if (needed && !active.includes(needed)) {
    throw new TeamTemplateError(`Activez d'abord ${SPECIALISTS[needed].label} : ${label} travaille sous sa direction.`, "TEAM_AGENT_REQUIRED");
  }
  const limit = maxAgents(plan);
  if (limit !== null && active.length >= limit) {
    throw new TeamTemplateError(`L'offre ${plan.label} compte ${limit} agents, tous déjà actifs. Retirez-en un ou passez à l'offre Business.`, "TEAM_FULL");
  }
  return [...active, agentId];
}

// What every agent is told of the company's trade, when it is not H-KIDS'.
export function tradeNote(templateId) {
  const trade = TEAM_TEMPLATES[templateId]?.trade ?? "";
  return trade ? `Activité de l'entreprise : ${trade}` : "";
}

// What the Director is told of a team that is not the whole library.
export function teamNote(active, templateId) {
  const lines = [tradeNote(templateId)].filter(Boolean);
  if (active.length < SPECIALIST_IDS.length) {
    lines.push(`Ton équipe dans cette entreprise : ${active.map((id) => `${id} (${SPECIALISTS[id].label})`).join(", ") || "aucun agent"}. Ne délègue qu'à eux. Pour un autre métier, fais toi-même ce que tu peux et dis à la direction que cet agent peut être activé dans « Équipe IA » si son offre le permet.`);
  }
  return lines.join("\n");
}
