import { randomUUID } from "node:crypto";
import { calculateDocumentTotals, roundMoney } from "../documents/document-calculations.js";
import { HKIDS_DOCUMENT_TYPES } from "../documents/document-schema.js";
import { DocumentValidationError } from "../documents/document-validation.js";
import { HKIDS_FIXED_IDENTITY } from "../documents/hkids-template.js";
import { createCatalogueLoader, searchCatalogue } from "./catalogue.js";

// The Director as a conversational agent. Hiba writes the way she would to an
// assistant — "fais-moi un devis pour Meriem, un lit nuage à 3000 DH" — and a
// language model reads the request, asks for what is missing, and calls the
// tools below to prepare the document itself. Nothing leaves the company and
// nothing is generated for good without her: a document comes back as a preview
// she validates in the cockpit, through the same preview and confirmation the
// documents panel always required.
//
// The model only ever chooses and fills tools. Every figure is computed here and
// every document is validated by the same rules as a document typed by hand.

export const DEFAULT_AGENT_MODEL = "gpt-5";
const MAX_TOOL_ROUNDS = 6;
const MAX_CONVERSATION_ITEMS = 60;
const TVA_RATE = 0.2;

const DOCUMENT_TYPES = Object.freeze({
  devis: HKIDS_DOCUMENT_TYPES.QUOTE,
  bon_de_commande: HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER,
  facture: HKIDS_DOCUMENT_TYPES.INVOICE,
  bon_de_livraison: HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE
});

const PAYMENT_RULES = Object.freeze({
  "60/20/20": "hkids-60-20-20-2026",
  "50/50": "hkids-po-50-50"
});

const TOOLS = Object.freeze([
  {
    type: "function",
    name: "preparer_document",
    description: "Prépare un document commercial H-KIDS (devis, bon de commande, facture ou bon de livraison) et renvoie son aperçu. Le document n'est généré qu'après validation par l'utilisatrice dans le cockpit. N'appeler que lorsque le client (nom et adresse) et chaque ligne (désignation, quantité, prix) sont connus.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: Object.keys(DOCUMENT_TYPES), description: "Le document à préparer." },
        client_nom: { type: "string", description: "Nom du client, tel que donné." },
        client_adresse: { type: "string", description: "Adresse du client (au minimum la ville). Ne jamais l'inventer." },
        objet: { type: "string", description: "Objet court, par exemple « Lit nuage » ou « Aménagement chambre enfant ». Chaîne vide si aucun." },
        lignes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              designation: { type: "string" },
              quantite: { type: "number" },
              prix_unitaire: { type: "number", description: "Prix unitaire en dirhams." },
              prix_ttc: { type: "boolean", description: "true si le prix donné est TTC (cas par défaut quand l'utilisatrice ne précise pas), false s'il est HT." }
            },
            required: ["designation", "quantite", "prix_unitaire", "prix_ttc"]
          }
        },
        caracteristiques: { type: "array", items: { type: "string" }, description: "Finitions, coloris, dimensions… (bon de commande surtout). Liste vide si aucune." },
        conditions_paiement: { type: "string", enum: Object.keys(PAYMENT_RULES), description: "60/20/20 par défaut ; 50/50 seulement pour un bon de commande." },
        reference_devis: { type: "string", description: "Numéro du devis lié (facture, bon de livraison). Chaîne vide si aucun." },
        reference_bl: { type: "string", description: "Numéro du bon de livraison lié (facture). Chaîne vide si aucun." },
        numero: { type: "string", description: "Numéro imposé par l'utilisatrice. Chaîne vide pour prendre le prochain numéro libre." }
      },
      required: ["type", "client_nom", "client_adresse", "objet", "lignes", "caracteristiques", "conditions_paiement", "reference_devis", "reference_bl", "numero"]
    }
  },
  {
    type: "function",
    name: "chercher_catalogue",
    description: "Cherche un ou plusieurs produits dans le catalogue H-KIDS et renvoie leur nom exact, leur description et leur prix TTC de base. À appeler pour chaque produit demandé dont le prix n'a pas été donné.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        recherche: { type: "string", description: "Le produit tel que nommé par l'utilisatrice, par exemple « lit nuage »." }
      },
      required: ["recherche"]
    }
  },
  {
    type: "function",
    name: "point_entreprise",
    description: "Interroge l'équipe d'agents (commercial, finance, production, achats, RH, marketing, SAV, juridique) et renvoie la situation : ce qui va bien, retards, encaissements, achats, risques, décisions. À utiliser pour toute question sur l'état de l'entreprise.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        question: { type: "string", description: "La question telle que posée par l'utilisatrice." }
      },
      required: ["question"]
    }
  }
]);

function instructions(today) {
  return [
    "Tu es le Director IA de H KIDS, fabricant marocain de mobilier et d'aménagement sur mesure pour enfants (Marrakech).",
    `Tu parles à la direction (Hiba, Omar). Nous sommes le ${today}. Réponds toujours en français, de façon courte, claire et chaleureuse.`,
    "",
    "Ton rôle : faire le travail à la place de l'utilisatrice. Quand elle demande un devis, un bon de commande, une facture ou un bon de livraison, c'est toi qui le prépares avec l'outil preparer_document. Elle ne remplit aucun formulaire.",
    "",
    "Règles :",
    "- Un prix donné sans précision est TTC (prix_ttc = true). « 3000 DH » ou « 3000dhs » = 3000 DH TTC.",
    "- Prix non donné : appelle chercher_catalogue pour ce produit. Un seul produit correspond → utilise son nom exact (désignation) et son prix TTC, et précise dans ta réponse que c'est le prix catalogue. Plusieurs correspondent → demande lequel en les citant avec leur prix. Aucun → demande le prix. Un prix donné par l'utilisatrice l'emporte toujours sur le catalogue.",
    "- Ne jamais inventer un client, une adresse, un prix ou une quantité. Si le nom ou l'adresse du client (au moins la ville) manque, ou si un prix manque et n'est pas au catalogue, pose UNE question courte qui demande tout ce qui manque, puis attends la réponse.",
    "- Quantité non précisée = 1.",
    "- Conditions de paiement : 60/20/20 par défaut (60 % à la commande, 20 % avant livraison, 20 % après installation). 50/50 seulement pour un bon de commande et si on te le demande.",
    "- Une facture doit citer son devis ou son bon de livraison : demande le numéro s'il n'est pas donné.",
    "- Le numéro du document est attribué automatiquement ; ne le demande que si l'outil dit qu'il est inconnu.",
    "- Après preparer_document : annonce le document (type, numéro, client, total TTC, échéances le cas échéant) en 2 ou 3 lignes, puis dis de vérifier l'aperçu et de cliquer « Valider et générer ». Ne prétends jamais qu'il est déjà envoyé au client.",
    "- Si l'outil renvoie des erreurs, explique simplement ce qui manque et demande-le.",
    "- Pour toute question sur la situation de l'entreprise (point du jour, urgences, encaissements, retards, achats, relances…), appelle point_entreprise puis résume l'essentiel en 5 lignes maximum, les urgences d'abord.",
    "- Pour une simple salutation ou une question générale, réponds directement sans outil.",
    "",
    `Informations société : ${HKIDS_FIXED_IDENTITY.companyName}, ${HKIDS_FIXED_IDENTITY.addressLines.join(" ").replace(/^Adresse : /, "")}, tél. ${HKIDS_FIXED_IDENTITY.phone}, ${HKIDS_FIXED_IDENTITY.email}. TVA 20 %.`
  ].join("\n");
}

export class DirectorAgentError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "DirectorAgentError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export function createDirectorAgentFromEnv({ env = process.env, documentService, runDirectorRequest, client = null } = {}) {
  const apiKey = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  const model = typeof env.OPENAI_MODEL === "string" && env.OPENAI_MODEL.trim() !== "" ? env.OPENAI_MODEL.trim() : DEFAULT_AGENT_MODEL;
  const cataloguePath = typeof env.HKIDS_CATALOGUE_PATH === "string" && env.HKIDS_CATALOGUE_PATH.trim() !== "" ? env.HKIDS_CATALOGUE_PATH.trim() : undefined;
  const loadCatalogue = createCatalogueLoader(cataloguePath ? { path: cataloguePath } : {});
  return createDirectorAgent({ apiKey, model, documentService, runDirectorRequest, client, loadCatalogue });
}

export function createDirectorAgent({
  apiKey = "",
  model = DEFAULT_AGENT_MODEL,
  client = null,
  documentService,
  runDirectorRequest,
  loadCatalogue = async () => ({ available: false, catalogue: [] }),
  clock = () => new Date(),
  clientFactory = defaultClientFactory
} = {}) {
  const conversations = new Map();
  let resolvedClient = client;

  return Object.freeze({
    model,
    isConfigured() {
      return Boolean(client) || apiKey !== "";
    },

    async chat({ message, conversationId = null, userId = null } = {}) {
      const text = typeof message === "string" ? message.trim() : "";
      if (text === "") {
        throw new DirectorAgentError("Le message est vide.", "AGENT_MESSAGE_EMPTY");
      }
      if (!this.isConfigured()) {
        throw new DirectorAgentError("L'agent IA n'est pas configuré : renseignez OPENAI_API_KEY dans .env.", "AGENT_NOT_CONFIGURED");
      }
      resolvedClient ??= await clientFactory({ apiKey });

      const id = conversationId && conversations.has(conversationId) ? conversationId : randomUUID();
      const items = conversations.get(id) ?? [];
      items.push({ role: "user", content: text });

      const outcome = { documents: [], directorResponse: null };
      let reply = "";
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        const response = await callModel(resolvedClient, {
          model,
          instructions: instructions(formatDate(clock())),
          input: items,
          tools: TOOLS
        });
        const output = Array.isArray(response.output) ? response.output : [];
        items.push(...output);
        const calls = output.filter((item) => item.type === "function_call");
        if (calls.length === 0 || round === MAX_TOOL_ROUNDS) {
          reply = outputText(response);
          break;
        }
        for (const call of calls) {
          const result = await runTool(call, { documentService, runDirectorRequest, loadCatalogue, clock, userId, outcome });
          items.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
        }
      }

      conversations.set(id, items.slice(-MAX_CONVERSATION_ITEMS));
      return Object.freeze({
        conversationId: id,
        reply: reply || "Je n'ai pas pu formuler de réponse. Pouvez-vous reformuler ?",
        documents: Object.freeze(outcome.documents),
        directorResponse: outcome.directorResponse
      });
    }
  });
}

async function defaultClientFactory({ apiKey }) {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey });
}

async function callModel(client, payload) {
  try {
    return await client.responses.create(payload);
  } catch (cause) {
    const status = cause?.status ?? null;
    const message = status === 401
      ? "La clé OpenAI est refusée : vérifiez OPENAI_API_KEY dans .env."
      : status === 429
        ? "Le compte OpenAI n'a plus de crédit ou est limité pour le moment."
        : "Le service OpenAI n'a pas répondu. Réessayez dans un instant.";
    throw new DirectorAgentError(message, "AGENT_MODEL_UNAVAILABLE", { status });
  }
}

function outputText(response) {
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

async function runTool(call, context) {
  let args;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return { ok: false, erreur: "Arguments illisibles." };
  }
  try {
    if (call.name === "preparer_document") {
      return await prepareDocument(args, context);
    }
    if (call.name === "chercher_catalogue") {
      return await lookUpCatalogue(args, context);
    }
    if (call.name === "point_entreprise") {
      return await companyPoint(args, context);
    }
    return { ok: false, erreur: `Outil inconnu : ${call.name}` };
  } catch (error) {
    return { ok: false, erreur: error.message };
  }
}

// Builds the document exactly as the documents panel would send it, then asks
// the document service for the same preview a person would get.
async function prepareDocument(args, { documentService, clock, outcome }) {
  const documentType = DOCUMENT_TYPES[args.type];
  if (!documentType) {
    return { ok: false, erreur: "Type de document inconnu." };
  }

  const purchaseOrder = documentType === HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER;
  const termsRule = PAYMENT_RULES[args.conditions_paiement] ?? PAYMENT_RULES["60/20/20"];
  if (termsRule === PAYMENT_RULES["50/50"] && !purchaseOrder) {
    return { ok: false, erreur: "Le 50/50 n'est possible que sur un bon de commande. Utiliser 60/20/20." };
  }

  const number = text(args.numero) || await documentService.nextDocumentNumber(documentType);
  if (!number) {
    return { ok: false, erreur: `Aucun numéro connu pour ce type de document : demander à l'utilisatrice le numéro à utiliser.` };
  }

  const items = (Array.isArray(args.lignes) ? args.lignes : []).map((line) => {
    const price = Number(line.prix_unitaire);
    const unitPriceHt = line.prix_ttc === false ? roundMoney(price) : roundMoney(price / (1 + TVA_RATE));
    return {
      designation: text(line.designation),
      unit: "U",
      quantity: Number(line.quantite) || 1,
      unitPriceHt
    };
  });
  const calculated = calculateDocumentTotals(items, TVA_RATE);

  const input = {
    documentType,
    documentNumber: number,
    date: formatDate(clock()),
    object: text(args.objet),
    client: { name: text(args.client_nom), address: text(args.client_adresse) },
    items: calculated.items.map((item) => ({ designation: item.designation, unit: item.unit, quantity: item.quantity, unitPriceHt: item.unitPriceHt, amountHt: item.amountHt })),
    totals: { totalHt: calculated.totals.totalHt, tva: calculated.totals.tva, totalTtc: calculated.totals.totalTtc },
    payment: purchaseOrder ? { termsRule } : { method: "virement bancaire", termsRule },
    ...(purchaseOrder ? { specifications: (args.caracteristiques ?? []).map(text).filter(Boolean) } : {}),
    ...(text(args.reference_devis) ? { quoteReference: text(args.reference_devis) } : {}),
    ...(text(args.reference_bl) ? { deliveryNoteReference: text(args.reference_bl) } : {})
  };

  let preview;
  try {
    preview = await documentService.preview(input);
  } catch (error) {
    if (error instanceof DocumentValidationError) {
      return { ok: false, erreurs: error.errors.map((entry) => `${entry.field} : ${entry.message}`) };
    }
    if (error?.code === "PURCHASE_ORDER_NUMBER_USED") {
      return { ok: false, erreur: `Le numéro ${error.details.documentNumber} est déjà pris ; prochain libre : ${error.details.nextNumber}.` };
    }
    throw error;
  }

  outcome.documents.push(Object.freeze({ input, preview }));
  const document = preview.document;
  return {
    ok: true,
    type: args.type,
    numero: document.documentNumber,
    client: document.client.name,
    total_ht: document.totals.totalHt,
    tva: document.totals.tva,
    total_ttc: document.totals.totalTtc,
    echeances: (document.payment?.instalments ?? []).map((part) => `${part.percent} % ${part.due} : ${part.amount} DH`),
    conditions: document.payment?.terms ?? null,
    statut: "Aperçu prêt : l'utilisatrice doit cliquer « Valider et générer » dans le cockpit."
  };
}

async function lookUpCatalogue(args, { loadCatalogue }) {
  const { available, catalogue } = await loadCatalogue();
  if (!available || catalogue.length === 0) {
    return { ok: false, erreur: "Le catalogue H-KIDS n'est pas encore renseigné : demander le prix à l'utilisatrice." };
  }
  const matches = searchCatalogue(catalogue, text(args.recherche));
  if (matches.length === 0) {
    return { ok: true, produits: [], remarque: "Aucun produit du catalogue ne correspond : demander le prix." };
  }
  return {
    ok: true,
    produits: matches.map((entry) => ({
      reference: entry.reference || null,
      produit: entry.name,
      description: entry.description || null,
      prix_ttc: entry.priceTtc,
      unite: entry.unit,
      remarque: entry.note || null
    }))
  };
}

async function companyPoint(args, { runDirectorRequest, userId, outcome }) {
  if (typeof runDirectorRequest !== "function") {
    return { ok: false, erreur: "Le point entreprise n'est pas disponible." };
  }
  const response = await runDirectorRequest({ message: text(args.question) || "Fais-moi le point sur mon entreprise aujourd'hui.", userId });
  outcome.directorResponse = response;
  const sections = response.summary?.minimumSections ?? {};
  return {
    ok: true,
    titre: response.summary?.headline ?? null,
    source_des_donnees: [...new Set((response.summary?.domainSources ?? []).map((entry) => entry.dataSource).filter(Boolean))],
    rubriques: Object.fromEntries(Object.entries(sections)
      .filter(([, entries]) => Array.isArray(entries) && entries.length > 0)
      .map(([key, entries]) => [key, entries.slice(0, 5).map((entry) => entry.label ?? entry.reason ?? "")]))
  };
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatDate(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}
