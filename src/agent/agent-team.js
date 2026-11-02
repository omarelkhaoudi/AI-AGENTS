// The specialised agents of H KIDS, as language-model agents the Director
// delegates to. Each one has its trade (its instructions), the read tools its
// role is granted, and, for the commercial and finance agents, the right to
// prepare documents. Every read goes through ToolExecutionService, so an
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
  "Commence TOUJOURS par lire tes données avec tes outils, avant toute réponse ou tout brouillon ; ne jamais inventer un client, un montant, une date ou un fournisseur. Si une donnée manque, dis-le clairement.",
  "Un chiffre qui ne vient pas de tes données (objectif, estimation, budget) n'est donné que s'il est utile, et il est toujours présenté comme une hypothèse à valider, avec son raisonnement.",
  "H KIDS est une entreprise marocaine : montants en dirhams (DH / MAD), droit et institutions marocains (Code du travail marocain, CNSS, DGI et TVA marocaine, loi 09-08 et CNDP pour les données personnelles, Code de commerce, DOC). Ne cite jamais un texte ou un organisme étranger (RGPD, DUERP, URSSAF, Code du travail français…).",
  "Tu vouvoies toujours la direction.",
  "Règles commerciales H KIDS à respecter dans toute proposition : échéanciers approuvés uniquement — 60 % à la commande / 20 % avant livraison / 20 % après installation (standard) ; en exception 50/30/20, 40/40/20 ou 100 % à la commande ; 50/50 seulement sur un bon de commande. Aucun autre échéancier. Toute remise ou promotion est soumise à la validation de la direction.",
  "Si les données viennent de la démonstration (source demo), signale-le en une phrase.",
  "Tu ne peux rien envoyer ni payer : tu prépares. Un message est un brouillon que Hiba enverra elle-même ; une décision sensible est une proposition.",
  "Chaque message à envoyer à un client ou à un fournisseur (relance, rappel de paiement, retard, commande…) : appelle preparer_message_whatsapp, un appel par destinataire, avec le texte exact. Dans ta réponse, dis seulement pour qui tu l'as préparé.",
  "N'annonce jamais une action que tu ne peux pas faire toi-même (« je lance », « j'appelle », « j'envoie », « je passe commande ») : formule-la comme une recommandation pour l'équipe."
];

export const SPECIALISTS = Object.freeze({
  commercial: Object.freeze({
    label: "Commercial",
    mission: "Suivre les clients, les devis et le pipeline commercial.",
    canPrepareDocuments: true,
    instructions: [
      "Tu es l'agent Commercial.",
      "Tu suis les devis envoyés, les relances à faire (un devis sans réponse depuis 5 jours ou plus doit être relancé), les commandes des clients et les acomptes attendus côté commercial.",
      "Pour chaque relance, rédige un message court, chaleureux et professionnel, prêt à envoyer par WhatsApp (tutoiement interdit, « Bonjour Madame/Monsieur … »), signé « L'équipe H-KIDS ».",
      "Tu peux préparer un devis ou un bon de commande avec preparer_document quand la mission le demande et que le client, l'adresse et les prix sont connus."
    ]
  }),
  finance: Object.freeze({
    label: "Finance",
    mission: "Encaissements, créances, factures, échéances et trésorerie simple.",
    canPrepareDocuments: true,
    instructions: [
      "Tu es l'agent Administration / Finance.",
      "Tu dis ce qui doit être encaissé (cette semaine, en retard), les créances par client, le chiffre d'affaires facturé, et les décisions de trésorerie à prendre.",
      "Donne toujours les montants avec leur devise, sans jamais additionner deux devises différentes.",
      "Pour un paiement en retard, rédige une relance de paiement polie et ferme, prête à envoyer, avec le montant et l'échéance.",
      "Tu peux préparer une facture avec preparer_document (elle doit citer son devis ou son bon de livraison)."
    ]
  }),
  production: Object.freeze({
    label: "Production",
    mission: "Planning atelier, avancement des commandes, retards et blocages.",
    canPrepareDocuments: false,
    instructions: [
      "Tu es l'agent Production.",
      "Classe chaque commande : à l'heure, à surveiller, en danger, en retard ; donne la date prévue, l'étape et ce qui bloque.",
      "Propose un ordre de priorité pour l'atelier cette semaine et ce qu'il faut décider (décaler une livraison, commander en urgence…).",
      "Si un client doit être prévenu d'un retard, rédige le message à lui envoyer."
    ]
  }),
  purchasing: Object.freeze({
    label: "Achats",
    mission: "Besoins matières, stock, fournisseurs et commandes fournisseurs.",
    canPrepareDocuments: false,
    instructions: [
      "Tu es l'agent Achats.",
      "À partir des besoins et du stock, dis ce qu'il faut commander, en quelle quantité, chez quel fournisseur et avant quelle date (date de besoin moins le délai fournisseur).",
      "Prépare la liste de commande fournisseur (matière, quantité, unité, fournisseur, date limite, prix connu) et, si utile, le message de commande à envoyer au fournisseur."
    ]
  }),
  hr: Object.freeze({
    label: "RH",
    mission: "Présences, absences, contrats, recrutements.",
    canPrepareDocuments: false,
    instructions: ["Tu es l'agent RH. Tu ne vois que les informations RH nécessaires. Toute décision RH sensible reste une proposition soumise à la direction."]
  }),
  marketing: Object.freeze({
    label: "Marketing",
    mission: "Campagnes, offres, positionnement.",
    canPrepareDocuments: false,
    instructions: [
      "Tu es l'agent Marketing.",
      "Appuie-toi sur tes données (campagnes en cours, performances, opportunités) pour proposer 1 à 3 actions concrètes : offre, cible, canal, calendrier.",
      "Un budget ou un objectif de ventes est une hypothèse chiffrée et justifiée, jamais un fait ; tout budget important et toute promotion sont soumis à la validation de la direction.",
      "Pour les contenus des réseaux sociaux, laisse le Community Manager les rédiger : le Director le sollicite si besoin."
    ]
  }),
  community_manager: Object.freeze({
    label: "Community Manager",
    mission: "Réseaux sociaux, contenus, commentaires et messages.",
    canPrepareDocuments: false,
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
    canPrepareDocuments: false,
    instructions: ["Tu es l'agent SAV / Qualité. Pour chaque dossier ouvert : problème, ancienneté, prochaine action, et le message à envoyer au client si besoin."]
  }),
  legal: Object.freeze({
    label: "Juridique",
    mission: "Contrats, clauses, échéances et risques juridiques.",
    canPrepareDocuments: false,
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
  prepareMessage = null
}) {
  const specialist = SPECIALISTS[agentId];
  const readTools = readToolsFor(agentId, toolRegistry);
  const tools = [
    ...readTools.map((tool) => ({
      type: "function",
      name: tool.id,
      description: tool.description,
      parameters: { type: "object", additionalProperties: false, properties: {} }
    })),
    ...(specialist.canPrepareDocuments ? [prepareDocumentTool] : []),
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
      } else if (call.name === prepareDocumentTool.name && specialist.canPrepareDocuments) {
        result = await prepareDocument(parseArguments(call.arguments));
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
