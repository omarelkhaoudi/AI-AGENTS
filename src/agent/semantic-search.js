import { createHash } from "node:crypto";

// Search by meaning in the agents' reference documents (CDC V2, section 11:
// « recherche documentaire vectorielle »), beside the search by words of
// passage-search.js. Each passage gets an embedding (OpenAI, the agents' key),
// computed once and kept beside the document's text; a question gets its own,
// and the passages nearest in meaning come up even without a shared word
// (« un lit pour deux enfants » finds « lit superposé »).
//
// The two rankings are fused (reciprocal rank fusion): a passage both find
// comes first. Without a key, or when OpenAI does not answer, the search by
// words works alone, as before: the meaning only ever adds.

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
// Fewer dimensions than the model's 1536: a tenth of the storage, nearly the
// same ranking for passages of a catalogue.
export const EMBEDDING_DIMENSIONS = 512;
const BATCH = 96;
const FUSION_K = 60;

export function createOpenAiEmbedderFromEnv({ env = process.env, onUsage = null, clientFactory = defaultClientFactory } = {}) {
  const apiKey = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  if (apiKey === "" || env.HKIDS_SEMANTIC_SEARCH === "off") {
    return null;
  }
  const model = typeof env.OPENAI_EMBEDDING_MODEL === "string" && env.OPENAI_EMBEDDING_MODEL.trim() !== "" ? env.OPENAI_EMBEDDING_MODEL.trim() : DEFAULT_EMBEDDING_MODEL;
  return createOpenAiEmbedder({ apiKey, model, onUsage, clientFactory });
}

export function createOpenAiEmbedder({ apiKey, model = DEFAULT_EMBEDDING_MODEL, onUsage = null, clientFactory = defaultClientFactory }) {
  let client = null;
  return Object.freeze({
    model,
    async embed(texts) {
      client ??= await clientFactory({ apiKey });
      const vectors = [];
      for (let start = 0; start < texts.length; start += BATCH) {
        const result = await client.embeddings.create({ model, input: texts.slice(start, start + BATCH), dimensions: EMBEDDING_DIMENSIONS });
        if (typeof onUsage === "function" && result?.usage) {
          await Promise.resolve(onUsage({ model, usage: { input_tokens: result.usage.prompt_tokens ?? result.usage.total_tokens ?? 0, output_tokens: 0 } })).catch(() => {});
        }
        vectors.push(...result.data.sort((a, b) => a.index - b.index).map((entry) => entry.embedding));
      }
      return vectors;
    }
  });
}

export function passageKey(passage) {
  return createHash("sha1").update(passage).digest("hex").slice(0, 20);
}

// The embeddings of a document's passages: those already kept are reused, the
// others computed in one call and kept. A change of model starts over.
export async function passageVectors({ embedder, store, documentId, passages }) {
  const kept = (await store.read(documentId)) ?? null;
  const known = kept?.model === embedder.model ? kept.vectors ?? {} : {};
  const missing = [...new Set(passages.map(passageKey))].filter((key) => !known[key]);
  if (missing.length > 0) {
    const texts = missing.map((key) => passages.find((passage) => passageKey(passage) === key));
    const computed = await embedder.embed(texts);
    missing.forEach((key, index) => {
      known[key] = computed[index].map((value) => Math.round(value * 1e5) / 1e5);
    });
    // Only the passages the document has now are kept.
    const current = new Set(passages.map(passageKey));
    await store.write(documentId, { model: embedder.model, vectors: Object.fromEntries(Object.entries(known).filter(([key]) => current.has(key))) });
  }
  return passages.map((passage) => known[passageKey(passage)]);
}

export function cosine(left, right) {
  let dot = 0;
  let a = 0;
  let b = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index] * right[index];
    a += left[index] * left[index];
    b += right[index] * right[index];
  }
  return a > 0 && b > 0 ? dot / Math.sqrt(a * b) : 0;
}

// The candidates ranked by meaning, nearest first. Kept: those near the
// question (minScore) and near the best one (within margin). Measured on the
// catalogue's own lines, a bed question gives the bed 0.54 and a wardrobe
// 0.38: the wardrobe is not an answer, only a neighbour.
export function rankByMeaning(queryVector, candidates, vectors, { minScore = 0.3, margin = 0.12 } = {}) {
  const scored = candidates.map((candidate, index) => ({ candidate, score: vectors[index] ? cosine(queryVector, vectors[index]) : 0 }));
  const best = Math.max(0, ...scored.map((entry) => entry.score));
  return scored
    .filter((entry) => entry.score >= Math.max(minScore, best - margin))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.candidate);
}

// Reciprocal rank fusion: each list gives 1 / (k + rank); a candidate in both
// lists adds both.
export function fuseRankings(rankings, { limit = 5, key = (candidate) => candidate } = {}) {
  const scores = new Map();
  for (const ranking of rankings) {
    ranking.forEach((candidate, index) => {
      const id = key(candidate);
      const entry = scores.get(id) ?? { candidate, score: 0 };
      entry.score += 1 / (FUSION_K + index + 1);
      scores.set(id, entry);
    });
  }
  return [...scores.values()].sort((left, right) => right.score - left.score).slice(0, limit).map((entry) => entry.candidate);
}

async function defaultClientFactory({ apiKey }) {
  const { default: OpenAI } = await import("openai");
  return new OpenAI({ apiKey });
}
