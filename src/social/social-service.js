import { randomUUID } from "node:crypto";
import { MAX_CAPTION_LENGTH, MAX_COMMENT_REPLY_LENGTH, MAX_MESSAGE_LENGTH, SOCIAL_PLATFORMS, parseMetaWebhook } from "../integrations/meta-social.js";
import { PRIVACY_MENTION } from "../company/company-profile.js";
import { instantOfLocalSlot, localSlotOf } from "./publication-calendar.js";
import { createPublication, markPublicationFailed, markPublicationPublished, prepareAndSubmitPublication, schedulePublication } from "./publication-service.js";

// The company's Facebook Page and Instagram account, worked by the agents under
// the direction's eye (CDC V2, section 7):
// - what people write comes in by the webhook and lands in the social inbox;
// - the Community Manager answers, qualifies the prospects and hands them to
//   the Commercial; Marketing prepares the posts;
// - nothing goes out on its own: every reply and every post is an approval in
//   the cockpit's « À valider », and only the direction's « Approuver » sends it.
// Without the Meta keys everything still works inside the cockpit (inbox,
// prospects, posts waiting for approval); only the sending waits.

export const SOCIAL_REPLY_ACTION = "reply_social_message";
const SOCIAL_CHANNELS = Object.freeze(["instagram", "facebook"]);

export class SocialServiceError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SocialServiceError";
    this.code = code;
  }
}

export function isSocialReplyApproval(approval) {
  return typeof approval?.metadata?.socialReplyId === "string" && approval.metadata.socialReplyId.length > 0;
}

export function createSocialService({ inbox, client = null, config = { configured: false, missing: [] }, repository, teamBook = null, clock = () => new Date(), privacyNotice = PRIVACY_MENTION }) {
  let publishing = null;

  // Law 09-08: a person who writes in private is told once, in the first
  // answer, who processes their data and where to exercise their rights. A
  // public comment is not the place for it; a refused or failed answer did not
  // reach them, so the next one carries it.
  async function firstPrivateAnswer(item) {
    if (item.kind === "comment" || !privacyNotice) {
      return false;
    }
    for (const earlier of await inbox.replies({ limit: 1000 })) {
      if (earlier.kind === "comment" || ["refusee", "echec"].includes(earlier.status)) {
        continue;
      }
      const other = earlier.itemId === item.id ? item : await inbox.item(earlier.itemId);
      if (other && other.platform === item.platform && other.senderId === item.senderId) {
        return false;
      }
    }
    return true;
  }

  async function log(entry) {
    try {
      await teamBook?.log(entry);
    } catch {
      // The feed is a courtesy to the other agents; it never blocks a send.
    }
  }

  const service = Object.freeze({
    connected: Boolean(client),

    status() {
      return {
        connecte: Boolean(client),
        instagram: Boolean(client?.instagram),
        manquant: [...(config.missing ?? [])]
      };
    },

    // A webhook call from Meta, already authenticated by its signature.
    async receive(body) {
      const added = await inbox.record(parseMetaWebhook(body, config));
      for (const item of added) {
        await log({
          agent: "community_manager",
          kind: "reseaux",
          text: `${SOCIAL_PLATFORMS[item.platform]} — ${item.kind === "comment" ? "commentaire" : "message"} de ${item.senderName || "un abonné"} : ${item.text || "(pièce jointe)"}`,
          ref: item.id,
          by: "meta"
        });
      }
      return added;
    },

    inbox: (filters) => inbox.list(filters),
    item: (id) => inbox.item(id),
    replies: (filters) => inbox.replies(filters),
    prospects: (filters) => inbox.prospects(filters),
    prospect: (id) => inbox.prospect(id),

    // The CM's answer to a message or a comment, put in « À valider ».
    async proposeReply({ itemId, text, by = "community_manager" }) {
      const item = await inbox.item(itemId);
      if (!item) {
        throw new SocialServiceError(`Message inconnu : ${itemId}.`, "SOCIAL_ITEM_NOT_FOUND");
      }
      const written = typeof text === "string" ? text.trim() : "";
      const limit = item.kind === "comment" ? MAX_COMMENT_REPLY_LENGTH : MAX_MESSAGE_LENGTH[item.platform];
      if (!written) {
        throw new SocialServiceError("La réponse est vide.", "SOCIAL_REPLY_EMPTY");
      }
      const body = !written.includes(privacyNotice) && await firstPrivateAnswer(item) ? `${written}\n\n${privacyNotice}` : written;
      if (body.length > limit) {
        throw new SocialServiceError(`La réponse dépasse ${limit} caractères (${body.length}).`, "SOCIAL_REPLY_TOO_LONG");
      }
      if (item.status === "reponse_a_valider") {
        throw new SocialServiceError("Une réponse à ce message attend déjà la validation de la direction.", "SOCIAL_REPLY_PENDING");
      }
      const approvalId = randomUUID();
      const reply = await inbox.addReply({ itemId, text: body, by, approvalId });
      const where = `${SOCIAL_PLATFORMS[item.platform]}, ${item.kind === "comment" ? "réponse publique sous un commentaire" : "message privé"}`;
      try {
        const approval = await repository.createApproval({
          id: approvalId,
          requestingAgent: by,
          requestedAction: SOCIAL_REPLY_ACTION,
          reason: `${where} à ${item.senderName || "un abonné"}.\nIl/elle a écrit : « ${item.text || "(pièce jointe)"} »\nRéponse proposée : « ${body} »`,
          affectedResource: `reseaux:${item.id}`,
          risk: item.kind === "comment" ? "high" : "medium",
          status: "pending",
          metadata: { socialReplyId: reply.id, platform: item.platform, kind: item.kind }
        });
        return { reply, approval };
      } catch (error) {
        await inbox.settleReply(reply.id, { status: "echec", error: "La demande de validation n'a pas pu être créée.", by });
        throw error;
      }
    },

    // The direction decided on a reply: approved, it is sent; refused, it is
    // dropped and the message waits for another answer.
    async decideReply(approval) {
      const reply = await inbox.reply(approval.metadata.socialReplyId);
      if (!reply || reply.status !== "a_valider") {
        return { reply, sent: false };
      }
      const by = approval.approverId ?? "direction";
      if (approval.status === "rejected") {
        return { reply: await inbox.settleReply(reply.id, { status: "refusee", by }), sent: false };
      }
      if (approval.status !== "approved") {
        return { reply, sent: false };
      }
      const item = await inbox.item(reply.itemId);
      if (!client) {
        const settled = await inbox.settleReply(reply.id, { status: "echec", error: "Facebook / Instagram ne sont pas encore reliés au cockpit (clés Meta absentes) : réponse à envoyer depuis l'application.", by });
        return { reply: settled, sent: false };
      }
      try {
        const externalId = item.kind === "comment"
          ? await client.replyToComment({ platform: item.platform, commentId: item.commentId, text: reply.text })
          : await client.sendMessage({ platform: item.platform, recipientId: item.senderId, text: reply.text });
        const settled = await inbox.settleReply(reply.id, { status: "envoyee", externalId, by });
        await log({ agent: "community_manager", kind: "reseaux", text: `Réponse envoyée sur ${SOCIAL_PLATFORMS[item.platform]} à ${item.senderName || "un abonné"} : ${reply.text}`, ref: item.id, by });
        return { reply: settled, sent: true };
      } catch (error) {
        const settled = await inbox.settleReply(reply.id, { status: "echec", error: error.message, by });
        return { reply: settled, sent: false, error: { code: error.code ?? "SOCIAL_SEND_FAILED", message: error.message } };
      }
    },

    // A prospect sheet, created or completed by the CM (or the Commercial,
    // who follows it up to the quote).
    async upsertProspect({ id = "", itemId = "", fields = {}, status = "", by, note = "" }) {
      if (itemId && !(await inbox.item(itemId))) {
        throw new SocialServiceError(`Message inconnu : ${itemId}.`, "SOCIAL_ITEM_NOT_FOUND");
      }
      const prospect = await inbox.upsertProspect({ id, itemId, fields, status, by, note });
      if (!prospect) {
        throw new SocialServiceError(`Prospect inconnu : ${id}.`, "SOCIAL_PROSPECT_NOT_FOUND");
      }
      if (!id) {
        await log({ agent: by, kind: "prospect", text: `Fiche prospect ${prospect.id} créée : ${prospect.nom || prospect.compte || "sans nom"}${prospect.besoin ? ` — ${prospect.besoin}` : ""}.`, ref: prospect.id, by });
      }
      return prospect;
    },

    // The CM hands a qualified prospect to the Commercial, who will see it in
    // its news before its next mission (and in prospects_reseaux).
    async handOver({ id, note = "", by = "community_manager" }) {
      const current = await inbox.prospect(id);
      if (!current) {
        throw new SocialServiceError(`Prospect inconnu : ${id}.`, "SOCIAL_PROSPECT_NOT_FOUND");
      }
      if (!current.besoin) {
        throw new SocialServiceError("Le besoin du prospect n'est pas renseigné : complétez la fiche avant de la transmettre.", "SOCIAL_PROSPECT_INCOMPLETE");
      }
      const prospect = await inbox.upsertProspect({ id, status: "transmis", by, note: note || "Transmis au Commercial pour devis." });
      // Written as the CM's entry: an agent's news are what the others did.
      await log({
        agent: by,
        kind: "prospect",
        text: `Prospect ${prospect.id} transmis au Commercial pour devis :${[prospect.nom || prospect.compte, prospect.ville, prospect.besoin, prospect.budget && `budget ${prospect.budget}`].filter(Boolean).join(" — ")}.`,
        detail: note,
        ref: prospect.id,
        by
      });
      return prospect;
    },

    // A post, put in « À valider » for a day and a time in Morocco. Instagram
    // only posts a picture, at a public https address Meta can fetch.
    async proposePublication({ channel, caption, hashtags = [], date, time, imageUrl = "", by = "marketing" }) {
      if (!SOCIAL_CHANNELS.includes(channel)) {
        throw new SocialServiceError(`Réseau non relié : ${channel}. Réseaux possibles : instagram, facebook.`, "SOCIAL_CHANNEL_UNSUPPORTED");
      }
      const text = typeof caption === "string" ? caption.trim() : "";
      if (!text) {
        throw new SocialServiceError("Le texte de la publication est vide.", "SOCIAL_CAPTION_EMPTY");
      }
      const tags = (Array.isArray(hashtags) ? hashtags : []).map((tag) => String(tag).trim()).filter(Boolean);
      const full = `${text}${tags.length ? `\n\n${tags.map((tag) => `#${tag.replace(/^#+/, "")}`).join(" ")}` : ""}`;
      if (full.length > MAX_CAPTION_LENGTH) {
        throw new SocialServiceError(`Le texte et les hashtags dépassent ${MAX_CAPTION_LENGTH} caractères.`, "SOCIAL_CAPTION_TOO_LONG");
      }
      const image = typeof imageUrl === "string" ? imageUrl.trim() : "";
      if (image && !/^https:\/\/\S+$/i.test(image)) {
        throw new SocialServiceError("La photo doit être à une adresse publique https://…", "SOCIAL_IMAGE_INVALID");
      }
      if (channel === "instagram" && !image) {
        throw new SocialServiceError("Instagram ne publie qu'avec une photo : donnez son adresse publique https://… (JPEG).", "SOCIAL_IMAGE_REQUIRED");
      }
      let scheduledAt;
      try {
        scheduledAt = instantOfLocalSlot(date, time);
      } catch (error) {
        throw new SocialServiceError(`${error.message} Format attendu : date AAAA-MM-JJ et heure HH:MM (heure du Maroc).`, "SOCIAL_SLOT_INVALID");
      }
      const draft = await createPublication(repository, { channel, caption: text, hashtags: tags, authorAgentId: by, metadata: { imageUrl: image || null } });
      const slot = localSlotOf(scheduledAt).replace("T", " à ");
      const { publication, approval } = await prepareAndSubmitPublication(repository, draft.id, {
        scheduledAt,
        now: clock().toISOString(),
        requestingAgent: by,
        risk: "high",
        reason: `Publication ${SOCIAL_PLATFORMS[channel]} prévue le ${slot} (heure du Maroc)${image ? `, avec la photo ${image}` : ", sans photo"}.\n« ${full} »`
      });
      await log({ agent: by, kind: "reseaux", text: `Publication ${SOCIAL_PLATFORMS[channel]} du ${slot} proposée à la direction.`, ref: publication.id, by });
      return { publication, approval };
    },

    // Sends the posts whose time has come: an approved post is scheduled,
    // a scheduled one is published once its time has come. A post Meta
    // refuses is marked failed with Meta's reason; scheduling it again is the
    // direction's call. Two calls never run at once.
    async publishDue(now = clock()) {
      if (!client) {
        return { published: [], failed: [] };
      }
      if (publishing) {
        return publishing;
      }
      publishing = (async () => {
        const published = [];
        const failed = [];
        for (const channel of SOCIAL_CHANNELS) {
          for (const publication of await repository.listPublications({ status: "approved", channel })) {
            await schedulePublication(repository, publication.id);
          }
          for (const publication of await repository.listPublications({ status: "scheduled", channel })) {
            if (!publication.scheduledAt || Date.parse(publication.scheduledAt) > now.getTime()) {
              continue;
            }
            const caption = `${publication.caption}${publication.hashtags.length ? `\n\n${publication.hashtags.map((tag) => `#${tag}`).join(" ")}` : ""}`;
            try {
              const externalId = await client.publish({ channel, caption, imageUrl: publication.metadata?.imageUrl ?? "" });
              published.push(await markPublicationPublished(repository, publication.id, { externalId, publishedAt: new Date().toISOString() }));
              await log({ agent: publication.authorAgentId || "marketing", kind: "reseaux", text: `Publié sur ${SOCIAL_PLATFORMS[channel]} : ${publication.caption.slice(0, 120)}`, ref: publication.id, by: "cockpit" });
            } catch (error) {
              failed.push(await markPublicationFailed(repository, publication.id, { code: error.code ?? "SOCIAL_PUBLISH_FAILED", message: error.message }));
              await log({ agent: publication.authorAgentId || "marketing", kind: "reseaux", text: `Publication ${SOCIAL_PLATFORMS[channel]} refusée par Meta : ${error.message}`, ref: publication.id, by: "cockpit" });
            }
          }
        }
        return { published, failed };
      })();
      try {
        return await publishing;
      } finally {
        publishing = null;
      }
    },

    // Followers and the last posts as Meta counts them, with what waits in
    // the cockpit.
    async overview() {
      const [waiting, prospects] = await Promise.all([inbox.list({ status: "a_traiter", limit: 1000 }), inbox.prospects({ limit: 1000 })]);
      const cockpit = {
        messages_a_traiter: waiting.length,
        prospects: prospects.length,
        prospects_par_statut: prospects.reduce((counts, prospect) => ({ ...counts, [prospect.status]: (counts[prospect.status] ?? 0) + 1 }), {})
      };
      if (!client) {
        return { connecte: false, cockpit, note: "Facebook / Instagram ne sont pas encore reliés : les chiffres des comptes arriveront une fois les clés Meta posées." };
      }
      return { connecte: true, cockpit, ...(await client.overview()) };
    }
  });
  return service;
}
