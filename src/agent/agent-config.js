import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";

// Each agent as the direction configures it, without programming (CDC V2,
// section 9): five things of its own.
// - its role: what the code gives it, plus the direction's standing
//   instructions (« consignes »);
// - its reference documents (catalogue, price list, procedures, technical
//   sheets): imported as PDF, Word, Excel or text, read into text, searched by
//   the agent with their source and version;
// - its tools and rights: a tool the direction forbids is taken from it;
// - its working memory: what it noted to keep from one mission to the next.
//
// A document is never taken as true for ever: importing a newer version of a
// document of the same title retires the older one (« périmé »), an old
// version is only ever read as history, and two current documents that
// disagree are a question for the direction, never a guess.
//
// The book (data/agents.json) keeps the settings and the documents' records;
// the documents' text sits beside it, one file each (data/agents-documents/).

export const DEFAULT_AGENT_CONFIG_PATH = join(DATA_DIR, "agents.json");
export const DEFAULT_AGENT_DOCUMENTS_DIR = join(DATA_DIR, "agents-documents");
export const MAX_INSTRUCTIONS_CHARS = 4000;
export const MAX_DOCUMENT_CHARS = 200_000;
const MAX_MEMORY_NOTES = 40;
const MAX_NOTE_CHARS = 500;
const PASSAGE_CHARS = 1200;
const DOCUMENT_STATUSES = Object.freeze(["en_vigueur", "perime"]);

export class AgentConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AgentConfigError";
    this.code = code;
  }
}

const EMPTY = Object.freeze({ agents: {}, documents: [], memory: [] });

export function createMemoryAgentConfig({ clock = () => new Date(), agents = [] } = {}) {
  const texts = new Map();
  return createAgentConfig({
    book: createMemoryJsonBook(EMPTY),
    texts: { read: async (id) => texts.get(id) ?? "", write: async (id, text) => void texts.set(id, text) },
    clock,
    agents
  });
}

export function createFileAgentConfig({ path = DEFAULT_AGENT_CONFIG_PATH, dir = DEFAULT_AGENT_DOCUMENTS_DIR, clock = () => new Date(), agents = [] } = {}) {
  const file = (id) => join(dir, `${id.replace(/[^\w-]/g, "")}.txt`);
  return createAgentConfig({
    book: createFileJsonBook(path, EMPTY),
    texts: {
      async read(id) {
        try {
          return await readFile(file(id), "utf8");
        } catch (error) {
          if (error.code === "ENOENT") return "";
          throw error;
        }
      },
      async write(id, text) {
        await mkdir(dir, { recursive: true });
        await writeFile(`${file(id)}.tmp`, text);
        await rename(`${file(id)}.tmp`, file(id));
      }
    },
    clock,
    agents
  });
}

function createAgentConfig({ book, texts, clock, agents }) {
  const known = (agent) => {
    if (agents.length > 0 && !agents.includes(agent)) {
      throw new AgentConfigError(`Agent inconnu : ${agent}.`, "AGENT_CONFIG_UNKNOWN_AGENT");
    }
  };

  return Object.freeze({
    // An agent's settings: its instructions and the tools it may not use.
    async settings(agent) {
      const state = await book.load();
      return settingsOf(state, agent);
    },

    async save(agent, { instructions, forbiddenTools, by = "direction" }) {
      known(agent);
      const consignes = typeof instructions === "string" ? instructions.trim() : undefined;
      if (consignes !== undefined && consignes.length > MAX_INSTRUCTIONS_CHARS) {
        throw new AgentConfigError(`Les consignes dépassent ${MAX_INSTRUCTIONS_CHARS} caractères.`, "AGENT_CONFIG_TOO_LONG");
      }
      return book.change((state) => {
        const current = settingsOf(state, agent);
        const next = {
          instructions: consignes ?? current.instructions,
          forbiddenTools: Array.isArray(forbiddenTools) ? [...new Set(forbiddenTools.map(String).filter(Boolean))].sort() : current.forbiddenTools,
          updatedAt: clock().toISOString(),
          updatedBy: by
        };
        state.agents[agent] = next;
        return next;
      });
    },

    // Imports a reference document read into text. A current document of the
    // same title becomes the previous version, retired.
    async addDocument(agent, { title, fileName = "", kind = "texte", text, validFrom = null, by = "direction" }) {
      known(agent);
      const name = typeof title === "string" ? title.trim().slice(0, 160) : "";
      const body = typeof text === "string" ? text.trim() : "";
      if (!name) {
        throw new AgentConfigError("Donnez un titre au document.", "AGENT_DOCUMENT_TITLE_MISSING");
      }
      if (!body) {
        throw new AgentConfigError("Le document ne contient aucun texte lisible.", "AGENT_DOCUMENT_EMPTY");
      }
      if (validFrom !== null && !/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) {
        throw new AgentConfigError("Date de validité illisible (AAAA-MM-JJ).", "AGENT_DOCUMENT_DATE_INVALID");
      }
      const clipped = body.length > MAX_DOCUMENT_CHARS ? body.slice(0, MAX_DOCUMENT_CHARS) : body;
      const id = randomUUID();
      await texts.write(id, clipped);
      return book.change((state) => {
        const previous = state.documents.filter((entry) => entry.agent === agent && sameTitle(entry.title, name));
        const current = previous.find((entry) => entry.status === "en_vigueur");
        const at = clock().toISOString();
        const sha = createHash("sha256").update(clipped).digest("hex");
        if (current && current.sha256 === sha) {
          throw new AgentConfigError(`« ${name} » est déjà importé à l'identique (version ${current.version}).`, "AGENT_DOCUMENT_DUPLICATE");
        }
        const document = {
          id,
          agent,
          title: name,
          fileName: String(fileName).slice(0, 160),
          kind,
          version: previous.reduce((max, entry) => Math.max(max, entry.version), 0) + 1,
          status: "en_vigueur",
          validFrom,
          replaces: current?.id ?? null,
          chars: clipped.length,
          truncated: body.length > clipped.length,
          sha256: sha,
          importedAt: at,
          importedBy: by
        };
        if (current) {
          current.status = "perime";
          current.retiredAt = at;
          current.replacedBy = id;
        }
        state.documents.push(document);
        return { ...document };
      });
    },

    async setDocumentStatus(agent, id, status, { by = "direction" } = {}) {
      if (!DOCUMENT_STATUSES.includes(status)) {
        throw new AgentConfigError(`Statut inconnu : ${status}.`, "AGENT_DOCUMENT_STATUS_UNKNOWN");
      }
      return book.change((state) => {
        const document = state.documents.find((entry) => entry.id === id && entry.agent === agent);
        if (!document) {
          throw new AgentConfigError("Document introuvable.", "AGENT_DOCUMENT_NOT_FOUND");
        }
        if (status === "en_vigueur") {
          // Two current versions of one document would contradict each other.
          for (const other of state.documents) {
            if (other !== document && other.agent === agent && sameTitle(other.title, document.title) && other.status === "en_vigueur") {
              other.status = "perime";
              other.retiredAt = clock().toISOString();
            }
          }
        }
        document.status = status;
        document[status === "perime" ? "retiredAt" : "restoredAt"] = clock().toISOString();
        document.statusBy = by;
        return { ...document };
      });
    },

    async documents(agent = null) {
      return (await book.load()).documents.filter((entry) => !agent || entry.agent === agent);
    },

    async documentText(id) {
      return texts.read(id);
    },

    // The passages of an agent's documents that best answer a search, with
    // their source. Current versions only, unless history is asked for.
    async search(agent, query, { includeRetired = false, limit = 5 } = {}) {
      const terms = termsOf(query);
      const documents = (await book.load()).documents.filter((entry) => entry.agent === agent && (includeRetired || entry.status === "en_vigueur"));
      if (terms.length === 0 || documents.length === 0) {
        return [];
      }
      const scored = [];
      for (const document of documents) {
        const text = await texts.read(document.id);
        const titleHits = terms.filter((term) => fold(document.title).includes(term)).length;
        for (const passage of passagesOf(text)) {
          const folded = fold(passage);
          const hits = terms.map((term) => occurrences(folded, term));
          const matched = hits.filter((count) => count > 0).length;
          if (matched === 0 && titleHits === 0) {
            continue;
          }
          scored.push({ document, passage, score: matched * 10 + hits.reduce((sum, count) => sum + Math.min(count, 5), 0) + titleHits * 3 });
        }
      }
      return scored
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map(({ document, passage }) => ({ document: { ...document }, passage }));
    },

    // A note the agent keeps for its next missions; the oldest go first.
    async remember(agent, note, { by = agent } = {}) {
      known(agent);
      const text = typeof note === "string" ? note.trim() : "";
      if (!text) {
        throw new AgentConfigError("La note est vide.", "AGENT_MEMORY_EMPTY");
      }
      if (text.length > MAX_NOTE_CHARS) {
        throw new AgentConfigError(`Une note tient en ${MAX_NOTE_CHARS} caractères.`, "AGENT_MEMORY_TOO_LONG");
      }
      return book.change((state) => {
        const entry = { id: randomUUID(), agent, text, at: clock().toISOString(), by };
        state.memory.push(entry);
        const mine = state.memory.filter((line) => line.agent === agent);
        if (mine.length > MAX_MEMORY_NOTES) {
          const drop = new Set(mine.slice(0, mine.length - MAX_MEMORY_NOTES).map((line) => line.id));
          state.memory = state.memory.filter((line) => !drop.has(line.id));
        }
        return entry;
      });
    },

    async forget(agent, id) {
      return book.change((state) => {
        const before = state.memory.length;
        state.memory = state.memory.filter((line) => !(line.id === id && line.agent === agent));
        if (state.memory.length === before) {
          throw new AgentConfigError("Note introuvable.", "AGENT_MEMORY_NOT_FOUND");
        }
        return true;
      });
    },

    async memory(agent) {
      return (await book.load()).memory.filter((line) => line.agent === agent);
    },

    // What the agent is told before a mission: the direction's instructions,
    // the documents it can search, and its notes.
    async briefing(agent) {
      const state = await book.load();
      const { instructions } = settingsOf(state, agent);
      const current = state.documents.filter((entry) => entry.agent === agent && entry.status === "en_vigueur");
      const notes = state.memory.filter((line) => line.agent === agent).slice(-15);
      return [
        instructions ? `Consignes de la direction pour ton métier (elles priment sur tes habitudes, jamais sur les règles de sécurité et de validation) :\n${instructions}` : "",
        current.length > 0
          ? `Tes documents de référence en vigueur (cherche dedans avec documents_reference avant de répondre sur un prix, une procédure, une caractéristique) : ${current.map((entry) => `« ${entry.title} » v${entry.version}${entry.validFrom ? ` en vigueur depuis le ${entry.validFrom}` : ""}`).join(" ; ")}. Cite la source (titre et version) de ce que tu en tires. Si deux documents en vigueur se contredisent, ou un document et tes autres données, ne choisis pas : dis-le et demande à la direction lequel fait foi.`
          : "",
        notes.length > 0 ? ["Tes notes de travail (mémoire), de la plus ancienne à la plus récente :", ...notes.map((line) => `- ${line.at.slice(0, 10)} : ${line.text}`)].join("\n") : ""
      ].filter(Boolean);
    }
  });
}

function settingsOf(state, agent) {
  const saved = state.agents[agent] ?? {};
  return { instructions: saved.instructions ?? "", forbiddenTools: saved.forbiddenTools ?? [], updatedAt: saved.updatedAt ?? null, updatedBy: saved.updatedBy ?? null };
}

function sameTitle(left, right) {
  return fold(left).replace(/\s+/g, " ").trim() === fold(right).replace(/\s+/g, " ").trim();
}

function fold(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const STOP_WORDS = new Set(["les", "des", "une", "est", "pour", "dans", "avec", "sur", "par", "que", "qui", "quel", "quelle", "quels", "quelles", "son", "ses", "aux", "pas", "plus", "the", "and", "combien", "prix"]);

function termsOf(query) {
  const words = fold(query).split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  // A price question is still about prices: the word is kept when it is all
  // there is.
  const kept = words.length > 0 ? words : fold(query).split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
  return [...new Set(kept)].slice(0, 12);
}

function occurrences(text, term) {
  let count = 0;
  let index = text.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(term, index + term.length);
  }
  return count;
}

// Paragraphs gathered into passages of about PASSAGE_CHARS; a longer paragraph
// (a sheet's rows on one block) is cut on line ends.
function passagesOf(text) {
  const lines = String(text).split(/\n/);
  const passages = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > PASSAGE_CHARS && current) {
      passages.push(current);
      current = "";
    }
    current += `${current ? "\n" : ""}${line.slice(0, PASSAGE_CHARS)}`;
  }
  if (current.trim()) {
    passages.push(current);
  }
  return passages;
}
