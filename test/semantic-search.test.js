import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryAgentConfig } from "../src/agent/agent-config.js";
import { createOpenAiEmbedder, fuseRankings } from "../src/agent/semantic-search.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";

// A stand-in for the embeddings model: each text becomes how much it speaks
// of sleeping, of storing and of paying. Enough to tell meaning from words.
function fakeEmbedder() {
  const calls = [];
  return {
    calls,
    model: "fake-embedding",
    async embed(texts) {
      calls.push(texts.length);
      return texts.map((text) => {
        const t = text.toLowerCase();
        return [/lit|dormir|couchage|superpos/.test(t) ? 1 : 0, /armoire|ranger|penderie/.test(t) ? 1 : 0, /acompte|payer|règlement/.test(t) ? 1 : 0, 0.05];
      });
    }
  };
}

async function configWith(embedder) {
  const config = createMemoryAgentConfig({ agents: SPECIALIST_IDS });
  await config.addDocument("commercial", { title: "Lits", text: "Lit superposé 2 couchages, pin massif : 4 500 DH TTC." });
  await config.addDocument("commercial", { title: "Rangements", text: "Armoire 2 portes laquée : 3 000 DH TTC." });
  await config.addDocument("commercial", { title: "Conditions", text: "Acompte de 60 % à la commande, solde à la livraison." });
  config.useEmbedder(embedder);
  return config;
}

test("a question with none of the document's words finds the passage that means it", async () => {
  const question = "un meuble pour faire dormir deux enfants l'un au-dessus de l'autre";
  const byWords = createMemoryAgentConfig({ agents: SPECIALIST_IDS });
  await byWords.addDocument("commercial", { title: "Lits", text: "Lit superposé 2 couchages, pin massif : 4 500 DH TTC." });
  assert.deepEqual(await byWords.search("commercial", question), [], "no shared word: the search by words finds nothing");

  const embedder = fakeEmbedder();
  const config = await configWith(embedder);
  const found = await config.search("commercial", question);
  assert.equal(found[0].document.title, "Lits");
  assert.match(found[0].passage, /Lit superposé/);
  assert.ok(!found.some((entry) => entry.document.title === "Rangements"), "a passage far in meaning is left out");
});

test("the passages are embedded once, a word match still counts, and a failure leaves the search by words", async () => {
  const embedder = fakeEmbedder();
  const config = await configWith(embedder);
  await config.search("commercial", "combien d'acompte faut-il verser ?");
  assert.deepEqual(embedder.calls, [1, 1, 1, 1], "each document's passage, then the question");
  await config.search("commercial", "armoire laquée");
  assert.deepEqual(embedder.calls, [1, 1, 1, 1, 1], "the second search embeds its question only");

  const words = await config.search("commercial", "armoire laquée");
  assert.equal(words[0].document.title, "Rangements", "the word match and the meaning agree");

  const errors = [];
  const failing = createMemoryAgentConfig({ agents: SPECIALIST_IDS });
  await failing.addDocument("commercial", { title: "Rangements", text: "Armoire 2 portes laquée : 3 000 DH TTC." });
  failing.useEmbedder({ model: "down", embed: async () => { throw new Error("OpenAI injoignable"); } }, { onError: (error) => errors.push(error.message) });
  const fallback = await failing.search("commercial", "armoire");
  assert.equal(fallback[0].document.title, "Rangements");
  assert.deepEqual(errors, ["OpenAI injoignable"]);
});

test("the two rankings are fused: what both find comes first", () => {
  const fused = fuseRankings([["a", "b", "c"], ["c", "d", "a"]], { limit: 3 });
  assert.deepEqual(fused, ["a", "c", "b"]);
});

test("the OpenAI embedder asks for 512 dimensions in batches and records what it used", async () => {
  const requests = [];
  const used = [];
  const embedder = createOpenAiEmbedder({
    apiKey: "test-key",
    onUsage: (entry) => used.push(entry),
    clientFactory: async () => ({ embeddings: { create: async (payload) => {
      requests.push(payload);
      return { data: payload.input.map((_, index) => ({ index, embedding: [index, 1] })).reverse(), usage: { prompt_tokens: payload.input.length * 10 } };
    } } })
  });
  const vectors = await embedder.embed(Array.from({ length: 100 }, (_, index) => `passage ${index}`));
  assert.equal(requests.length, 2, "96 per call");
  assert.deepEqual([requests[0].model, requests[0].dimensions], ["text-embedding-3-small", 512]);
  assert.deepEqual(vectors[1], [1, 1], "put back in the order asked");
  assert.deepEqual(used.map((entry) => entry.usage.input_tokens), [960, 40]);
});
