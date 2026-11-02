import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// A stand-in for the OpenAI client: it plays back the turns a model would take,
// and records what it was sent. Every client name below is invented.
function scriptedClient(turns) {
  const calls = [];
  return {
    calls,
    responses: {
      async create(payload) {
        calls.push(JSON.parse(JSON.stringify(payload)));
        const turn = turns.shift();
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

async function createApi(t, client) {
  const repository = new InMemoryRepository();
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-agent-"));
  const documentService = new HkidsDocumentService({ repository, outputDir });
  const directorAgent = createDirectorAgent({
    client,
    documentService,
    clock: () => new Date("2026-11-02T10:00:00Z"),
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

test("one sentence becomes a quote the agent fills in itself, ready for validation", async (t) => {
  const client = scriptedClient([toolCall("preparer_document", QUOTE_ARGS), textReply("Devis n° 164 prêt pour Meriem Exemple : 3 000,00 DH TTC.")]);
  const { inject } = await createApi(t, client);

  const response = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "fais moi un devis pour meriem un lit nuage 3000dhs" } });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200, response.body);
  assert.match(body.reply, /164/);
  assert.equal(body.documents.length, 1);
  const [{ input, preview }] = body.documents;
  assert.equal(input.documentType, "quote");
  assert.equal(input.documentNumber, "164", "the quote series continues after 163, issued by hand");
  assert.equal(preview.document.totals.totalTtc, 3000, "3000 DH is read as TTC");
  assert.equal(preview.document.totals.totalHt, 2500);
  assert.equal(preview.document.client.name, "Meriem Exemple");

  // The tool result went back to the model, with the figures it must announce.
  const toolOutput = client.calls[1].input.find((item) => item.type === "function_call_output");
  assert.match(toolOutput.output, /"total_ttc":3000/);

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
  const client = scriptedClient([
    textReply("Quelle est l'adresse de Meriem ?"),
    toolCall("preparer_document", QUOTE_ARGS),
    textReply("Devis prêt.")
  ]);
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
  const sentHistory = client.calls[1].input.map((item) => item.content).filter(Boolean);
  assert.deepEqual(sentHistory.slice(0, 1), ["un devis pour meriem, lit nuage 3000"]);
});

test("a document the rules refuse comes back to the model as errors to ask about", async (t) => {
  const client = scriptedClient([
    toolCall("preparer_document", { ...QUOTE_ARGS, type: "facture" }),
    textReply("Quel est le numéro du devis lié ?")
  ]);
  const { inject } = await createApi(t, client);

  const body = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "une facture pour meriem" } })).body);
  assert.equal(body.documents.length, 0);
  const toolOutput = JSON.parse(client.calls[1].input.find((item) => item.type === "function_call_output").output);
  assert.equal(toolOutput.ok, false);
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
