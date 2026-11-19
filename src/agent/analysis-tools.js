import { CASH_CATEGORIES } from "./cash-book.js";
import { STANDARD_PLAN_LABEL, cashForecast, orderMargins } from "./business-analysis.js";
import { frenchDay, isoDay } from "./sales-book.js";

// The Director's and Finance's analysis tools (CDC 10.D), on the workshop
// book and the cash book.

export const MARGINS_TOOL = Object.freeze({
  type: "function",
  name: "rentabilite",
  description: "Marge des commandes d'une période, calculée sur les bons de commande du cockpit et les dépenses de caisse rattachées à chacun (numéro de BC ou de devis sur le mouvement) : par commande, par produit (objet du BC), puis les charges non rattachées (loyer, salaires, charges). Une commande sans dépense rattachée n'a pas de marge mesurable : elle est listée à part. À appeler pour « quels produits sont les plus rentables », « quelle marge sur le BC 166 », « on gagne combien sur les lits cabane ».",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      du: { type: "string", description: "Début JJ/MM/AAAA (date du BC) ; chaîne vide pour les 3 derniers mois." },
      au: { type: "string", description: "Fin JJ/MM/AAAA ; chaîne vide pour aujourd'hui." }
    },
    required: ["du", "au"]
  }
});

export const FORECAST_TOOL = Object.freeze({
  type: "function",
  name: "prevision_tresorerie",
  description: "Prévision de trésorerie sur les prochains jours : solde de caisse d'aujourd'hui, encaissements attendus des clients (acomptes non reçus, la part due à la livraison, à la date prévue au carnet d'atelier, soldes des commandes installées), dépenses au rythme des 30 derniers jours, solde prévu chaque jour, point le plus bas et premier jour négatif. À appeler pour « quelle trésorerie dans 15 jours », « est-ce qu'on peut payer le fournisseur la semaine prochaine », « risque de trou de trésorerie ».",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      jours: { type: "integer", description: "Horizon en jours, de 1 à 90 ; 15 si non précisé." }
    },
    required: ["jours"]
  }
});

export const ANALYSIS_TOOL_NAMES = Object.freeze([MARGINS_TOOL.name, FORECAST_TOOL.name]);

export function analysisTools(context) {
  return [
    { tool: MARGINS_TOOL, run: (args) => margins(args, context) },
    { tool: FORECAST_TOOL, run: (args) => forecast(args, context) }
  ];
}

export async function runAnalysisTool(name, args, context) {
  return name === MARGINS_TOOL.name ? margins(args, context) : forecast(args, context);
}

async function sources({ books, workshop }) {
  if (!books?.cash || !workshop) {
    return null;
  }
  const [orders, entries] = await Promise.all([workshop.book(), books.cash.entries()]);
  return { orders, entries };
}

export async function margins(args, context) {
  const data = await sources(context);
  if (!data) {
    return { ok: false, erreur: "Le carnet d'atelier ou le journal de caisse n'est pas disponible : je n'ai pas l'information." };
  }
  const today = isoDay((context.clock ?? (() => new Date()))());
  const threeMonths = new Date(Date.parse(`${today}T00:00:00Z`) - 91 * 86_400_000).toISOString().slice(0, 10);
  const from = isoDay(text(args.du)) ?? threeMonths;
  const to = isoDay(text(args.au)) ?? today;
  const confidential = context.confidential !== false;
  const report = orderMargins(data.orders, data.entries, { from, to, confidential });
  if (report.orders.length === 0) {
    return { ok: true, periode: period(from, to), info: "Aucun bon de commande du cockpit dans cette période : pas de marge à calculer." };
  }
  return {
    ok: true,
    periode: period(from, to),
    methode: "marge = vente HT (total TTC du BC / 1,2) − dépenses de caisse rattachées au BC ou à son devis, comptées telles que payées (TVA comprise quand il y en a : la marge est donc prudente). Seules les dépenses enregistrées au journal de caisse sont comptées.",
    commandes_mesurees: report.measured,
    marge_brute_totale: report.measured > 0 ? `${dh(report.grossMargin)} sur ${dh(report.salesHtMeasured)} de ventes HT (${pct(report.grossMargin, report.salesHtMeasured)})` : "aucune",
    par_produit: report.byProduct.map((product) => `${product.object} : ${product.orders.length} commande(s) (BC ${product.orders.join(", ")}), ventes HT ${dh(product.salesHt)}, dépenses ${dh(product.costs)}, marge ${dh(product.margin)} (${product.rate} %)`),
    par_commande: report.orders.filter((line) => line.measurable).map((line) => `BC ${line.number} (${line.client}, ${line.object}${line.finished ? "" : ", fabrication en cours : d'autres dépenses peuvent venir"}) : ventes HT ${dh(line.salesHt)}, dépenses ${dh(line.costs)} [${line.byCategory.map((entry) => `${label(entry.category)} ${dh(entry.amount)}`).join(", ")}], marge ${dh(line.margin)} (${line.rate} %)`),
    ...(report.unmeasured.length > 0 ? { sans_depense_rattachee: `BC n° ${report.unmeasured.join(", ")} : aucune dépense de caisse n'y est rattachée, marge non mesurable. Pour la mesurer, noter le numéro du BC sur chaque achat de matière ou de sous-traitance.` } : {}),
    charges_non_rattachees: report.overheads.length > 0
      ? { total: dh(report.overheadTotal), detail: report.overheads.map((entry) => `${label(entry.category)} : ${dh(entry.amount)}`) }
      : "aucune dépense non rattachée dans la période",
    ...(report.measured > 0 ? { apres_charges: `marge brute ${dh(report.grossMargin)} − charges non rattachées ${dh(report.overheadTotal)} = ${dh(report.grossMargin - report.overheadTotal)} (indicatif : les charges couvrent aussi les commandes non mesurées)` } : {}),
    ...(report.strays.length > 0 ? { depenses_hors_cockpit: report.strays.map((entry) => `mouvement n° ${entry.number}, ${entry.reference} (vente inconnue du cockpit)${entry.amount === null ? "" : ` : ${dh(entry.amount)}`}`) } : {})
  };
}

export async function forecast(args, context) {
  const data = await sources(context);
  if (!data) {
    return { ok: false, erreur: "Le carnet d'atelier ou le journal de caisse n'est pas disponible : je n'ai pas l'information." };
  }
  const days = Math.min(90, Math.max(1, Number.parseInt(args.jours, 10) || 15));
  const result = cashForecast(data.orders, data.entries, { today: (context.clock ?? (() => new Date()))(), days });
  if (!result.hasBook) {
    return { ok: true, info: "Le journal de caisse est vide : sans solde de départ ni mouvement, je ne peux pas prévoir la trésorerie. Donnez le solde de caisse d'aujourd'hui pour commencer." };
  }
  return {
    ok: true,
    horizon: `du ${frenchDay(result.from)} au ${frenchDay(result.to)} (${result.days} jours)`,
    solde_aujourdhui: dh(result.balance),
    encaissements_attendus: {
      total: dh(result.inflows),
      dont_deja_en_retard: dh(result.overdue),
      detail: result.expected.map((entry) => `${frenchDay(entry.day)} : ${dh(entry.amount)}, BC ${entry.order} (${entry.client}) — ${entry.why}${entry.late ? " [déjà dû]" : ""}`)
    },
    depenses_estimees: `${dh(result.outflows)} (${dh(result.perDay)} par jour, rythme des ${result.pastDays} derniers jours)`,
    solde_prevu_fin: dh(result.closing),
    point_bas: `${dh(result.lowest.balance)} le ${frenchDay(result.lowest.day)}`,
    ...(result.firstNegative ? { alerte: `Trésorerie négative à partir du ${frenchDay(result.firstNegative)} si les encaissements n'arrivent pas plus tôt.` } : {}),
    ...(result.undated.length > 0 ? { non_comptes: `BC n° ${result.undated.join(", ")} : pas de date de livraison prévue au carnet (ou montant illisible), leur versement avant livraison n'est pas daté et n'est pas compté.` } : {}),
    hypotheses: `échéancier standard (${STANDARD_PLAN_LABEL.replace(/\.$/, "")}) pour chaque commande ; le dernier versement n'est compté qu'une fois la commande installée ; les dépenses suivent le rythme récent. C'est une prévision, pas un engagement : un client qui paie en retard ou une grosse dépense prévue la change.`
  };
}

function label(category) {
  return category === "confidentiel" ? "Confidentiel" : CASH_CATEGORIES.sortie[category] ?? category;
}

function period(from, to) {
  return `du ${frenchDay(from)} au ${frenchDay(to)}`;
}

function pct(part, whole) {
  return whole > 0 ? `${Math.round((part / whole) * 1000) / 10} %` : "—";
}

function dh(value) {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value).replace(/ | /g, " ")} DH`;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
