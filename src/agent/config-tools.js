// The two tools every agent has from its settings (CDC V2, section 9): its
// reference documents, searched with their source and version, and its
// working memory.

const DOCUMENTS_TOOL = Object.freeze({
  type: "function",
  name: "documents_reference",
  description: "Cherche dans TES documents de référence importés par la direction (catalogue, tarifs, procédures, fiches techniques, conditions) et renvoie les passages utiles avec leur source : titre, version, date. Seules les versions en vigueur sont lues, sauf si tu demandes l'historique. Une version périmée n'est jamais appliquée : elle sert seulement à expliquer un changement.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      recherche: { type: "string", description: "Les mots à chercher : produit, dimension, procédure, sujet…" },
      inclure_anciens: { type: "boolean", description: "true pour lire aussi les versions périmées (historique)." }
    },
    required: ["recherche", "inclure_anciens"]
  }
});

const MEMORY_TOOL = Object.freeze({
  type: "function",
  name: "memoriser",
  description: "Garde une note de travail pour tes prochaines missions : une préférence de la direction, un fait durable appris en mission, un dossier à reprendre. Pas de donnée sensible (salaire, santé) ni de chose que tes outils retrouvent déjà. Une phrase, datée automatiquement.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: { note: { type: "string" } },
    required: ["note"]
  }
});

export function configTools({ agentConfig }, agentId) {
  return [
    { tool: DOCUMENTS_TOOL, run: (args) => searchDocuments(agentConfig, agentId, args) },
    { tool: MEMORY_TOOL, run: (args) => remember(agentConfig, agentId, args) }
  ];
}

async function searchDocuments(agentConfig, agentId, { recherche, inclure_anciens: history }) {
  const documents = await agentConfig.documents(agentId);
  if (documents.length === 0) {
    return { ok: true, passages: [], note: "La direction ne t'a confié aucun document de référence : je n'ai pas l'information dans tes documents." };
  }
  const found = await agentConfig.search(agentId, String(recherche ?? ""), { includeRetired: history === true });
  return {
    ok: true,
    passages: found.map(({ document, passage }) => ({
      source: `« ${document.title} », version ${document.version}${document.validFrom ? `, en vigueur depuis le ${document.validFrom}` : ""}`,
      statut: document.status === "en_vigueur" ? "en vigueur" : "PÉRIMÉ : ne pas appliquer",
      texte: passage
    })),
    ...(found.length === 0 ? { note: "Rien de tel dans tes documents : n'invente pas, dis que l'information manque." } : {})
  };
}

async function remember(agentConfig, agentId, { note }) {
  try {
    await agentConfig.remember(agentId, note);
    return { ok: true, statut: "Note gardée pour tes prochaines missions." };
  } catch (error) {
    return { ok: false, erreur: error.message };
  }
}
