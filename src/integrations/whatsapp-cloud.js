import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeWhatsAppNumber } from "../agent/whatsapp.js";

// The official WhatsApp Business Platform (Meta's Cloud API), as the CDC asks
// for phase 1. Two directions:
// - in: Meta calls our webhook with each message written to the company number;
// - out: a message validated in the cockpit leaves from that number.
//
// Meta lets a business write freely only within 24 hours of the person's last
// message. Outside that window it requires a template approved by Meta; this
// module does not send templates, it says so, and the cockpit keeps the wa.me
// button for that case.

const GRAPH = "https://graph.facebook.com";
const DEFAULT_API_VERSION = "v21.0";
// Meta's limit for the body of a text message.
export const MAX_TEXT_LENGTH = 4096;
const REQUIRED_KEYS = Object.freeze({
  accessToken: "WHATSAPP_ACCESS_TOKEN",
  phoneNumberId: "WHATSAPP_PHONE_NUMBER_ID",
  verifyToken: "WHATSAPP_VERIFY_TOKEN",
  appSecret: "WHATSAPP_APP_SECRET"
});

export class WhatsAppCloudError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WhatsAppCloudError";
    this.code = code;
    this.details = details;
  }
}

// Read from .env. All four keys are needed: without the app secret the webhook
// could not tell Meta's calls from anyone else's, so it stays closed.
export function loadWhatsAppCloudConfig(env = process.env) {
  const value = (name) => (typeof env[name] === "string" ? env[name].trim() : "");
  const config = {
    accessToken: value("WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId: value("WHATSAPP_PHONE_NUMBER_ID"),
    verifyToken: value("WHATSAPP_VERIFY_TOKEN"),
    appSecret: value("WHATSAPP_APP_SECRET"),
    apiVersion: value("WHATSAPP_API_VERSION") || DEFAULT_API_VERSION,
    // The direction's own numbers: a message from one of them is an order
    // given to the Director, like a message typed in the cockpit.
    ownerNumbers: value("WHATSAPP_OWNER_NUMBERS")
      .split(/[,;]/)
      .map((number) => normalizeWhatsAppNumber(number))
      .filter(Boolean)
  };
  // Named as in .env, so the cockpit can say which line is missing.
  const missing = Object.entries(REQUIRED_KEYS).filter(([key]) => config[key] === "").map(([, name]) => name);
  return Object.freeze({ ...config, configured: missing.length === 0, missing: Object.freeze(missing) });
}

export function createWhatsAppCloudClient({ config, fetchImpl = globalThis.fetch } = {}) {
  if (!config?.configured) {
    return null;
  }
  return Object.freeze({
    // Sends a text and returns Meta's message id.
    async sendText(to, body) {
      const number = normalizeWhatsAppNumber(to);
      if (!number) {
        throw new WhatsAppCloudError("Numéro WhatsApp illisible.", "WHATSAPP_NUMBER_INVALID");
      }
      const text = typeof body === "string" ? body.trim() : "";
      if (text === "") {
        throw new WhatsAppCloudError("Le message est vide.", "WHATSAPP_MESSAGE_EMPTY");
      }
      let response;
      try {
        response = await fetchImpl(`${GRAPH}/${config.apiVersion}/${encodeURIComponent(config.phoneNumberId)}/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${config.accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: number,
            type: "text",
            text: { body: text.slice(0, MAX_TEXT_LENGTH), preview_url: true }
          })
        });
      } catch (error) {
        throw new WhatsAppCloudError("WhatsApp est injoignable : vérifiez la connexion internet.", "WHATSAPP_UNREACHABLE", { cause: error.message });
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw metaError(payload?.error, response.status);
      }
      return Object.freeze({ id: payload?.messages?.[0]?.id ?? null, to: number });
    }
  });
}

// Meta signs each webhook call with the app secret over the raw body.
export function verifyWebhookSignature(rawBody, header, appSecret) {
  if (!appSecret || typeof header !== "string" || !header.startsWith("sha256=")) {
    return false;
  }
  const expected = Buffer.from(createHmac("sha256", appSecret).update(rawBody).digest("hex"), "utf8");
  const given = Buffer.from(header.slice("sha256=".length), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// The messages in a webhook call, flattened. Delivery statuses and other
// changes are left out. A message that is not text (photo, voice note…) is
// kept with its type and no text, so it is still seen in the cockpit.
export function parseWebhookMessages(body) {
  const found = [];
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value ?? {};
      const names = new Map((value.contacts ?? []).map((contact) => [contact?.wa_id, contact?.profile?.name ?? ""]));
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        const from = normalizeWhatsAppNumber(message?.from);
        if (!from || typeof message?.id !== "string") {
          continue;
        }
        found.push(Object.freeze({
          id: message.id,
          from,
          name: names.get(message.from) ?? "",
          type: typeof message.type === "string" ? message.type : "unknown",
          text: messageText(message),
          at: Number.isFinite(Number(message.timestamp)) ? new Date(Number(message.timestamp) * 1000).toISOString() : null
        }));
      }
    }
  }
  return found;
}

function messageText(message) {
  if (message.type === "text") {
    return String(message.text?.body ?? "").trim();
  }
  if (message.type === "button") {
    return String(message.button?.text ?? "").trim();
  }
  if (message.type === "interactive") {
    return String(message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? "").trim();
  }
  // A caption sent with a photo or a document is still words the person wrote.
  return String(message[message.type]?.caption ?? "").trim();
}

function metaError(error, status) {
  const code = Number(error?.code);
  if (code === 131047 || code === 470) {
    return new WhatsAppCloudError(
      "Cette personne n'a pas écrit à H-KIDS depuis plus de 24 h : WhatsApp n'autorise alors qu'un modèle de message approuvé par Meta. Envoyez-le cette fois depuis votre téléphone.",
      "WHATSAPP_WINDOW_CLOSED",
      { metaCode: code }
    );
  }
  if (code === 190 || status === 401) {
    return new WhatsAppCloudError("Le jeton d'accès WhatsApp est refusé ou expiré : renouvelez WHATSAPP_ACCESS_TOKEN.", "WHATSAPP_TOKEN_REJECTED", { metaCode: code });
  }
  if (code === 131026 || code === 131030) {
    return new WhatsAppCloudError("Ce numéro ne peut pas recevoir de message WhatsApp (pas de compte, ou pas autorisé en mode test).", "WHATSAPP_RECIPIENT_REFUSED", { metaCode: code });
  }
  return new WhatsAppCloudError(`WhatsApp a refusé l'envoi${error?.message ? ` : ${error.message}` : ""}.`, "WHATSAPP_SEND_FAILED", { metaCode: Number.isFinite(code) ? code : null, status });
}
