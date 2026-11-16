// The company's Facebook Page and Instagram professional account, through
// Meta's official Graph API (CDC V2, section 7): the conversations and the
// comments come in by webhook, the replies and the posts go out — each one only
// after the direction authorised it in the cockpit (see social-service.js).
//
// Instagram is reached through the Facebook Page it is linked to ("Instagram
// API with Facebook Login"): one Page access token serves both networks.
// - messages: POST /{page-id}/messages (Messenger and Instagram alike);
// - comments: an Instagram comment is answered on /{comment-id}/replies, a
//   Facebook one on /{comment-id}/comments;
// - posts: Instagram builds a container (/{ig-id}/media, a public JPEG) then
//   publishes it (/{ig-id}/media_publish); Facebook posts a photo
//   (/{page-id}/photos, url + caption) or a text (/{page-id}/feed, message).
// Meta lets a business answer a message within 24 hours of the person's last
// one; outside it the send is refused, and the cockpit says so.

const GRAPH = "https://graph.facebook.com";
const DEFAULT_API_VERSION = "v27.0";
// Meta's limits for the text of a message: 2000 characters on Messenger, 1000
// bytes on Instagram. A caption is held to Instagram's 2200 characters.
export const MAX_MESSAGE_LENGTH = Object.freeze({ facebook: 2000, instagram: 1000 });
export const MAX_COMMENT_REPLY_LENGTH = 2000;
export const MAX_CAPTION_LENGTH = 2200;
export const SOCIAL_PLATFORMS = Object.freeze({ instagram: "Instagram", facebook: "Facebook" });
// Meta's codes for a message sent outside the 24-hour window.
const OUTSIDE_WINDOW_SUBCODES = new Set([2018278, 2534022]);
const REQUIRED_KEYS = Object.freeze({
  pageId: "META_PAGE_ID",
  pageAccessToken: "META_PAGE_ACCESS_TOKEN",
  verifyToken: "META_VERIFY_TOKEN",
  appSecret: "META_APP_SECRET"
});

export class MetaSocialError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "MetaSocialError";
    this.code = code;
    this.details = details;
  }
}

// Read from .env. Without the app secret the webhook could not tell Meta's calls
// from anyone else's, so it stays closed. The Instagram account is optional:
// without it, only the Facebook Page is connected.
export function loadMetaSocialConfig(env = process.env) {
  const value = (name) => (typeof env[name] === "string" ? env[name].trim() : "");
  const config = {
    pageId: value("META_PAGE_ID"),
    pageAccessToken: value("META_PAGE_ACCESS_TOKEN"),
    instagramId: value("META_INSTAGRAM_ID"),
    verifyToken: value("META_VERIFY_TOKEN"),
    appSecret: value("META_APP_SECRET"),
    apiVersion: value("META_API_VERSION") || DEFAULT_API_VERSION
  };
  const missing = Object.entries(REQUIRED_KEYS).filter(([key]) => config[key] === "").map(([, name]) => name);
  return Object.freeze({ ...config, configured: missing.length === 0, missing: Object.freeze(missing) });
}

export function createMetaSocialClient({ config, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (!config?.configured) {
    return null;
  }
  // The token travels in the Authorization header, never in a URL a log keeps.
  async function graph(method, path, { query = {}, body = null } = {}) {
    const url = new URL(`${GRAPH}/${config.apiVersion}/${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers: { authorization: `Bearer ${config.pageAccessToken}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch (error) {
      throw new MetaSocialError("Meta n'a pas pu être joint.", "META_UNREACHABLE", { cause: error.message });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.error) {
      const error = payload?.error ?? {};
      if (OUTSIDE_WINDOW_SUBCODES.has(Number(error.error_subcode))) {
        throw new MetaSocialError("La personne a écrit il y a plus de 24 heures : Meta n'autorise plus de réponse par message. Répondez-lui depuis l'application Instagram ou Facebook, ou attendez qu'elle réécrive.", "META_OUTSIDE_WINDOW", { status: response.status, metaCode: error.code ?? null });
      }
      throw new MetaSocialError(`Meta a refusé la demande${error.message ? ` : ${error.message}` : ""}.`, "META_REQUEST_FAILED", { status: response.status, metaCode: error.code ?? null, metaSubcode: error.error_subcode ?? null });
    }
    return payload;
  }

  function requireInstagram() {
    if (!config.instagramId) {
      throw new MetaSocialError("Aucun compte Instagram n'est relié (META_INSTAGRAM_ID manque dans .env).", "META_INSTAGRAM_NOT_CONFIGURED");
    }
  }

  return Object.freeze({
    configured: true,
    instagram: Boolean(config.instagramId),

    // A private message, to the person who wrote (their Page- or
    // Instagram-scoped id, as the webhook gave it). Returns Meta's message id.
    async sendMessage({ platform, recipientId, text }) {
      const body = cleanText(text, MAX_MESSAGE_LENGTH[platform] ?? MAX_MESSAGE_LENGTH.facebook);
      if (!recipientId) {
        throw new MetaSocialError("Destinataire inconnu.", "META_RECIPIENT_MISSING");
      }
      const sent = await graph("POST", `${config.pageId}/messages`, { body: { recipient: { id: String(recipientId) }, messaging_type: "RESPONSE", message: { text: body } } });
      return sent.message_id ?? null;
    },

    // A public answer under a comment. Returns the id of the answer.
    async replyToComment({ platform, commentId, text }) {
      const message = cleanText(text, MAX_COMMENT_REPLY_LENGTH);
      if (!commentId) {
        throw new MetaSocialError("Commentaire inconnu.", "META_COMMENT_MISSING");
      }
      const sent = await graph("POST", `${commentId}/${platform === "instagram" ? "replies" : "comments"}`, { body: { message } });
      return sent.id ?? null;
    },

    // A post. Instagram needs a picture, reachable by Meta at a public https
    // address (a JPEG); Facebook takes a picture or a text alone. Returns the
    // id of the published post.
    async publish({ channel, caption, imageUrl = "" }) {
      const text = cleanText(caption, MAX_CAPTION_LENGTH);
      if (channel === "instagram") {
        requireInstagram();
        if (!isPublicUrl(imageUrl)) {
          throw new MetaSocialError("Instagram exige une photo à une adresse publique https.", "META_IMAGE_REQUIRED");
        }
        const container = await graph("POST", `${config.instagramId}/media`, { body: { image_url: imageUrl, caption: text } });
        // Meta prepares the picture before it can be published: checked a few
        // times, as its documentation advises, then published.
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const { status_code: status } = await graph("GET", container.id, { query: { fields: "status_code" } });
          if (status === "FINISHED") {
            break;
          }
          if (status === "ERROR" || status === "EXPIRED") {
            throw new MetaSocialError("Instagram n'a pas pu préparer la photo (format JPEG attendu).", "META_MEDIA_FAILED", { status });
          }
          await sleep(2000);
        }
        const published = await graph("POST", `${config.instagramId}/media_publish`, { body: { creation_id: container.id } });
        return published.id ?? null;
      }
      if (channel === "facebook") {
        if (imageUrl) {
          if (!isPublicUrl(imageUrl)) {
            throw new MetaSocialError("La photo doit être à une adresse publique https.", "META_IMAGE_REQUIRED");
          }
          const photo = await graph("POST", `${config.pageId}/photos`, { body: { url: imageUrl, caption: text } });
          return photo.post_id ?? photo.id ?? null;
        }
        const post = await graph("POST", `${config.pageId}/feed`, { body: { message: text } });
        return post.id ?? null;
      }
      throw new MetaSocialError(`Réseau non relié : ${channel}.`, "META_CHANNEL_UNSUPPORTED");
    },

    // What the accounts look like now: followers and the last posts with
    // their likes and comments, as Meta counts them.
    async overview() {
      const page = await graph("GET", config.pageId, { query: { fields: "name,followers_count,fan_count" } });
      const pagePosts = await graph("GET", `${config.pageId}/posts`, { query: { fields: "id,message,created_time,permalink_url,reactions.summary(true).limit(0),comments.summary(true).limit(0),shares", limit: 10 } });
      const facebook = {
        nom: page.name ?? "",
        abonnes: page.followers_count ?? page.fan_count ?? null,
        publications: (pagePosts.data ?? []).map((post) => ({
          date: post.created_time ?? null,
          texte: String(post.message ?? "").slice(0, 160),
          reactions: post.reactions?.summary?.total_count ?? 0,
          commentaires: post.comments?.summary?.total_count ?? 0,
          partages: post.shares?.count ?? 0,
          lien: post.permalink_url ?? null
        }))
      };
      if (!config.instagramId) {
        return { facebook, instagram: null };
      }
      const account = await graph("GET", config.instagramId, { query: { fields: "username,followers_count,media_count" } });
      const media = await graph("GET", `${config.instagramId}/media`, { query: { fields: "id,caption,timestamp,like_count,comments_count,permalink", limit: 12 } });
      return {
        facebook,
        instagram: {
          compte: account.username ? `@${account.username}` : "",
          abonnes: account.followers_count ?? null,
          nombre_de_publications: account.media_count ?? null,
          publications: (media.data ?? []).map((post) => ({
            date: post.timestamp ?? null,
            texte: String(post.caption ?? "").slice(0, 160),
            likes: post.like_count ?? 0,
            commentaires: post.comments_count ?? 0,
            lien: post.permalink ?? null
          }))
        }
      };
    }
  });
}

// The messages and comments in a webhook call, flattened. The company's own
// messages (echoes) and its own comments are left out, and so are reactions,
// read receipts and edits: only what someone wrote to the company.
export function parseMetaWebhook(body, { pageId = "", instagramId = "" } = {}) {
  if (!body || !["page", "instagram"].includes(body.object)) {
    return [];
  }
  const platform = body.object === "instagram" ? "instagram" : "facebook";
  const own = new Set([pageId, instagramId].filter(Boolean).map(String));
  const events = [];
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const event of Array.isArray(entry.messaging) ? entry.messaging : []) {
      const message = event.message;
      const sender = String(event.sender?.id ?? "");
      if (!message || message.is_echo || !sender || own.has(sender)) {
        continue;
      }
      events.push(Object.freeze({
        kind: "message",
        platform,
        externalId: String(message.mid ?? `${sender}-${event.timestamp}`),
        senderId: sender,
        senderName: "",
        text: String(message.text ?? ""),
        attachments: Object.freeze((message.attachments ?? []).map((attachment) => String(attachment.type ?? "fichier"))),
        postId: null,
        commentId: null,
        at: instant(event.timestamp)
      }));
    }
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const value = change.value ?? {};
      if (change.field === "comments" && platform === "instagram") {
        const sender = String(value.from?.id ?? "");
        if (!value.id || own.has(sender)) {
          continue;
        }
        events.push(Object.freeze({
          kind: "comment",
          platform,
          externalId: String(value.id),
          senderId: sender,
          senderName: value.from?.username ? `@${value.from.username}` : "",
          text: String(value.text ?? ""),
          attachments: Object.freeze([]),
          postId: value.media?.id ? String(value.media.id) : null,
          commentId: String(value.id),
          at: instant(entry.time)
        }));
      }
      if (change.field === "feed" && value.item === "comment" && value.verb === "add") {
        const sender = String(value.from?.id ?? "");
        if (!value.comment_id || own.has(sender)) {
          continue;
        }
        events.push(Object.freeze({
          kind: "comment",
          platform: "facebook",
          externalId: String(value.comment_id),
          senderId: sender,
          senderName: String(value.from?.name ?? ""),
          text: String(value.message ?? ""),
          attachments: Object.freeze([]),
          postId: value.post_id ? String(value.post_id) : null,
          commentId: String(value.comment_id),
          at: instant(value.created_time ?? entry.time)
        }));
      }
    }
  }
  return events;
}

function cleanText(value, limit) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") {
    throw new MetaSocialError("Le texte est vide.", "META_TEXT_EMPTY");
  }
  if (text.length > limit) {
    throw new MetaSocialError(`Le texte dépasse ${limit} caractères.`, "META_TEXT_TOO_LONG", { limit });
  }
  return text;
}

function isPublicUrl(value) {
  try {
    return new URL(String(value)).protocol === "https:";
  } catch {
    return false;
  }
}

// Meta gives milliseconds for a message and seconds for a change.
function instant(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return new Date().toISOString();
  }
  return new Date(number < 1e12 ? number * 1000 : number).toISOString();
}
