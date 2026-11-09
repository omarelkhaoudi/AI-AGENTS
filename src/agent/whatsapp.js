// WhatsApp messages the agents draft. An agent never sends one itself: the
// message waits in the cockpit, and a person sends it, either from the
// company's WhatsApp Business number (src/integrations/whatsapp-cloud.js, when
// configured) or by opening WhatsApp (wa.me) with the text already filled in.

export const MESSAGE_KINDS = Object.freeze(["relance_devis", "relance_paiement", "retard", "commande_fournisseur", "sav", "tache_equipe", "autre"]);

export const WHATSAPP_MESSAGE_TOOL = Object.freeze({
  type: "function",
  name: "preparer_message_whatsapp",
  description: "Prépare un message WhatsApp prêt à envoyer (relance de devis, relance de paiement, prévenir d'un retard, commande fournisseur, SAV…). Il apparaîtra dans le cockpit, où c'est la direction qui le relit et l'envoie. Un appel par destinataire.",
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
