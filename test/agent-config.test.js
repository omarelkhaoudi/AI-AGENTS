import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { createMemoryAgentConfig } from "../src/agent/agent-config.js";
import { readReferenceFile } from "../src/agent/reference-reader.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

const clock = () => new Date("2026-11-17T09:00:00Z");
const dataUrl = (text, type = "text/plain") => `data:${type};base64,${Buffer.from(text, "utf8").toString("base64")}`;

const PRICES_2025 = "Grille tarifaire 2025\nLit château 140 x 190 : 28 000 DH TTC\nLit cabane 90 x 190 : 14 500 DH TTC\n\nLivraison Marrakech offerte.";
const PRICES_2026 = "Grille tarifaire 2026\nLit château 140 x 190 : 32 000 DH TTC\nLit cabane 90 x 190 : 15 900 DH TTC\n\nLivraison Marrakech offerte, autres villes sur devis.";

test("a newer version of a document retires the older one, and the agent reads only what is in force", async () => {
  const config = createMemoryAgentConfig({ clock, agents: SPECIALIST_IDS });
  const first = await config.addDocument("commercial", { title: "Grille tarifaire", text: PRICES_2025, validFrom: "2025-01-01" });
  assert.equal(first.version, 1);
  await assert.rejects(config.addDocument("commercial", { title: "grille  TARIFAIRE", text: PRICES_2025 }), { code: "AGENT_DOCUMENT_DUPLICATE" });
  const second = await config.addDocument("commercial", { title: "Grille tarifaire ", text: PRICES_2026, validFrom: "2026-01-01" });
  assert.deepEqual([second.version, second.replaces], [2, first.id]);
  assert.equal((await config.documents("commercial")).find((entry) => entry.id === first.id).status, "perime");

  const found = await config.search("commercial", "combien coûte le lit château ?");
  assert.equal(found.length, 1);
  assert.equal(found[0].document.version, 2);
  assert.match(found[0].passage, /32 000 DH/);
  const history = await config.search("commercial", "lit chateau", { includeRetired: true });
  assert.deepEqual(history.map((entry) => entry.document.version).sort(), [1, 2]);
  assert.deepEqual(await config.search("finance", "lit château"), [], "an agent reads its own documents only");

  // Putting the old one back in force retires the new one: never two versions at once.
  await config.setDocumentStatus("commercial", first.id, "en_vigueur");
  assert.deepEqual((await config.documents("commercial")).map((entry) => entry.status), ["en_vigueur", "perime"]);
  await assert.rejects(config.addDocument("commercial", { title: "Vide", text: "  " }), { code: "AGENT_DOCUMENT_EMPTY" });
  await assert.rejects(config.addDocument("inconnu", { title: "x", text: "y" }), { code: "AGENT_CONFIG_UNKNOWN_AGENT" });
});

test("instructions, documents and notes make the agent's briefing; notes are capped and can be erased", async () => {
  const config = createMemoryAgentConfig({ clock, agents: SPECIALIST_IDS });
  await config.save("commercial", { instructions: "Toujours proposer la livraison et le montage.", forbiddenTools: ["preparer_document", "preparer_document"] });
  assert.deepEqual((await config.settings("commercial")).forbiddenTools, ["preparer_document"]);
  await config.addDocument("commercial", { title: "Grille tarifaire", text: PRICES_2026, validFrom: "2026-01-01" });
  const note = await config.remember("commercial", "Mme Salma préfère être appelée après 18 h.");
  const briefing = (await config.briefing("commercial")).join("\n");
  assert.match(briefing, /Toujours proposer la livraison/);
  assert.match(briefing, /« Grille tarifaire » v1 en vigueur depuis le 2026-01-01/);
  assert.match(briefing, /se contredisent.*demande à la direction/);
  assert.match(briefing, /Mme Salma préfère/);
  assert.deepEqual(await config.briefing("finance"), []);

  for (let index = 0; index < 45; index += 1) {
    await config.remember("commercial", `note ${index}`);
  }
  const memory = await config.memory("commercial");
  assert.equal(memory.length, 40);
  assert.equal(memory.some((line) => line.id === note.id), false, "the oldest notes go first");
  await config.forget("commercial", memory[0].id);
  assert.equal((await config.memory("commercial")).length, 39);
  await assert.rejects(config.save("commercial", { instructions: "x".repeat(4001) }), { code: "AGENT_CONFIG_TOO_LONG" });
});

test("a reference file is read into text; a PDF goes to the model, and without it is refused", async () => {
  assert.deepEqual(await readReferenceFile({ name: "tarifs.csv", data: dataUrl("produit;prix\nLit cabane;15900") }), { fileName: "tarifs.csv", kind: "texte", text: "produit;prix\nLit cabane;15900" });
  await assert.rejects(readReferenceFile({ name: "plan.dwg", data: dataUrl("x") }), { code: "AGENT_DOCUMENT_TYPE" });
  await assert.rejects(readReferenceFile({ name: "catalogue.pdf", data: dataUrl("%PDF-1.4", "application/pdf") }), { code: "AGENT_DOCUMENT_PDF_UNAVAILABLE" });
  const read = await readReferenceFile({ name: "catalogue.pdf", data: dataUrl("%PDF-1.4", "application/pdf") }, { readPdf: async ({ name, base64 }) => `${name} lu (${Buffer.from(base64, "base64").toString()})` });
  assert.deepEqual([read.kind, read.text], ["pdf", "catalogue.pdf lu (%PDF-1.4)"]);
});

// The model, played: the Director delegates to the Commercial, which searches
// its documents, keeps a note, and tries a tool the direction took from it.
function modelPlaying() {
  const calls = [];
  return {
    calls,
    responses: {
      async create(payload) {
        calls.push(JSON.parse(JSON.stringify(payload)));
        const outputs = payload.input.filter((item) => item.type === "function_call_output");
        const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
        if (payload.instructions.startsWith("Tu es le Director IA")) {
          return outputs.length === 0 ? call("deleguer_a_un_agent", { agent: "commercial", mission: "Prix du lit château ?" }, "d1") : { output_text: "Le lit château est à 32 000 DH TTC (grille 2026).", output: [] };
        }
        if (Array.isArray(payload.input[0]?.content) && payload.input[0].content.some((part) => part.type === "input_file")) {
          return { output_text: "Catalogue H-KIDS\nLit montessori : 6 900 DH", output: [] };
        }
        if (outputs.length === 0) return call("documents_reference", { recherche: "lit château", inclure_anciens: false }, "c1");
        if (outputs.length === 1) return call("preparer_document", { type: "devis" }, "c2");
        if (outputs.length === 2) return call("memoriser", { note: "La direction demande souvent le prix du lit château." }, "c3");
        return { output_text: "32 000 DH TTC selon « Grille tarifaire » v2.", output: [] };
      }
    }
  };
}

test("the direction sets an agent in the cockpit, and the agent works with it at its next mission", async (t) => {
  const repository = new InMemoryRepository();
  const client = modelPlaying();
  const { app, inject } = await buildAuthenticatedApi({ repository, agentClient: client, clock });
  t.after(() => app.close());

  const listed = JSON.parse((await inject({ method: "GET", url: "/api/agents/config" })).body);
  const commercial = listed.agents.find((agent) => agent.id === "commercial");
  assert.ok(commercial.tools.some((tool) => tool.name === "preparer_document"));
  assert.deepEqual(commercial.tools.filter((tool) => tool.locked).map((tool) => tool.name), ["documents_reference", "memoriser"]);

  const saved = await inject({ method: "PUT", url: "/api/agents/commercial/config", payload: { instructions: "Toujours citer la grille tarifaire.", forbiddenTools: ["preparer_document", "outil_inexistant", "documents_reference"] } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(JSON.parse(saved.body).agent.forbiddenTools, ["documents_reference", "preparer_document"]);
  assert.equal(JSON.parse(saved.body).agent.tools.find((tool) => tool.name === "documents_reference").forbidden, false, "a locked tool stays");

  for (const text of [PRICES_2025, PRICES_2026]) {
    const added = await inject({ method: "POST", url: "/api/agents/commercial/documents", payload: { name: "grille.txt", data: dataUrl(text), title: "Grille tarifaire" } });
    assert.equal(added.statusCode, 201, added.body);
  }
  const pdf = await inject({ method: "POST", url: "/api/agents/commercial/documents", payload: { name: "catalogue.pdf", data: dataUrl("%PDF-1.4", "application/pdf") } });
  assert.equal(pdf.statusCode, 201, pdf.body);
  assert.equal(JSON.parse(pdf.body).document.title, "catalogue");
  const docs = JSON.parse((await inject({ method: "GET", url: "/api/agents/config" })).body).agents.find((agent) => agent.id === "commercial").documents;
  const reading = JSON.parse((await inject({ method: "GET", url: `/api/agents/commercial/documents/${docs[0].id}/text` })).body);
  assert.match(reading.text, /Lit montessori/);

  const answer = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Prix du lit château ?" } });
  assert.equal(answer.statusCode, 200, answer.body);
  const agentCalls = client.calls.filter((payload) => payload.instructions.includes("Tu es l'agent Commercial"));
  assert.match(agentCalls[0].instructions, /Toujours citer la grille tarifaire/);
  assert.match(agentCalls[0].instructions, /« Grille tarifaire » v2/);
  assert.equal(agentCalls[0].tools.some((tool) => tool.name === "preparer_document"), false, "a forbidden tool is not offered");
  const outputs = agentCalls.at(-1).input.filter((item) => item.type === "function_call_output").map((item) => JSON.parse(item.output));
  assert.match(outputs[0].passages[0].texte, /32 000 DH/);
  assert.match(outputs[0].passages[0].source, /version 2/);
  assert.match(outputs[1].erreur, /non autorisé/, "nor run when asked for anyway");
  assert.equal(outputs[2].ok, true);

  const memory = JSON.parse((await inject({ method: "GET", url: "/api/agents/config" })).body).agents.find((agent) => agent.id === "commercial").memory;
  assert.equal(memory[0].text, "La direction demande souvent le prix du lit château.");
  assert.equal((await inject({ method: "DELETE", url: `/api/agents/commercial/memory/${memory[0].id}` })).statusCode, 200);
  assert.equal((await inject({ method: "PUT", url: "/api/agents/inconnu/config", payload: {} })).statusCode, 404);
});

test("only the direction changes an agent's settings", async (t) => {
  const repository = new InMemoryRepository();
  const { app } = await buildAuthenticatedApi({ repository, clock });
  t.after(() => app.close());
  const operator = await createAuthenticatedUser(repository, { id: "karim", role: "operator" });
  const asOperator = (options) => app.inject({ ...options, headers: { ...operator.headers } });
  assert.equal((await asOperator({ method: "GET", url: "/api/agents/config" })).statusCode, 200);
  const refused = await asOperator({ method: "PUT", url: "/api/agents/commercial/config", payload: { instructions: "Remise de 30 % pour tous." } });
  assert.equal(refused.statusCode, 403);
  assert.equal((await asOperator({ method: "POST", url: "/api/agents/commercial/documents", payload: { name: "x.txt", data: dataUrl("x") } })).statusCode, 403);
});
