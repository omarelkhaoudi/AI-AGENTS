import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// Hiba photographs a bed, a sketch or a client's inspiration and sends it to the
// Director in the chat. The model sees the picture in that message; the photo
// stays in the conversation under its number, so the Commercial can put it on a
// purchase order as its visual.
const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const isDirector = (payload) => payload.instructions.startsWith("Tu es le Director IA");
const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
const say = (text) => ({ output_text: text, output: [] });

function scripted(director, others = []) {
  const calls = [];
  return {
    calls,
    responses: {
      async create(payload) {
        calls.push(JSON.parse(JSON.stringify(payload)));
        return isDirector(payload) ? director.shift() : others.shift();
      }
    }
  };
}

async function directorWith(t, client) {
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-agent-photo-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  return createDirectorAgent({
    client,
    documentService: new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir }),
    toolRegistry: { list: () => [] },
    executeTool: async () => ({ ok: true, donnees: null }),
    clock: () => new Date("2026-11-04T10:00:00Z")
  });
}

const images = (payload) => payload.input
  .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
  .filter((part) => part.type === "input_image");

test("the Director sees the photos joined to a message, numbered in the conversation", async (t) => {
  const client = scripted([say("Je vois un lit cabane en bois clair."), say("C'est noté.")]);
  const agent = await directorWith(t, client);

  const first = await agent.chat({ message: "Regarde ce lit", photos: [PHOTO, PHOTO] });
  await agent.chat({ message: "Et celle-ci", photos: [PHOTO], conversationId: first.conversationId });

  assert.equal(images(client.calls[0]).length, 2);
  assert.equal(images(client.calls[0])[0].image_url, PHOTO);
  assert.match(client.calls[0].input.at(-1).content[0].text, /Regarde ce lit\n\n\[Photos jointes : n° 1, n° 2\]/);
  assert.equal(images(client.calls[1]).length, 1, "a photo already seen is not sent again");
  assert.match(client.calls[1].input.at(-1).content[0].text, /\[Photos jointes : n° 3\]/, "numbering goes on across messages");
  assert.match(client.calls[1].input[0].content, /n° 1, n° 2\]\n\[Photos vues/, "earlier photos are remembered by their number");
});

test("a photo can be sent without a word", async (t) => {
  const client = scripted([say("Que souhaitez-vous faire de cette photo ?")]);
  const agent = await directorWith(t, client);

  const result = await agent.chat({ message: "", photos: [PHOTO] });

  assert.equal(result.reply, "Que souhaitez-vous faire de cette photo ?");
  assert.match(client.calls[0].input[0].content[0].text, /^Voici une photo\./);
});

test("photos that are not JPEG or PNG, or too many, are refused before the model is called", async (t) => {
  const client = scripted([]);
  const agent = await directorWith(t, client);

  await assert.rejects(agent.chat({ message: "x", photos: ["data:image/gif;base64,R0lGOD"] }), { code: "AGENT_PHOTO_INVALID" });
  await assert.rejects(agent.chat({ message: "x", photos: Array(5).fill(PHOTO) }), { code: "AGENT_PHOTO_INVALID" });
  await assert.rejects(agent.chat({ message: "x", photos: "pas une liste" }), { code: "AGENT_PHOTO_INVALID" });
  assert.equal(client.calls.length, 0);
});

test("the Commercial puts the photo the Director names on the purchase order", async (t) => {
  const order = (photo, id) => call("preparer_document", {
    type: "bon_de_commande", client_nom: "Client Exemple", client_adresse: "Marrakech", objet: "Lit cabane",
    lignes: [{ designation: "Lit cabane", quantite: 1, prix_unitaire: 4500, prix_ttc: true }],
    caracteristiques: ["Bois clair"], conditions_paiement: "60/20/20", reference_devis: "", reference_bl: "", numero: "", photo
  }, id);
  const client = scripted(
    [
      call("deleguer_a_un_agent", { agent: "commercial", mission: "Bon de commande Client Exemple, Marrakech : lit cabane bois clair, 4500 DH TTC. Visuel : photo n° 1." }, "d1"),
      say("Le Commercial a préparé le bon de commande avec la photo.")
    ],
    [order(2, "c1"), order(1, "c2"), say("Bon de commande prêt avec le visuel.")]
  );
  const agent = await directorWith(t, client);

  const result = await agent.chat({ message: "BC pour Client Exemple à Marrakech, ce lit à 4500", photos: [PHOTO] });

  const commercial = client.calls.filter((payload) => payload.instructions.includes("Tu es l'agent Commercial"));
  assert.match(commercial[1].input.at(-1).output, /pas de photo n° 2/, "a wrong number is refused, not ignored");
  assert.match(commercial[2].input.at(-1).output, /"visuel":"photo n° 1"/);
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].input.referenceImage, PHOTO);
  assert.equal(images(commercial[0]).length, 0, "the agents read the Director's description, not the picture");
});

test("the chat route takes photos larger than the general body limit", async (t) => {
  const client = scripted([say("Photo reçue.")]);
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), agentClient: client });
  t.after(() => app.close());
  const big = `data:image/jpeg;base64,${"A".repeat(200_000)}`;

  const ok = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "voici", photos: [big] } });
  const refused = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "voici", photos: ["data:text/plain;base64,QQ=="] } });

  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(images(client.calls[0])[0].image_url, big);
  assert.equal(refused.statusCode, 400);
  assert.equal(JSON.parse(refused.body).details.code, "AGENT_PHOTO_INVALID");
});
