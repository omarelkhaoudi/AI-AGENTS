// WhatsApp messages the agents draft. Nothing is sent from the server: the
// cockpit opens WhatsApp (wa.me) on Hiba's device with the conversation and the
// text already filled in, and pressing Send there is her validation.
//
// Sending without opening WhatsApp would need the WhatsApp Business Platform
// (Meta), a dedicated number and message templates approved by Meta for every
// message the company starts; that is a separate decision, not this module.

export const MESSAGE_KINDS = Object.freeze(["relance_devis", "relance_paiement", "retard", "commande_fournisseur", "sav", "autre"]);

export const WHATSAPP_MESSAGE_TOOL = Object.freeze({
  type: "function",
  name: "preparer_message_whatsapp",
  description: "Prépare un message WhatsApp prêt à envoyer (relance de devis, relance de paiement, prévenir d'un retard, commande fournisseur, SAV…). Il apparaîtra dans le cockpit avec un bouton « Envoyer via WhatsApp » ; c'est Hiba qui l'envoie. Un appel par destinataire.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      destinataire: { type: "string", description: "Nom du client ou du fournisseur." },
      telephone: { type: "string", description: "Son numéro s'il figure dans les données, sinon chaîne vide (Hiba le complétera). Ne jamais l'inventer." },
      type: { type: "string", enum: MESSAGE_KINDS },
      message: { type: "string", description: "Le texte exact à envoyer : court, poli, vouvoiement, signé « L'équipe H-KIDS »." }
    },
    required: ["destinataire", "telephone", "type", "message"]
  }
});

// A Moroccan number as WhatsApp expects it: country code, no plus, no spaces.
// 06 12 34 56 78, +212 6 12 34 56 78 and 00212612345678 all become 212612345678.
// Anything that does not look like a phone number gives null: the cockpit then
// asks for the number instead of opening a chat with a wrong one.
export function normalizeWhatsAppNumber(value) {
  const digits = String(value ?? "").replace(/[^\d+]/g, "").replace(/^\+/, "").replace(/^00/, "");
  if (/^0[5-7]\d{8}$/.test(digits)) {
    return `212${digits.slice(1)}`;
  }
  if (/^212[5-7]\d{8}$/.test(digits)) {
    return digits;
  }
  if (/^[1-9]\d{7,14}$/.test(digits) && !digits.startsWith("0")) {
    return digits;
  }
  return null;
}

export function whatsAppLink(phone, message) {
  const number = normalizeWhatsAppNumber(phone);
  return number ? `https://wa.me/${number}?text=${encodeURIComponent(message)}` : null;
}

export function draftWhatsAppMessage(args, { agent = "director" } = {}) {
  const message = typeof args.message === "string" ? args.message.trim() : "";
  const recipient = typeof args.destinataire === "string" ? args.destinataire.trim() : "";
  if (message === "" || recipient === "") {
    return { ok: false, erreur: "Le destinataire et le texte du message sont obligatoires." };
  }
  const phone = normalizeWhatsAppNumber(args.telephone);
  return {
    ok: true,
    draft: Object.freeze({
      agent,
      recipient,
      kind: MESSAGE_KINDS.includes(args.type) ? args.type : "autre",
      phone,
      message,
      link: phone ? whatsAppLink(phone, message) : null
    })
  };
}
