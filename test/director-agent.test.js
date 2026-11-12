import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// A stand-in for the OpenAI client: it plays back the turns a model would take,
// and records what it was sent. The Director and the agents each follow their
// own script, told apart by their instructions. Every client name is invented.
function scriptedClient(turns, agentTurns = []) {
  const calls = [];
  return {
    calls,
    responses: {
      async create(payload) {
        calls.push(JSON.parse(JSON.stringify(payload)));
        const turn = payload.instructions.startsWith("Tu es le Director IA") ? turns.shift() : agentTurns.shift();
        if (turn instanceof Error) {
          throw turn;
        }
        return turn;
      }
    }
  };
}

function toolCall(name, args, id = "call_1") {
  return { output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] };
}

function textReply(text) {
  return { output_text: text, output: [{ type: "message", content: [{ type: "output_text", text }] }] };
}

const QUOTE_ARGS = Object.freeze({
  type: "devis",
  client_nom: "Meriem Exemple",
  client_adresse: "Marrakech",
  objet: "Lit nuage",
  lignes: [{ designation: "Lit nuage", quantite: 1, prix_unitaire: 3000, prix_ttc: true }],
  caracteristiques: [],
  conditions_paiement: "60/20/20",
  reference_devis: "",
  reference_bl: "",
  numero: ""
});

const toCommercial = (mission) => toolCall("deleguer_a_un_agent", { agent: "commercial", mission }, "d1");

async function createApi(t, client) {
  const repository = new InMemoryRepository();
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-agent-"));
  const documentService = new HkidsDocumentService({ repository, outputDir });
  const directorAgent = createDirectorAgent({
    client,
    documentService,
    clock: () => new Date("2026-11-02T10:00:00Z"),
    toolRegistry: { list: () => [] },
    executeTool: async () => ({ ok: true, donnees: null }),
    runDirectorRequest: async ({ message }) => ({
      message,
      summary: { headline: "Point complete", minimumSections: { "A ENCAISSER": [{ label: "Client Exemple - 5000 MAD - en retard de 2 jour(s)" }] }, domainSources: [] }
    })
  });
  const { app, inject } = await buildAuthenticatedApi({ repository, documentService, directorAgent });
  t.after(async () => {
    await app.close();
    await rm(outputDir, { recursive: true, force: true });
  });
  return { inject };
}

test("the Director does not write the quote: it hands it to the Commercial, who prepares it for validation", async (t) => {
  const client = scriptedClient(
    [toCommercial("Devis pour Meriem Exemple, Marrakech : 1 lit nuage à 3000 DH TTC."), textReply("Le Commercial a préparé le devis n° 164 pour Meriem Exemple : 3 000,00 DH TTC.")],
    [toolCall("preparer_document", QUOTE_ARGS, "c1"), textReply("Devis n° 164 prêt : 3000 DH TTC.")]
  );
  const { inject } = await createApi(t, client);

  const response = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "fais moi un devis pour meriem a marrakech un lit nuage 3000dhs" } });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200, response.body);
  assert.match(body.reply, /164/);
  const directorTools = client.calls[0].tools.map((tool) => tool.name);
  assert.ok(!directorTools.includes("preparer_document"), "the Director executes nothing itself");
  assert.ok(directorTools.includes("mesurer_objectif"));

  assert.equal(body.documents.length, 1);
  const [{ input, preview, preparedBy }] = body.documents;
  assert.equal(preparedBy, "commercial");
  assert.equal(input.documentType, "quote");
  assert.equal(input.documentNumber, "164", "the quote series continues after 163, issued by hand");
  assert.equal(preview.document.totals.totalTtc, 3000, "3000 DH is read as TTC");
  assert.equal(preview.document.totals.totalHt, 2500);
  assert.equal(preview.document.client.name, "Meriem Exemple");

  // The Commercial is offered the documents of its trade, not the invoice.
  const commercialCall = client.calls.find((payload) => payload.instructions.includes("Tu es l'agent Commercial"));
  const documentTool = commercialCall.tools.find((tool) => tool.name === "preparer_document");
  assert.deepEqual(documentTool.parameters.properties.type.enum, ["devis", "bon_de_commande", "bon_de_livraison"]);

  // Nothing is generated until she validates: then the usual generation runs.
  const generated = await inject({
    method: "POST",
    url: "/api/documents/generate",
    payload: { ...input, previewToken: preview.previewToken, userConfirmation: true }
  });
  assert.equal(generated.statusCode, 201, generated.body);
  assert.match(JSON.parse(generated.body).files.pdf.name, /^devis_HKIDS_164_/);
});

test("the conversation is kept, so a missing address can be given in a second message", async (t) => {
  const client = scriptedClient(
    [
      toCommercial("Devis pour Meriem : 1 lit nuage à 3000 DH TTC."),
      textReply("Quelle est l'adresse de Meriem ?"),
      toCommercial("Devis pour Meriem Exemple, Marrakech : 1 lit nuage à 3000 DH TTC."),
      textReply("Devis prêt.")
    ],
    [
      textReply("Il manque l'adresse de la cliente."),
      toolCall("preparer_document", QUOTE_ARGS, "c1"),
      textReply("Devis prêt.")
    ]
  );
  const { inject } = await createApi(t, client);

  const first = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "un devis pour meriem, lit nuage 3000" } })).body);
  assert.match(first.reply, /adresse/);
  assert.equal(first.documents.length, 0, "nothing is prepared on a guess");

  const second = JSON.parse((await inject({
    method: "POST",
    url: "/api/agent/chat",
    payload: { message: "Marrakech", conversationId: first.conversationId }
  })).body);
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(second.documents.length, 1);
  const directorCalls = client.calls.filter((payload) => payload.instructions.startsWith("Tu es le Director IA"));
  assert.equal(directorCalls[2].input[0].content, "un devis pour meriem, lit nuage 3000", "the second turn still sees the first");
});

test("a document outside an agent's trade, or that the rules refuse, comes back as errors", async (t) => {
  const client = scriptedClient(
    [toCommercial("Facture pour Meriem."), textReply("Quel est le numéro du devis lié ?")],
    [toolCall("preparer_document", { ...QUOTE_ARGS, type: "facture" }, "c1"), textReply("Je ne fais pas les factures.")]
  );
  const { inject } = await createApi(t, client);

  const body = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "une facture pour meriem" } })).body);
  assert.equal(body.documents.length, 0);
  const commercialTurn = client.calls.find((payload) => payload.instructions.includes("Tu es l'agent Commercial") && payload.input.some((item) => item.type === "function_call_output"));
  const toolOutput = JSON.parse(commercialTurn.input.find((item) => item.type === "function_call_output").output);
  assert.equal(toolOutput.ok, false);
  assert.match(toolOutput.erreur, /pas du ressort/);
});

test("a question about the company runs the team and returns its report", async (t) => {
  const client = scriptedClient([toolCall("point_entreprise", { question: "point du jour" }), textReply("Un encaissement est en retard.")]);
  const { inject } = await createApi(t, client);

  const body = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "fais moi le point" } })).body);
  assert.equal(body.directorResponse.summary.headline, "Point complete");
  assert.match(client.calls[1].input.at(-1).output, /en retard de 2 jour/);
});

test("without a key the agent says so instead of failing silently", async (t) => {
  const repository = new InMemoryRepository();
  const directorAgent = createDirectorAgent({ apiKey: "", documentService: new HkidsDocumentService({ repository }) });
  const { app, inject } = await buildAuthenticatedApi({ repository, directorAgent });
  t.after(() => app.close());

  assert.equal(JSON.parse((await inject({ method: "GET", url: "/api/agent/status" })).body).configured, false);
  const response = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "bonjour" } });
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.parse(response.body).details.code, "AGENT_NOT_CONFIGURED");
});

test("a refused key is reported in words a manager can act on", async (t) => {
  const refused = Object.assign(new Error("Unauthorized"), { status: 401 });
  const { inject } = await createApi(t, scriptedClient([refused]));

  const response = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "bonjour" } });
  assert.equal(response.statusCode, 503);
  assert.match(JSON.parse(response.body).error, /clé OpenAI est refusée/);
});

// The error the OpenAI client raises when no answer comes back at all, as when
// the internet is down. The message points at the connection, not at OpenAI.
test("a lost internet connection is reported as such", async (t) => {
  const { APIConnectionError, APIConnectionTimeoutError } = await import("openai");
  for (const lost of [new APIConnectionError({ message: "Connection error." }), new APIConnectionTimeoutError()]) {
    const { inject } = await createApi(t, scriptedClient([lost]));
    const response = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "bonjour" } });
    assert.equal(response.statusCode, 503);
    assert.match(JSON.parse(response.body).error, /connexion internet semble coupée/);
  }

  const { inject } = await createApi(t, scriptedClient([new Error("Bad gateway")]));
  const other = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "bonjour" } });
  assert.match(JSON.parse(other.body).error, /n'a pas répondu/, "any other failure keeps its own message");
});

test("a long conversation is cut where the direction spoke, never between a reasoning and its tool call", async () => {
  const { recentTurns } = await import("../src/agent/director-agent.js");
  const turn = (n) => [
    { role: "user", content: `question ${n}` },
    { type: "reasoning", id: `rs_${n}`, summary: [] },
    { type: "function_call", id: `fc_${n}`, call_id: `c${n}`, name: "point_entreprise", arguments: "{}" },
    { type: "function_call_output", call_id: `c${n}`, output: "{}" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: `réponse ${n}` }] }
  ];
  const items = Array.from({ length: 15 }, (_, n) => turn(n)).flat();
  const kept = recentTurns(items);
  assert.equal(kept[0].role, "user", "the history starts with a message of the direction");
  assert.ok(kept.length <= 60);
  for (const [index, item] of kept.entries()) {
    if (item.type === "function_call") {
      assert.equal(kept[index - 1].type, "reasoning", "each tool call keeps the reasoning before it");
    }
  }
  // A conversation saved before the rule, starting on a tool call, is mended.
  assert.equal(recentTurns(items.slice(2, 20))[0].content, "question 1");
});
