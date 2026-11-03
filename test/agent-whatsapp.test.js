import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { draftWhatsAppMessage, normalizeWhatsAppNumber, whatsAppLink } from "../src/agent/whatsapp.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

test("Moroccan numbers are written the way WhatsApp expects them", () => {
  for (const written of ["06 12 34 56 78", "0612345678", "+212 6 12 34 56 78", "00212612345678", "212612345678"]) {
    assert.equal(normalizeWhatsAppNumber(written), "212612345678", written);
  }
  assert.equal(normalizeWhatsAppNumber("05 24 01 84 20"), "212524018420");
  assert.equal(normalizeWhatsAppNumber(""), null);
  assert.equal(normalizeWhatsAppNumber("à demander"), null);
  assert.equal(normalizeWhatsAppNumber("0612"), null);
});

test("the link opens the chat with the exact text, accents and line breaks included", () => {
  const link = whatsAppLink("0612345678", "Bonjour Madame,\nVotre devis n° 164 est prêt.");
  assert.equal(link, "https://wa.me/212612345678?text=Bonjour%20Madame%2C%0AVotre%20devis%20n%C2%B0%20164%20est%20pr%C3%AAt.");
  assert.equal(whatsAppLink("", "Bonjour"), null, "no number, no link: Hiba completes it");
});

test("a draft without a number is kept, and says the number is missing", () => {
  const { ok, draft } = draftWhatsAppMessage({ destinataire: "Client Exemple", telephone: "", type: "relance_devis", message: "Bonjour" }, { agent: "commercial" });
  assert.equal(ok, true);
  assert.equal(draft.phone, null);
  assert.equal(draft.link, null);
  assert.equal(draft.agent, "commercial");
  assert.equal(draftWhatsAppMessage({ destinataire: "", message: "Bonjour" }).ok, false);
});

test("an agent's follow-up comes back as a WhatsApp message to send, not as text to copy", async (t) => {
  const isDirector = (p) => p.instructions.startsWith("Tu es le Director IA");
  const hasOutput = (p) => p.input.some((item) => item.type === "function_call_output");
  const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
  const rules = [
    { when: (p) => isDirector(p) && !hasOutput(p), then: () => call("deleguer_a_un_agent", { agent: "commercial", mission: "Relancer les devis sans réponse." }, "d1") },
    { when: (p) => p.instructions.includes("Tu es l'agent Commercial") && !hasOutput(p), then: () => call("preparer_message_whatsapp", {
      destinataire: "Client Exemple", telephone: "06 11 22 33 44", type: "relance_devis",
      message: "Bonjour Madame, avez-vous pu consulter notre devis ? L'équipe H-KIDS"
    }, "c1") },
    { when: (p) => p.instructions.includes("Tu es l'agent Commercial"), then: () => ({ output_text: "Relance préparée pour Client Exemple.", output: [] }) },
    { when: isDirector, then: () => ({ output_text: "Une relance est prête pour Client Exemple.", output: [] }) }
  ];
  const client = { responses: { create: async (payload) => rules.find((rule) => rule.when(payload)).then(payload) } };
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), agentClient: client });
  t.after(() => app.close());

  const body = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Relance les devis" } })).body);

  assert.equal(body.messages.length, 1);
  const [message] = body.messages;
  assert.equal(message.agent, "commercial");
  assert.equal(message.phone, "212611223344");
  assert.equal(message.kind, "relance_devis");
  assert.match(message.link, /^https:\/\/wa\.me\/212611223344\?text=Bonjour/);
});

test("the same message prepared twice for one recipient is kept once, in its latest version", async (t) => {
  const isDirector = (p) => p.instructions.startsWith("Tu es le Director IA");
  const draft = (text, id) => ({ output: [{ type: "function_call", name: "preparer_message_whatsapp", call_id: id, arguments: JSON.stringify({ destinataire: "Client Exemple", telephone: "", type: "relance_paiement", message: text }) }] });
  let financeTurns = 0;
  let directorTurns = 0;
  const client = { responses: { create: async (payload) => {
    if (isDirector(payload)) {
      directorTurns += 1;
      return directorTurns === 1
        ? { output: [{ type: "function_call", name: "deleguer_a_un_agent", call_id: "d1", arguments: JSON.stringify({ agent: "finance", mission: "Relancer Client Exemple." }) }] }
        : { output_text: "Relance prête.", output: [] };
    }
    financeTurns += 1;
    if (financeTurns === 1) {
      return draft("Première version", "m1");
    }
    if (financeTurns === 2) {
      return draft("Version corrigée", "m2");
    }
    return { output_text: "Relance préparée.", output: [] };
  } } };
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), agentClient: client });
  t.after(() => app.close());

  const body = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "relance" } })).body);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].message, "Version corrigée");
});
