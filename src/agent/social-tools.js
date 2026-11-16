import { PROSPECT_STATUSES } from "./social-inbox.js";

// The agents' hands on the Facebook Page and the Instagram account (CDC V2,
// section 7): the Community Manager reads what people wrote, prepares the
// answers and the prospect sheets and hands the prospects to the Commercial;
// Marketing prepares the posts and reads the figures. Nothing they do is sent:
// the replies and the posts go to « À valider », and the direction's word sends
// them.

const PLATFORM = { instagram: "Instagram", facebook: "Facebook" };

const INBOX_TOOL = Object.freeze({
  type: "function",
  name: "boite_reseaux",
  description: "Lit les messages privés et les commentaires reçus sur la Page Facebook et le compte Instagram de H-KIDS, du plus récent au plus ancien, avec l'identifiant de chacun (pour y répondre ou en faire une fiche prospect) et les réponses déjà proposées.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      statut: { type: "string", enum: ["a_traiter", "reponse_a_valider", "repondu", "tous"], description: "a_traiter : ce qui attend une réponse ; tous : tout." }
    },
    required: ["statut"]
  }
});

const REPLY_TOOL = Object.freeze({
  type: "function",
  name: "preparer_reponse_reseaux",
  description: "Prépare la réponse à un message privé ou à un commentaire Instagram / Facebook. La réponse n'est PAS envoyée : elle part dans « À valider » du cockpit et n'est envoyée qu'après l'accord de la direction. Un message privé ne peut recevoir de réponse que dans les 24 heures qui suivent le dernier message de la personne (règle de Meta). Ne promets ni prix, ni délai, ni remise que la direction n'a pas donnés ; une demande de devis se traite par une fiche prospect.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      message_id: { type: "string", description: "Identifiant du message ou du commentaire, lu dans boite_reseaux." },
      reponse: { type: "string", description: "Le texte exact à envoyer, en français (ou dans la langue de la personne), chaleureux et professionnel. 1000 caractères au plus sur Instagram en message privé." }
    },
    required: ["message_id", "reponse"]
  }
});

const PROSPECT_TOOL = Object.freeze({
  type: "function",
  name: "fiche_prospect",
  description: "Crée ou complète la fiche d'un prospect venu des réseaux sociaux (numérotée P-001, P-002…), ou change son statut. Ne remplis que ce que la personne a vraiment dit ; laisse vide le reste.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      prospect: { type: "string", description: "Numéro de la fiche à compléter (P-001…) ; vide pour en créer une." },
      message_id: { type: "string", description: "Message ou commentaire d'où vient le prospect (boite_reseaux) ; vide sinon." },
      nom: { type: "string" },
      compte: { type: "string", description: "Son compte Instagram (@…) ou son nom Facebook." },
      reseau: { type: "string", enum: ["instagram", "facebook", ""] },
      telephone: { type: "string" },
      ville: { type: "string" },
      besoin: { type: "string", description: "Ce qu'il veut : meuble, pièce, nombre d'enfants, dimensions, délai…" },
      produit: { type: "string", description: "Produit H-KIDS visé, s'il en cite un." },
      budget: { type: "string" },
      statut: { type: "string", enum: ["", ...PROSPECT_STATUSES], description: "nouveau, qualifie (besoin clair), transmis (au Commercial), devis (devis fait), gagne, perdu. Vide pour ne pas le changer." },
      notes: { type: "string", description: "Ce qu'il faut savoir de plus, ou la raison du changement de statut." }
    },
    required: ["prospect", "message_id", "nom", "compte", "reseau", "telephone", "ville", "besoin", "produit", "budget", "statut", "notes"]
  }
});

const HAND_OVER_TOOL = Object.freeze({
  type: "function",
  name: "transmettre_prospect",
  description: "Transmet une fiche prospect qualifiée au Commercial, qui prépare le devis. Le besoin doit être renseigné.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      prospect: { type: "string", description: "Numéro de la fiche (P-001…)." },
      note: { type: "string", description: "Ce que le Commercial doit savoir pour son devis." }
    },
    required: ["prospect", "note"]
  }
});

const PROSPECTS_TOOL = Object.freeze({
  type: "function",
  name: "prospects_reseaux",
  description: "Liste les fiches prospects venues d'Instagram et de Facebook, avec leur besoin, leur statut et leur historique.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      statut: { type: "string", enum: ["", ...PROSPECT_STATUSES], description: "Vide pour toutes." }
    },
    required: ["statut"]
  }
});

const PUBLICATION_TOOL = Object.freeze({
  type: "function",
  name: "preparer_publication",
  description: "Prépare une publication Instagram ou Facebook pour un jour et une heure (heure du Maroc). Elle n'est PAS publiée : elle part dans « À valider » du cockpit et ne sera publiée, à l'heure prévue, qu'après l'accord de la direction. Instagram exige une photo à une adresse publique https (JPEG) ; si tu n'en as pas, propose Facebook ou demande la photo.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      reseau: { type: "string", enum: ["instagram", "facebook"] },
      texte: { type: "string", description: "Le texte de la publication, sans les hashtags." },
      hashtags: { type: "array", items: { type: "string" }, description: "Hashtags sans le #." },
      date: { type: "string", description: "JJ/MM/AAAA" },
      heure: { type: "string", description: "HH:MM, heure du Maroc" },
      image_url: { type: "string", description: "Adresse publique https de la photo ; vide si aucune (Facebook seulement)." }
    },
    required: ["reseau", "texte", "hashtags", "date", "heure", "image_url"]
  }
});

const STATS_TOOL = Object.freeze({
  type: "function",
  name: "statistiques_reseaux",
  description: "Chiffres réels des comptes Facebook et Instagram de H-KIDS (abonnés, dernières publications avec likes, réactions et commentaires) et ce qui attend dans le cockpit (messages à traiter, prospects).",
  parameters: { type: "object", additionalProperties: false, properties: {}, required: [] }
});

export const SOCIAL_TOOL_NAMES = Object.freeze([INBOX_TOOL, REPLY_TOOL, PROSPECT_TOOL, HAND_OVER_TOOL, PROSPECTS_TOOL, PUBLICATION_TOOL, STATS_TOOL].map((tool) => tool.name));

// Who holds which tool: the CM all of them, Marketing the posts, the figures
// and the prospects, the Commercial the prospects it turns into quotes.
export function socialTools({ social }, agentId) {
  const tools = {
    inbox: { tool: INBOX_TOOL, run: (args) => readInbox(social, args) },
    reply: { tool: REPLY_TOOL, run: (args) => guard(() => prepareReply(social, args, agentId)) },
    prospect: { tool: PROSPECT_TOOL, run: (args) => guard(() => saveProspect(social, args, agentId)) },
    handOver: { tool: HAND_OVER_TOOL, run: (args) => guard(() => handOver(social, args, agentId)) },
    prospects: { tool: PROSPECTS_TOOL, run: (args) => listProspects(social, args) },
    publication: { tool: PUBLICATION_TOOL, run: (args) => guard(() => preparePublication(social, args, agentId)) },
    stats: { tool: STATS_TOOL, run: () => guard(() => social.overview()) }
  };
  const byAgent = {
    community_manager: ["inbox", "reply", "prospect", "handOver", "prospects", "publication", "stats"],
    marketing: ["publication", "stats", "prospects"],
    commercial: ["prospects", "prospect"]
  };
  return (byAgent[agentId] ?? []).map((key) => tools[key]);
}

async function guard(run) {
  try {
    return await run();
  } catch (error) {
    return { ok: false, erreur: error.message };
  }
}

async function readInbox(social, { statut }) {
  const items = await social.inbox({ status: statut === "tous" ? "" : statut, limit: 30 });
  const replies = await social.replies({ limit: 200 });
  return {
    ok: true,
    connecte: social.status().connecte,
    messages: items.map((item) => ({
      id: item.id,
      reseau: PLATFORM[item.platform],
      type: item.kind === "comment" ? "commentaire public" : "message privé",
      de: item.senderName || "abonné",
      recu_le: item.at,
      texte: item.text || "(pièce jointe)",
      ...(item.attachments?.length ? { pieces_jointes: item.attachments } : {}),
      statut: item.status,
      ...(item.prospect ? { fiche_prospect: item.prospect } : {}),
      reponses: replies.filter((reply) => reply.itemId === item.id).map((reply) => ({ texte: reply.text, statut: reply.status, ...(reply.error ? { erreur: reply.error } : {}) }))
    })),
    ...(items.length === 0 ? { note: "Aucun message dans ce statut." } : {})
  };
}

async function prepareReply(social, args, agentId) {
  await social.proposeReply({ itemId: text(args.message_id), text: args.reponse, by: agentId });
  return { ok: true, statut: "Réponse placée dans « À valider » : elle sera envoyée quand la direction l'approuvera." };
}

async function saveProspect(social, args, agentId) {
  const fields = {};
  for (const key of ["nom", "compte", "reseau", "telephone", "ville", "besoin", "produit", "budget"]) {
    fields[key] = text(args[key]);
  }
  const prospect = await social.upsertProspect({ id: text(args.prospect), itemId: text(args.message_id), fields, status: text(args.statut), by: agentId, note: text(args.notes) });
  return { ok: true, fiche: describeProspect(prospect) };
}

async function handOver(social, args, agentId) {
  const prospect = await social.handOver({ id: text(args.prospect), note: text(args.note), by: agentId });
  return { ok: true, statut: `Fiche ${prospect.id} transmise au Commercial.`, fiche: describeProspect(prospect) };
}

async function listProspects(social, { statut }) {
  const prospects = await social.prospects({ status: text(statut) });
  return { ok: true, prospects: prospects.map(describeProspect), ...(prospects.length === 0 ? { note: "Aucune fiche prospect." } : {}) };
}

async function preparePublication(social, args, agentId) {
  const day = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text(args.date));
  const date = day ? `${day[3]}-${day[2].padStart(2, "0")}-${day[1].padStart(2, "0")}` : text(args.date);
  const { publication } = await social.proposePublication({
    channel: text(args.reseau),
    caption: args.texte,
    hashtags: Array.isArray(args.hashtags) ? args.hashtags : [],
    date,
    time: text(args.heure),
    imageUrl: text(args.image_url),
    by: agentId
  });
  return {
    ok: true,
    statut: `Publication ${PLATFORM[publication.channel]} placée dans « À valider » : elle sera publiée à l'heure prévue après l'accord de la direction.`,
    ...(social.status().connecte ? {} : { attention: "Facebook / Instagram ne sont pas encore reliés au cockpit : une fois validée, elle attendra le branchement." })
  };
}

function describeProspect(prospect) {
  return {
    numero: prospect.id,
    statut: prospect.status,
    ...Object.fromEntries(["nom", "compte", "reseau", "telephone", "ville", "besoin", "produit", "budget", "notes"].filter((key) => prospect[key]).map((key) => [key, prospect[key]])),
    historique: prospect.history.map((entry) => `${entry.at.slice(0, 10)} ${entry.status}${entry.note ? ` : ${entry.note}` : ""} (${entry.by})`)
  };
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
