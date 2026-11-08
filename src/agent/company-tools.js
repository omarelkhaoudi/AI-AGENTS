import { roundMoney } from "../documents/document-calculations.js";
import { HKIDS_DOCUMENT_TYPES } from "../documents/document-schema.js";
import { SPECIALISTS, SPECIALIST_IDS } from "./agent-team.js";
import { CASH_CATEGORIES, CASH_METHODS, CashBookError, OPENING_CATEGORY } from "./cash-book.js";
import { ANOMALY_STATUSES, ImprovementError, RULE_STATUSES, rulesInstruction } from "./improvement-book.js";
import { TeamBookError } from "./team-book.js";

// The tools of Hiba's three requests of 09/11/2026, as the Director and its
// agents call them: the cash book Finance keeps, the anomalies each head of
// trade analyses into a rule, and the people the agents are tied to. Each
// handler answers in the agents' words and never throws a book's own error:
// the agent reads what went wrong and says it.

const CATEGORY_KEYS = [...new Set([...Object.keys(CASH_CATEGORIES.entree), ...Object.keys(CASH_CATEGORIES.sortie), OPENING_CATEGORY])];
const OWNERS = [...SPECIALIST_IDS, "director"];

export const CASH_RECORD_TOOL = Object.freeze({
  type: "function",
  name: "enregistrer_mouvement_caisse",
  description: "Enregistre au journal de caisse UNE entrée ou sortie d'argent annoncée par la direction (acompte reçu, achat payé, salaire versé…). Seulement un fait rapporté, jamais une estimation ni un paiement attendu. Renvoie le mouvement enregistré et le bilan du jour.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      sens: { type: "string", enum: ["entree", "sortie"], description: "entree = argent reçu ; sortie = argent payé." },
      montant: { type: "number", description: "Montant en dirhams, positif." },
      categorie: {
        type: "string",
        enum: CATEGORY_KEYS,
        description: [
          ...Object.entries(CASH_CATEGORIES.entree).map(([key, label]) => `${key} = ${label} (entrée)`),
          ...Object.entries(CASH_CATEGORIES.sortie).map(([key, label]) => `${key} = ${label} (sortie)`),
          `${OPENING_CATEGORY} = solde de départ de la caisse, quand la direction donne ce qu'il y a au départ (entrée)`
        ].join(" ; ")
      },
      libelle: { type: "string", description: "Ce que c'est, en quelques mots : « Acompte 60 % lit cabane », « Laque blanche 5 L »." },
      moyen: { type: "string", enum: Object.keys(CASH_METHODS), description: "Comment l'argent a circulé ; autre si non précisé." },
      tiers: { type: "string", description: "Qui a payé ou a été payé (client, fournisseur, salarié) ; chaîne vide si non précisé." },
      reference_devis: { type: "string", description: "Numéro du devis de la vente concernée ; chaîne vide sinon." },
      reference_bc: { type: "string", description: "Numéro du bon de commande concerné ; chaîne vide sinon." },
      date: { type: "string", description: "JJ/MM/AAAA seulement si le mouvement n'a pas eu lieu aujourd'hui ; chaîne vide sinon." },
      annonce_par: { type: "string", description: "Qui l'a annoncé (« Hiba », « Omar », « la direction »)." },
      confirme_doublon: { type: "boolean", description: "true seulement si la mission dit clairement que c'est un second paiement identique le même jour." }
    },
    required: ["sens", "montant", "categorie", "libelle", "moyen", "tiers", "reference_devis", "reference_bc", "date", "annonce_par", "confirme_doublon"]
  }
});

export const CASH_CANCEL_TOOL = Object.freeze({
  type: "function",
  name: "annuler_mouvement_caisse",
  description: "Annule un mouvement du journal de caisse enregistré par erreur. Il reste au journal, barré, avec la raison, et ne compte plus.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      numero: { type: "integer", description: "Le numéro du mouvement." },
      raison: { type: "string", description: "Pourquoi il est annulé." }
    },
    required: ["numero", "raison"]
  }
});

export const CASH_BALANCE_TOOL = Object.freeze({
  type: "function",
  name: "bilan_caisse",
  description: "Le bilan de caisse d'un jour (solde d'ouverture, entrées, sorties, solde de clôture, dont espèces et banque, et chaque mouvement) et le résumé du mois. À appeler pour « où en est la caisse », « bilan du jour », et pour tout point de situation.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      date: { type: "string", description: "JJ/MM/AAAA, ou chaîne vide pour aujourd'hui." },
      mois: { type: "string", description: "AAAA-MM, ou chaîne vide pour le mois de la date." }
    },
    required: ["date", "mois"]
  }
});

export const ANOMALIES_TOOL = Object.freeze({
  type: "function",
  name: "lister_anomalies",
  description: "Les anomalies de l'entreprise (étapes d'atelier bloquées ou en retard, problèmes signalés), leur cause quand elles sont analysées, et les règles d'amélioration : actives, à valider par la direction.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      statut: { type: "string", enum: ["ouvertes", "a_analyser", "analysee", "toutes"], description: "ouvertes = pas encore levées (par défaut)." }
    },
    required: ["statut"]
  }
});

export const ANALYSE_TOOL = Object.freeze({
  type: "function",
  name: "analyser_anomalie",
  description: "Enregistre la cause d'une anomalie et la règle qui empêchera qu'elle se reproduise. La règle est proposée à la direction et ne s'applique qu'une fois validée. Si une règle active couvre déjà la cause, la citer (regle_existante) : elle est alors marquée comme n'ayant pas suffi.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      anomalie: { type: "integer", description: "Numéro de l'anomalie." },
      cause: { type: "string", description: "La cause réelle, telle que les données la montrent." },
      regle_existante: { type: "integer", description: "Numéro d'une règle déjà active qui couvre cette cause ; 0 pour en proposer une nouvelle." },
      titre: { type: "string", description: "Nouvelle règle : son nom court (« Commander la laque à l'étude technique ») ; chaîne vide si regle_existante." },
      quand: { type: "string", description: "Nouvelle règle : quand elle s'applique (« à chaque BC avec finition laquée ») ; chaîne vide si regle_existante." },
      action: { type: "string", description: "Nouvelle règle : ce qui doit être fait, concrètement, et avant quand ; chaîne vide si regle_existante." },
      responsable: { type: "string", enum: OWNERS, description: "L'agent qui applique la règle." }
    },
    required: ["anomalie", "cause", "regle_existante", "titre", "quand", "action", "responsable"]
  }
});

export const REPORT_ANOMALY_TOOL = Object.freeze({
  type: "function",
  name: "signaler_anomalie",
  description: "Enregistre un problème que la direction rapporte (client mécontent, fournisseur en retard, erreur de livraison, paiement oublié…) pour qu'il soit analysé et ne se reproduise pas. Les retards et blocages du carnet d'atelier sont déjà détectés seuls.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      fait: { type: "string", description: "Ce qui s'est passé, précisément (qui, quoi, quand)." },
      domaine: { type: "string", enum: ["atelier", "achats", "commercial", "finance", "sav", "autre"] },
      numero_bc: { type: "string", description: "Bon de commande concerné ; chaîne vide sinon." },
      responsable: { type: "string", enum: OWNERS, description: "L'agent responsable du domaine, qui analysera." }
    },
    required: ["fait", "domaine", "numero_bc", "responsable"]
  }
});

export const LINK_MEMBER_TOOL = Object.freeze({
  type: "function",
  name: "relier_responsable",
  description: "Relie un agent à la vraie personne de l'équipe qui en est responsable (« Youssef, le chef d'atelier, s'occupe de la production, son numéro est 06… ») : elle recevra les tâches de cet agent par WhatsApp et lui rendra compte. Nom vide pour défaire le lien.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      agent: { type: "string", enum: SPECIALIST_IDS, description: SPECIALIST_IDS.map((id) => `${id} = ${SPECIALISTS[id].label}`).join(" ; ") },
      nom: { type: "string" },
      role: { type: "string", description: "Sa fonction (« chef d'atelier ») ; chaîne vide si non dite." },
      telephone: { type: "string", description: "Son numéro WhatsApp tel que donné ; chaîne vide si non donné. Ne jamais l'inventer." }
    },
    required: ["agent", "nom", "role", "telephone"]
  }
});

// The cash tools Finance is given; the balance alone for the Director.
export function cashTools(context, agentId) {
  return [
    { tool: CASH_RECORD_TOOL, run: (args) => recordCash(args, context, agentId) },
    { tool: CASH_CANCEL_TOOL, run: (args) => cancelCash(args, context, agentId) },
    { tool: CASH_BALANCE_TOOL, run: (args) => cashBalance(args, context) }
  ];
}

export function improvementTools(context, agentId) {
  return [
    { tool: ANOMALIES_TOOL, run: (args) => listAnomalies(args, context) },
    { tool: ANALYSE_TOOL, run: (args) => analyseAnomaly(args, context, agentId) }
  ];
}

export async function recordCash(args, { books, documentService }, by) {
  const { cash, team } = books;
  try {
    const entry = await cash.record({
      kind: args.sens,
      amount: args.montant,
      category: text(args.categorie),
      label: text(args.libelle),
      method: text(args.moyen),
      party: text(args.tiers),
      quoteNumber: text(args.reference_devis),
      orderNumber: text(args.reference_bc),
      day: text(args.date),
      announcedBy: text(args.annonce_par) || "direction",
      by,
      confirmDuplicate: args.confirme_doublon === true
    });
    await team.log({
      agent: SPECIALISTS[by] ? by : "finance",
      kind: "caisse",
      text: `${entry.kind === "entree" ? "Entrée" : "Sortie"} n° ${entry.number} : ${formatDh(entry.amount)} — ${entry.label}${entry.party ? ` (${entry.party})` : ""}, annoncée par ${entry.announcedBy}.`,
      ref: `caisse:${entry.number}`,
      by
    });
    const sale = entry.kind === "entree" && (entry.quoteNumber || entry.orderNumber) ? await saleCollection(entry, { cash, documentService }) : null;
    return {
      ok: true,
      enregistre: {
        numero: entry.number,
        date: frenchDay(entry.day),
        sens: entry.kind,
        montant: entry.amount,
        libelle: entry.label,
        moyen: CASH_METHODS[entry.method],
        tiers: entry.party || null
      },
      ...(sale ? { vente: sale } : {}),
      bilan_du_jour: describeDay(await cash.day(entry.day))
    };
  } catch (error) {
    return bookError(error);
  }
}

// What a sale has brought in so far, against what it is worth.
async function saleCollection(entry, { cash, documentService }) {
  const collected = await cash.collectedFor({ quoteNumber: entry.quoteNumber, orderNumber: entry.orderNumber });
  const dossier = entry.quoteNumber
    ? await documentService.dossier?.(HKIDS_DOCUMENT_TYPES.QUOTE, entry.quoteNumber)
    : await documentService.dossier?.(HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER, entry.orderNumber);
  const worth = dossier?.ceiling ?? null;
  return {
    reference: entry.quoteNumber ? `devis n° ${entry.quoteNumber}` : `BC n° ${entry.orderNumber}`,
    encaisse_sur_cette_vente: collected.total,
    montant_de_la_vente: worth ?? "inconnu (document non généré par le cockpit)",
    reste_a_encaisser: worth === null ? "inconnu" : roundMoney(worth - collected.total)
  };
}

export async function cancelCash(args, { books }, by) {
  try {
    const entry = await books.cash.cancel(String(args.numero), { reason: text(args.raison), by });
    await books.team.log({ agent: SPECIALISTS[by] ? by : "finance", kind: "caisse", text: `Mouvement n° ${entry.number} annulé : ${entry.cancelled.reason}.`, ref: `caisse:${entry.number}`, by });
    return { ok: true, annule: `n° ${entry.number} (${entry.label}, ${formatDh(entry.amount)})`, bilan_du_jour: describeDay(await books.cash.day(entry.day)) };
  } catch (error) {
    return bookError(error);
  }
}

export async function cashBalance(args, { books }) {
  try {
    const day = await books.cash.day(text(args.date));
    const month = await books.cash.month(text(args.mois) || day.day.slice(0, 7));
    return {
      ok: true,
      jour: describeDay(day),
      mois: {
        mois: month.month,
        solde_debut_de_mois: month.opening,
        entrees: month.totalIn,
        sorties: month.totalOut,
        resultat: month.net,
        solde_fin: month.closing,
        par_categorie: month.byCategory.map((entry) => `${entry.kind === "entree" ? "+" : "−"} ${entry.label} : ${formatDh(entry.amount)} (${entry.count})`)
      },
      devise: "MAD",
      ...(day.entries.length === 0 && month.days.length === 0 ? { info: "Aucun mouvement au journal de caisse pour cette période." } : {})
    };
  } catch (error) {
    return bookError(error);
  }
}

function describeDay(day) {
  return {
    date: frenchDay(day.day),
    solde_ouverture: day.opening,
    ...(day.carriedIn > 0 ? { solde_de_depart_saisi: day.carriedIn } : {}),
    entrees: day.totalIn,
    sorties: day.totalOut,
    solde_cloture: day.closing,
    dont_especes: day.closingCash,
    dont_banque: day.closingBank,
    mouvements: day.entries.map((entry) => `n° ${entry.number} ${entry.kind === "entree" ? "+" : "−"} ${formatDh(entry.amount)} ${entry.label}${entry.party ? ` (${entry.party})` : ""} · ${entry.methodLabel}${entry.cancelled ? ` — ANNULÉ : ${entry.cancelled.reason}` : ""}`)
  };
}

export async function listAnomalies(args, { books }) {
  const { anomalies, rules } = await books.improvement.state();
  const wanted = {
    ouvertes: (entry) => entry.status !== "levee",
    a_analyser: (entry) => entry.status === "a_analyser",
    analysee: (entry) => entry.status === "analysee",
    toutes: () => true
  }[args.statut] ?? ((entry) => entry.status !== "levee");
  return {
    ok: true,
    anomalies: anomalies.filter(wanted).slice(-20).map(describeAnomaly),
    regles_actives: rules.filter((rule) => rule.status === "active").map(describeRule),
    regles_a_valider: rules.filter((rule) => rule.status === "proposee").map(describeRule)
  };
}

export function describeAnomaly(anomaly) {
  return {
    numero: anomaly.number,
    statut: ANOMALY_STATUSES[anomaly.status],
    fait: anomaly.fact,
    bc: anomaly.orderNumber || null,
    responsable: anomaly.owner,
    detectee_le: frenchDay(anomaly.detectedAt.slice(0, 10)),
    cause: anomaly.cause ?? null,
    regle: anomaly.rule ?? null
  };
}

function describeRule(rule) {
  return {
    numero: rule.number,
    titre: rule.title,
    quand: rule.trigger || null,
    action: rule.action,
    responsable: rule.owner,
    statut: RULE_STATUSES[rule.status],
    anomalies: rule.anomalies,
    ...(rule.recurrences?.length > 0 ? { revenue_malgre_la_regle: rule.recurrences.length } : {})
  };
}

export async function analyseAnomaly(args, { books }, by) {
  try {
    const { anomalies } = await books.improvement.state();
    const anomaly = anomalies.find((entry) => entry.number === Number(args.anomalie));
    if (anomaly?.status === "analysee" && anomaly.rule) {
      return { ok: false, erreur: `L'anomalie n° ${anomaly.number} est déjà analysée (règle n° ${anomaly.rule}) : rien à refaire.` };
    }
    const existing = Number(args.regle_existante) > 0 ? String(args.regle_existante) : "";
    const { rule } = await books.improvement.analyse(String(args.anomalie), {
      cause: text(args.cause),
      existingRule: existing,
      rule: existing ? null : { title: text(args.titre), trigger: text(args.quand), action: text(args.action), owner: OWNERS.includes(args.responsable) ? args.responsable : by },
      by
    });
    await books.team.log({
      agent: by,
      kind: "amelioration",
      text: `Anomalie n° ${args.anomalie} analysée : ${text(args.cause)}`,
      detail: existing ? `Relève de la règle n° ${rule.number} « ${rule.title} ».` : `Règle n° ${rule.number} proposée : « ${rule.title} » — ${rule.action}`,
      ref: `anomalie:${args.anomalie}`,
      by
    });
    return {
      ok: true,
      regle: describeRule(rule),
      statut: rule.status === "proposee"
        ? "Règle proposée : elle attend la validation de la direction dans le cockpit (Amélioration) avant de s'appliquer."
        : rule.status === "active" ? "La règle était déjà active et n'a pas suffi : propose à la direction de la renforcer." : `Règle ${RULE_STATUSES[rule.status]}.`
    };
  } catch (error) {
    return bookError(error);
  }
}

export async function reportAnomaly(args, { books }, by) {
  try {
    const anomaly = await books.improvement.report({ fact: text(args.fait), area: text(args.domaine), orderNumber: text(args.numero_bc), agent: OWNERS.includes(args.responsable) ? args.responsable : "director", by });
    await books.team.log({ agent: anomaly.owner, kind: "amelioration", text: `Anomalie n° ${anomaly.number} signalée : ${anomaly.fact}`, ref: `anomalie:${anomaly.number}`, by });
    return { ok: true, anomalie: describeAnomaly(anomaly), suite: `Confie l'analyse à ${anomaly.owner} (deleguer_a_un_agent) : cause et règle, avec analyser_anomalie.` };
  } catch (error) {
    return bookError(error);
  }
}

export async function linkMember(args, { books }, by) {
  try {
    const member = await books.team.link(text(args.agent), { name: text(args.nom), role: text(args.role), phone: text(args.telephone), by });
    return member
      ? { ok: true, agent: SPECIALISTS[args.agent]?.label, responsable: member.name, role: member.role || null, whatsapp: member.phone || "pas de numéro : les messages de tâche seront à compléter" }
      : { ok: true, agent: SPECIALISTS[args.agent]?.label, responsable: "aucun : le lien est défait" };
  } catch (error) {
    return bookError(error);
  }
}

// What an agent is told before a mission: the person it answers to, what the
// rest of the team did lately, and the rules the direction validated for it.
export async function agentBriefing(agentId, { books }) {
  const [member, news, rules] = await Promise.all([books.team.member(agentId), books.team.newsFor(agentId), books.improvement.activeRules(agentId)]);
  return [
    member
      ? `Ton responsable humain dans l'équipe H KIDS : ${member.name}${member.role ? ` (${member.role})` : ""}${member.phone ? `, WhatsApp ${member.phone}` : ", numéro non renseigné"}. Il reçoit les tâches de ton métier et rend compte à la direction : adresse-lui les messages de tâche (destinataire « ${member.name} »${member.phone ? `, téléphone ${member.phone}` : ""}).`
      : "",
    news.length > 0
      ? ["Ce que le reste de l'équipe a fait ces derniers jours (pour rester cohérent et ne rien refaire) :", ...news.map(newsLine)].join("\n")
      : "",
    rulesInstruction(rules)
  ].filter(Boolean);
}

// The Director's own: who is behind each agent, every rule in force, and the
// rules waiting for the direction.
export async function directorBriefing({ books }) {
  const [members, rules, state] = await Promise.all([books.team.members(), books.improvement.activeRules("director"), books.improvement.state()]);
  const linked = Object.entries(members).filter(([agent]) => SPECIALISTS[agent]);
  const waiting = state.rules.filter((rule) => rule.status === "proposee").length;
  const toAnalyse = state.anomalies.filter((anomaly) => anomaly.status === "a_analyser").length;
  return [
    linked.length > 0
      ? `Responsables humains reliés aux agents : ${linked.map(([agent, member]) => `${SPECIALISTS[agent].label} → ${member.name}${member.role ? ` (${member.role})` : ""}`).join(" ; ")}.`
      : "Aucun agent n'est encore relié à une personne de l'équipe.",
    rulesInstruction(rules),
    waiting > 0 ? `${waiting} règle(s) d'amélioration attendent la validation de la direction (vue Amélioration du cockpit).` : "",
    toAnalyse > 0 ? `${toAnalyse} anomalie(s) restent à analyser (lister_anomalies).` : ""
  ].filter(Boolean);
}

function newsLine(entry) {
  const label = entry.agent === "director" ? "Director" : SPECIALISTS[entry.agent]?.label ?? entry.agent;
  return `- ${frenchStamp(entry.at)} ${label} : ${entry.text}${entry.detail ? ` → ${entry.detail.slice(0, 220)}` : ""}`;
}

function bookError(error) {
  if (error instanceof CashBookError || error instanceof ImprovementError || error instanceof TeamBookError) {
    return { ok: false, erreur: error.message };
  }
  throw error;
}

function frenchStamp(iso) {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: "Africa/Casablanca", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

function frenchDay(iso) {
  const [year, month, day] = String(iso ?? "").split("-");
  return day ? `${day}/${month}/${year}` : "";
}

function formatDh(value) {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value).replace(/ /g, " ")} DH`;
}

function text(value) {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}
