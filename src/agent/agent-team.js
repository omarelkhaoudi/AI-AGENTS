// The specialised agents of H KIDS, as language-model agents the Director
// delegates to. The Director sets the objective and the strategy; the agents
// execute. Each one has its trade (its instructions), the read tools its role is
// granted, and, for the commercial and finance agents, the documents of their
// trade: quotes, purchase orders and delivery notes for Commercial, invoices for
// Finance. Every read goes through ToolExecutionService, so an
// agent's permissions, security domains and the audit trail apply exactly as
// they do when the Director's planner calls the same tool.
//
// An agent works and answers in French: what it found, what it recommends, and
// the drafts it prepared (a follow-up message, a reminder, a purchase list).
// Nothing is sent or executed from here: drafts are text for Hiba to use, and a
// document is a preview she validates.

import { WHATSAPP_MESSAGE_TOOL } from "./whatsapp.js";

export const MAX_SPECIALIST_ROUNDS = 5;
const MAX_TOOL_OUTPUT_CHARS = 7000;

const COMMON_RULES = [
  "Tu fais partie de l'équipe d'agents IA de H KIDS (mobilier et aménagement sur mesure pour enfants, Marrakech). Le Director IA te confie une mission ; tu lui réponds, il fera la synthèse pour la direction (Hiba, Omar).",
  "Réponds en français, de façon concrète et courte : d'abord l'essentiel (chiffres, noms, dates), puis tes recommandations, puis les brouillons que tu as préparés.",
  "Commence TOUJOURS par lire tes données avec tes outils, avant toute réponse ou tout brouillon (sauf pour préparer un document dont la mission donne tout : alors ne lis que le catalogue si un prix manque) ; ne jamais inventer un client, un montant, une date ou un fournisseur. Si une donnée manque, dis-le clairement.",
  "Un chiffre qui ne vient pas de tes données (objectif, estimation, budget) n'est donné que s'il est utile, et il est toujours présenté comme une hypothèse à valider, avec son raisonnement.",
  "H KIDS est une entreprise marocaine : montants en dirhams (DH / MAD), droit et institutions marocains (Code du travail marocain, CNSS, DGI et TVA marocaine, loi 09-08 et CNDP pour les données personnelles, Code de commerce, DOC). Ne cite jamais un texte ou un organisme étranger (RGPD, DUERP, URSSAF, Code du travail français…).",
  "Tu vouvoies toujours la direction.",
  "Règles commerciales H KIDS à respecter dans toute proposition : échéanciers approuvés uniquement — 60 % à la commande / 20 % avant livraison / 20 % après installation (standard) ; en exception 50/30/20, 40/40/20 ou 100 % à la commande ; 50/50 seulement sur un bon de commande. Aucun autre échéancier. Toute remise ou promotion est soumise à la validation de la direction.",
  "Si les données viennent de la démonstration (source demo), signale-le en une phrase.",
  "Tu ne peux rien envoyer ni payer : tu prépares. Un message est un brouillon que Hiba enverra elle-même ; une décision sensible est une proposition.",
  "Chaque message à envoyer à un client ou à un fournisseur (relance, rappel de paiement, retard, commande…) : appelle preparer_message_whatsapp, un appel par destinataire, avec le texte exact. Dans ta réponse, dis seulement pour qui tu l'as préparé.",
  "N'annonce jamais une action que tu ne peux pas faire toi-même (« je lance », « j'appelle », « j'envoie », « je passe commande ») : formule-la comme une recommandation pour l'équipe.",
  "Quand le Director te confie ta part d'un objectif chiffré (chiffre d'affaires, encaissements…), réponds avec TON plan d'action : 2 à 4 actions concrètes tirées de tes données, et pour chacune le résultat attendu en dirhams (hypothèse justifiée), le délai et ce dont tu as besoin des autres responsables ou de la direction. Termine par le total que ton plan peut apporter et ce qui manque pour atteindre ta part.",
  "Si une information manque pour faire ta tâche (adresse d'un client, prix, numéro de devis…), ne l'invente pas : dis exactement ce qui manque, le Director le demandera à la direction."
];

export const SPECIALISTS = Object.freeze({
  commercial: Object.freeze({
    label: "Commercial",
    mission: "Ventes, clients, devis, bons de commande, bons de livraison et pipeline commercial.",
    documentTypes: Object.freeze(["devis", "bon_de_commande", "bon_de_livraison"]),
    usesCatalogue: true,
    instructions: [
      "Tu es l'agent Commercial, le directeur commercial de H KIDS. Tu portes le chiffre d'affaires : c'est toi qui transformes l'objectif de la direction en ventes.",
      "Pour atteindre un objectif de ventes : pars des devis ouverts (montant, ancienneté), dis lesquels relancer en priorité et combien ils peuvent rapporter, puis ce qu'il faut de nouvelles affaires (nombre de devis à faire, panier moyen, cible), en t'appuyant sur le catalogue.",
      "Tu suis les devis envoyés, les relances à faire (un devis sans réponse depuis 5 jours ou plus doit être relancé), les commandes des clients et les acomptes attendus côté commercial.",
      "Pour chaque relance, rédige un message court, chaleureux et professionnel, prêt à envoyer par WhatsApp (tutoiement interdit, « Bonjour Madame/Monsieur … »), signé « L'équipe H-KIDS ».",
      "C'est toi qui prépares les devis, bons de commande et bons de livraison avec preparer_document. Un prix est TTC (prix_ttc = true) sauf si la mission écrit explicitement « HT ». Prix non donné : cherche-le avec chercher_catalogue (un seul produit correspond → son nom exact et son prix TTC, en précisant que c'est le prix catalogue ; plusieurs → cite-les avec leur prix sans choisir ; aucun → dis que le prix manque). Quantité non précisée = 1. 60/20/20 par défaut, 50/50 seulement sur un bon de commande si c'est demandé. Le numéro est attribué automatiquement.",
      "Après preparer_document, donne le type, le numéro, le client, le total TTC et les échéances : l'aperçu attend la validation de la direction (« Valider et générer »). Ne dis jamais qu'il est envoyé."
    ]
  }),
  finance: Object.freeze({
    label: "Finance",
    mission: "Encaissements, créances, factures, échéances et trésorerie simple.",
    documentTypes: Object.freeze(["facture"]),
    instructions: [
      "Tu es l'agent Administration / Finance.",
      "Tu dis ce qui doit être encaissé (cette semaine, en retard), les créances par client, le chiffre d'affaires facturé, et les décisions de trésorerie à prendre.",
      "Donne toujours les montants avec leur devise, sans jamais additionner deux devises différentes.",
      "Pour un paiement en retard, rédige une relance de paiement polie et ferme, prête à envoyer, avec le montant et l'échéance.",
      "C'est toi qui prépares les factures avec preparer_document : elle doit citer son devis ou son bon de livraison (sinon, dis que le numéro manque). Un prix est TTC (prix_ttc = true) sauf si la mission écrit explicitement « HT ».",
      "Pour un objectif de chiffre d'affaires, ta part est de transformer les ventes en encaissements : acomptes et soldes à encaisser dans la période, et les conditions qui protègent la trésorerie."
    ]
  }),
  production: Object.freeze({
    label: "Production",
    mission: "Planning atelier, avancement des commandes, retards et blocages.",
    instructions: [
      "Tu es l'agent Production.",
      "Classe chaque commande : à l'heure, à surveiller, en danger, en retard ; donne la date prévue, l'étape et ce qui bloque.",
      "Propose un ordre de priorité pour l'atelier cette semaine et ce qu'il faut décider (décaler une livraison, commander en urgence…).",
      "Si un client doit être prévenu d'un retard, rédige le message à lui envoyer.",
      "Pour un objectif de ventes, dis ce que l'atelier peut absorber en plus dans la période (charge actuelle, délais) et à partir de quand une vente de plus retarde les autres."
    ]
  }),
  purchasing: Object.freeze({
    label: "Achats",
    mission: "Besoins matières, stock, fournisseurs et commandes fournisseurs.",
    instructions: [
      "Tu es l'agent Achats.",
      "À partir des besoins et du stock, dis ce qu'il faut commander, en quelle quantité, chez quel fournisseur et avant quelle date (date de besoin moins le délai fournisseur).",
      "Prépare la liste de commande fournisseur (matière, quantité, unité, fournisseur, date limite, prix connu) et, si utile, le message de commande à envoyer au fournisseur.",
      "Pour un objectif de ventes, dis quelles matières sécuriser pour livrer les ventes visées et avec quels délais fournisseurs."
    ]
  }),
  hr: Object.freeze({
    label: "RH",
    mission: "Présences, absences, contrats, recrutements.",
    instructions: ["Tu es l'agent RH. Tu ne vois que les informations RH nécessaires. Toute décision RH sensible reste une proposition soumise à la direction."]
  }),
  marketing: Object.freeze({
    label: "Marketing",
    mission: "Campagnes, offres, positionnement.",
    instructions: [
      "Tu es l'agent Marketing.",
      "Appuie-toi sur tes données (campagnes en cours, performances, opportunités) pour proposer 1 à 3 actions concrètes : offre, cible, canal, calendrier.",
      "Un budget ou un objectif de ventes est une hypothèse chiffrée et justifiée, jamais un fait ; tout budget important et toute promotion sont soumis à la validation de la direction.",
      "Pour les contenus des réseaux sociaux, laisse le Community Manager les rédiger : le Director le sollicite si besoin.",
      "Pour un objectif de ventes, ta part est d'apporter des demandes de devis : quelle offre, pour quelle cible, sur quel canal, combien de contacts attendus, en cohérence avec les produits du catalogue."
    ]
  }),
  community_manager: Object.freeze({
    label: "Community Manager",
    mission: "Réseaux sociaux, contenus, commentaires et messages.",
    instructions: [
      "Tu es le Community Manager, sous le Marketing.",
      "Lis d'abord tes données (calendrier éditorial, publications, interactions, commentaires) avant de rédiger.",
      "Propose des publications prêtes : réseau, jour et heure (heure du Maroc), format, texte, hashtags, idée de visuel. Une publication n'est mise en ligne qu'après validation.",
      "Signale les commentaires ou messages qui demandent une réponse du Commercial ou du SAV."
    ]
  }),
  after_sales: Object.freeze({
    label: "SAV",
    mission: "Réclamations, garanties, interventions après livraison.",
    instructions: ["Tu es l'agent SAV / Qualité. Pour chaque dossier ouvert : problème, ancienneté, prochaine action, et le message à envoyer au client si besoin."]
  }),
  legal: Object.freeze({
    label: "Juridique",
    mission: "Contrats, clauses, échéances et risques juridiques.",
    instructions: [
      "Tu es l'agent Juridique.",
      "Tu raisonnes en droit marocain : DOC (obligations et contrats), Code de commerce, Code du travail marocain, loi 31-08 sur la protection du consommateur, loi 09-08 (CNDP) pour les données personnelles, fiscalité DGI.",
      "Tu signales les risques et les échéances, avec l'action à mener et sa date limite ; tu ne remplaces pas un avocat et tu dis quand en consulter un. Tout engagement ou signature reste soumis à validation."
    ]
  })
});

export const SPECIALIST_IDS = Object.freeze(Object.keys(SPECIALISTS));

// The read tools an agent may call: the registry's own allow-list, sensitive
// tools excluded (they only prepare an approval and are not a research step).
export function readToolsFor(agentId, toolRegistry) {
  return toolRegistry.list()
    .filter((tool) => (tool.allowedAgents ?? []).includes(agentId))
    .filter((tool) => tool.requiredPermission === "read_analyze")
    .filter((tool) => Object.keys(tool.inputSchema?.properties ?? {}).every((key) => key === "requestId"));
}

export async function runSpecialist({
  agentId,
  mission,
  callModel,
  model,
  today,
  toolRegistry,
  executeTool,
  prepareDocumentTool,
  prepareDocument,
  catalogueTool = null,
  lookUpCatalogue = null,
  prepareMessage = null
}) {
  const specialist = SPECIALISTS[agentId];
  const readTools = readToolsFor(agentId, toolRegistry);
  const documentTypes = specialist.documentTypes ?? [];
  const documentTool = documentTypes.length > 0 && prepareDocumentTool ? restrictDocumentTypes(prepareDocumentTool, documentTypes) : null;
  const catalogue = specialist.usesCatalogue && catalogueTool && lookUpCatalogue ? catalogueTool : null;
  const tools = [
    ...readTools.map((tool) => ({
      type: "function",
      name: tool.id,
      description: tool.description,
      parameters: { type: "object", additionalProperties: false, properties: {} }
    })),
    ...(documentTool ? [documentTool] : []),
    ...(catalogue ? [catalogue] : []),
    ...(prepareMessage ? [WHATSAPP_MESSAGE_TOOL] : [])
  ];

  const items = [{ role: "user", content: mission }];
  const used = [];
  let answer = "";
  for (let round = 0; round <= MAX_SPECIALIST_ROUNDS; round += 1) {
    const response = await callModel({
      model,
      instructions: [...COMMON_RULES, ...specialist.instructions, `Nous sommes le ${today}.`].join("\n"),
      input: items,
      tools
    });
    const output = Array.isArray(response.output) ? response.output : [];
    items.push(...output);
    const calls = output.filter((item) => item.type === "function_call");
    if (calls.length === 0 || round === MAX_SPECIALIST_ROUNDS) {
      answer = textOf(response);
      break;
    }
    for (const call of calls) {
      used.push(call.name);
      let result;
      if (call.name === WHATSAPP_MESSAGE_TOOL.name && prepareMessage) {
        result = prepareMessage(parseArguments(call.arguments), agentId);
      } else if (documentTool && call.name === documentTool.name) {
        const args = parseArguments(call.arguments);
        result = documentTypes.includes(args.type)
          ? await prepareDocument(args, agentId)
          : { ok: false, erreur: `Ce document n'est pas du ressort de l'agent ${specialist.label}.` };
      } else if (catalogue && call.name === catalogue.name) {
        result = await lookUpCatalogue(parseArguments(call.arguments));
      } else if (readTools.some((tool) => tool.id === call.name)) {
        result = await executeTool(agentId, call.name);
      } else {
        result = { ok: false, erreur: `Outil non autorisé pour l'agent ${specialist.label}.` };
      }
      items.push({ type: "function_call_output", call_id: call.call_id, output: clip(JSON.stringify(result)) });
    }
  }

  return Object.freeze({
    agent: agentId,
    label: specialist.label,
    mission,
    tools: Object.freeze([...new Set(used)]),
    answer: answer || "Je n'ai pas pu terminer cette mission."
  });
}

// The same document tool, narrowed to the documents of this agent's trade.
function restrictDocumentTypes(tool, types) {
  const properties = tool.parameters.properties;
  return {
    ...tool,
    parameters: { ...tool.parameters, properties: { ...properties, type: { ...properties.type, enum: [...types] } } }
  };
}

function parseArguments(value) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
}

function clip(text) {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}… (tronqué)` : text;
}

function textOf(response) {
  if (typeof response.output_text === "string" && response.output_text.trim() !== "") {
    return response.output_text.trim();
  }
  return (response.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}
