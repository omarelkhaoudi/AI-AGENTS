import { BUDGET_CATEGORIES, BudgetBookError, budgetStatus, orderKey } from "./budget-book.js";

// The budgets for the agents (budget-book.js): Finance reads them, the
// Director also sets them when the direction says one in words.

const STATUS_TOOL = Object.freeze({
  type: "function",
  name: "budgets",
  description: "Les budgets réels de la direction comparés à la caisse : budget du mois par catégorie de dépense (dépensé, %, dépassé ou non), budget de chaque bon de commande, trésorerie minimale et prévision des 15 prochains jours. Un budget non fixé n'existe pas : ne jamais en supposer un.",
  parameters: { type: "object", additionalProperties: false, properties: {}, required: [] }
});

const SET_TOOL = Object.freeze({
  type: "function",
  name: "fixer_budget",
  description: `Fixe ou enlève un budget, seulement quand la DIRECTION le dit (« budget transport 3 000 DH par mois », « pas plus de 12 000 DH de dépenses sur le BC 164 », « garde toujours 20 000 DH en caisse »). Catégories mensuelles : ${Object.entries(BUDGET_CATEGORIES).map(([id, label]) => `${id} (${label})`).join(", ")}.`,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["categorie", "bon_commande", "tresorerie_minimale"] },
      cible: { type: "string", description: "categorie : l'identifiant de la catégorie ; bon_commande : le numéro du BC ; chaîne vide pour tresorerie_minimale." },
      montant: { type: "string", description: "Montant en DH dit par la direction ; « aucun » pour enlever le budget." }
    },
    required: ["type", "cible", "montant"]
  }
});

export const DIRECTOR_BUDGET_TOOLS = Object.freeze([STATUS_TOOL, SET_TOOL]);
export const BUDGET_TOOL_NAMES = Object.freeze(DIRECTOR_BUDGET_TOOLS.map((tool) => tool.name));

export function budgetTools(context, agentId) {
  return agentId === "finance" ? [{ tool: STATUS_TOOL, run: (args) => runBudgetTool(STATUS_TOOL.name, args, context, agentId) }] : [];
}

const text = (value) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const dh = (value) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value).replace(/ | /g, " ")} DH`;

export async function runBudgetTool(name, args, { books, workshop, clock = () => new Date(), confidential = true }, by) {
  if (!books?.budget || !books?.cash || !workshop) {
    return { ok: false, erreur: "Les budgets ne sont pas disponibles : je n'ai pas l'information." };
  }
  try {
    if (name === SET_TOOL.name) {
      const amount = text(args.montant);
      const change = args.type === "categorie"
        ? { monthly: { [text(args.cible)]: amount } }
        : args.type === "bon_commande"
          ? { orders: { [orderKey(args.cible)]: amount } }
          : { cashFloor: amount };
      await books.budget.set(change, { by });
      await books.team?.log({ agent: "finance", kind: "equipe", text: `Budget modifié sur instruction de la direction : ${args.type === "categorie" ? BUDGET_CATEGORIES[text(args.cible)] : args.type === "bon_commande" ? `BC n° ${orderKey(args.cible)}` : "trésorerie minimale"} → ${amount || "aucun"}.`, by }).catch(() => {});
    } else if (name !== STATUS_TOOL.name) {
      return { ok: false, erreur: `Outil budgétaire inconnu : ${name}.` };
    }
    const [state, entries, orders] = await Promise.all([books.budget.state(), books.cash.entries(), workshop.book()]);
    return { ok: true, ...(name === SET_TOOL.name ? { enregistre: true } : {}), ...describe(budgetStatus(state, entries, orders, { today: clock(), confidential })) };
  } catch (error) {
    if (error instanceof BudgetBookError) {
      return { ok: false, erreur: error.message };
    }
    throw error;
  }
}

function describe(status) {
  const line = (entry) => (entry.masked
    ? `${entry.label} : budget réservé à la direction${entry.over ? " — DÉPASSÉ" : ""}`
    : `${entry.label} : ${dh(entry.spent)} dépensés sur ${dh(entry.budget)}${entry.percent !== null ? ` (${String(entry.percent).replace(".", ",")} %)` : ""}${entry.over ? " — DÉPASSÉ" : ""}`);
  return {
    source: "budgets de la direction et journal de caisse (données réelles)",
    mois: status.month,
    budgets_du_mois: status.categories.length > 0 ? status.categories.map(line) : "aucun budget mensuel fixé par la direction",
    budgets_par_bon_de_commande: status.orders.length > 0
      ? status.orders.map((entry) => `BC n° ${entry.number}${entry.client ? ` (${entry.client})` : ""} : ${dh(entry.spent)} dépensés sur ${dh(entry.budget)}${entry.percent !== null ? ` (${String(entry.percent).replace(".", ",")} %)` : ""}${entry.over ? " — DÉPASSÉ" : ""}`)
      : "aucun budget de commande fixé",
    tresorerie: status.cash.hasBook
      ? `solde du jour ${dh(status.cash.balance)} ; au plus bas ${dh(status.cash.lowest.balance)} le ${status.cash.lowest.day.split("-").reverse().join("/")} sur ${status.cash.days} jours ; minimum ${status.cash.floor !== null ? dh(status.cash.floor) : "non fixé (alerte sous zéro)"}${status.cash.below ? " — INSUFFISANTE" : ""}`
      : "journal de caisse vide : pas de prévision"
  };
}
