import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";
import { queryTerms, rankPassages } from "./passage-search.js";
import { DEFAULT_TEMPLATE_ID, TeamTemplateError, allowedAgents, changeTeam, defaultTeam } from "./team-templates.js";

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
// Beside them: the tone it answers in, the tools whose actions wait for the
// direction's validation (« validation requise ») before they run, and the
// response tests the direction writes to check it answers as expected.
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
const MAX_TESTS = 20;
const MAX_HELD = 300;

// The tones the direction may choose for an agent: what the agent is told.
export const AGENT_TONES = Object.freeze({
  formel: Object.freeze({ label: "Formel", rule: "Ton formel : vouvoiement, phrases complètes, aucune familiarité ni emoji." }),
  chaleureux: Object.freeze({ label: "Chaleureux", rule: "Ton chaleureux et proche, toujours poli et vouvoyant : une phrase d'attention, puis l'essentiel." }),
  concis: Object.freeze({ label: "Concis", rule: "Ton concis : l'essentiel en trois phrases au plus ou une liste courte, sans préambule." }),
  pedagogique: Object.freeze({ label: "Pédagogique", rule: "Ton pédagogique : dire le pourquoi en mots simples, avec un exemple quand il aide." })
});
export const HELD_STATUSES = Object.freeze({ en_attente: "en attente de validation", executee: "validée et exécutée", refusee: "refusée", echouee: "validée, exécution en échec" });

export class AgentConfigError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AgentConfigError";
    this.code = code;
  }
}

const EMPTY = Object.freeze({ agents: {}, documents: [], memory: [], held: [] });

export function createMemoryAgentConfig({ clock = () => new Date(), agents = [], templateId = DEFAULT_TEMPLATE_ID, plan = null } = {}) {
  const texts = new Map();
  return createAgentConfig({
    book: createMemoryJsonBook(EMPTY),
    texts: { read: async (id) => texts.get(id) ?? "", write: async (id, text) => void texts.set(id, text) },
    clock,
    agents,
    templateId,
    plan
  });
}

export function createFileAgentConfig({ path = DEFAULT_AGENT_CONFIG_PATH, dir = DEFAULT_AGENT_DOCUMENTS_DIR, clock = () => new Date(), agents = [], templateId = DEFAULT_TEMPLATE_ID, plan = null } = {}) {
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
    agents,
    templateId,
    plan
  });
}

function createAgentConfig({ book, texts, clock, agents, templateId = DEFAULT_TEMPLATE_ID, plan = null }) {
  const known = (agent) => {
    if (agents.length > 0 && !agents.includes(agent)) {
      throw new AgentConfigError(`Agent inconnu : ${agent}.`, "AGENT_CONFIG_UNKNOWN_AGENT");
    }
  };

  // The company's team (section 10-E): its template's agents its plan opens,
  // until the direction turns one on or off. Kept once changed; an agent a
  // later plan no longer opens is left out of the team it reads.
  const teamOf = (state) => {
    const stored = Array.isArray(state.team?.active) ? state.team.active : defaultTeam(templateId, plan);
    const allowed = allowedAgents(templateId, plan);
    return stored.filter((agent) => allowed.includes(agent) && (agents.length === 0 || agents.includes(agent)));
  };

  return Object.freeze({
    templateId,
    plan,

    async team() {
      return teamOf(await book.load());
    },

    async isActive(agent) {
      return teamOf(await book.load()).includes(agent);
    },

    // Turns one agent on or off, within what the template and the plan allow.
    async setActive(agent, on, { by = "direction" } = {}) {
      known(agent);
      return book.change((state) => {
        let next;
        try {
          next = changeTeam(teamOf(state), agent, on === true, { templateId, plan });
        } catch (error) {
          if (error instanceof TeamTemplateError) {
            throw new AgentConfigError(error.message, error.code);
          }
          throw error;
        }
        state.team = { active: next, updatedAt: clock().toISOString(), updatedBy: by };
        return [...next];
      });
    },

    // An agent's settings: its instructions and the tools it may not use.
    async settings(agent) {
      const state = await book.load();
      return settingsOf(state, agent);
    },

    // A tool is allowed, held for validation, or forbidden: forbidden wins.
    async save(agent, { instructions, forbiddenTools, heldTools, tone, by = "direction" }) {
      known(agent);
      const consignes = typeof instructions === "string" ? instructions.trim() : undefined;
      if (consignes !== undefined && consignes.length > MAX_INSTRUCTIONS_CHARS) {
        throw new AgentConfigError(`Les consignes dépassent ${MAX_INSTRUCTIONS_CHARS} caractères.`, "AGENT_CONFIG_TOO_LONG");
      }
      if (tone !== undefined && tone !== "" && !Object.hasOwn(AGENT_TONES, tone)) {
        throw new AgentConfigError(`Ton : ${Object.keys(AGENT_TONES).join(", ")}, ou aucun.`, "AGENT_CONFIG_TONE_UNKNOWN");
      }
      const names = (list) => [...new Set(list.map(String).filter(Boolean))].sort();
      return book.change((state) => {
        const current = settingsOf(state, agent);
        const forbidden = Array.isArray(forbiddenTools) ? names(forbiddenTools) : current.forbiddenTools;
        const held = (Array.isArray(heldTools) ? names(heldTools) : current.heldTools).filter((name) => !forbidden.includes(name));
        const next = {
          ...(state.agents[agent] ?? {}),
          instructions: consignes ?? current.instructions,
          forbiddenTools: forbidden,
          heldTools: held,
          tone: tone ?? current.tone,
          updatedAt: clock().toISOString(),
          updatedBy: by
        };
        state.agents[agent] = next;
        return settingsOf(state, agent);
      });
    },

    // --- Actions held for the direction's validation -------------------------
    // An agent called a tool the direction wants to validate: the call is kept
    // with its arguments and runs only once the direction says yes.
    async holdAction(agent, { tool, args = {}, mission = "", by = agent }) {
      known(agent);
      return book.change((state) => {
        const held = (state.held ??= []);
        const action = { id: randomUUID(), number: held.reduce((max, entry) => Math.max(max, entry.number), 0) + 1, agent, tool: String(tool), args, mission: String(mission ?? "").slice(0, 400), status: "en_attente", by: String(by), at: clock().toISOString() };
        held.push(action);
        if (held.length > MAX_HELD) {
          const settled = held.findIndex((entry) => entry.status !== "en_attente");
          if (settled >= 0) {
            held.splice(settled, 1);
          }
        }
        return Object.freeze({ ...action });
      });
    },

    async heldActions({ status = null, agent = null } = {}) {
      return ((await book.load()).held ?? []).filter((entry) => (!status || entry.status === status) && (!agent || entry.agent === agent)).slice().reverse();
    },

    async heldAction(number) {
      const action = ((await book.load()).held ?? []).find((entry) => String(entry.number) === String(number));
      if (!action) {
        throw new AgentConfigError(`Aucune action n° ${number} en attente de validation.`, "AGENT_HELD_NOT_FOUND");
      }
      return action;
    },

    // The direction's decision, with what running it gave.
    async settleHeld(number, { status, result = null, reason = "", by = "direction" }) {
      if (!["executee", "refusee", "echouee"].includes(status)) {
        throw new AgentConfigError("Décision : exécutée, refusée ou en échec.", "AGENT_HELD_STATUS_UNKNOWN");
      }
      return book.change((state) => {
        const action = (state.held ?? []).find((entry) => String(entry.number) === String(number));
        if (!action) {
          throw new AgentConfigError(`Aucune action n° ${number} en attente de validation.`, "AGENT_HELD_NOT_FOUND");
        }
        if (action.status !== "en_attente") {
          throw new AgentConfigError(`L'action n° ${action.number} est déjà ${HELD_STATUSES[action.status]}.`, "AGENT_HELD_DECIDED");
        }
        Object.assign(action, { status, result, reason: String(reason ?? "").slice(0, 400), decidedBy: by, decidedAt: clock().toISOString() });
        return Object.freeze({ ...action });
      });
    },

    // --- Response tests -------------------------------------------------------
    // A question the direction asks the agent, with the words its answer must
    // contain and those it must not. Run on demand, in test mode: nothing the
    // agent would write is written.
    async addTest(agent, { question, expected = [], forbidden = [], by = "direction" }) {
      known(agent);
      const ask = typeof question === "string" ? question.trim().slice(0, 600) : "";
      const words = (list) => (Array.isArray(list) ? list : String(list ?? "").split(/[;\n]/)).map((entry) => String(entry).trim().slice(0, 80)).filter(Boolean).slice(0, 10);
      if (!ask) {
        throw new AgentConfigError("Écrire la question du test.", "AGENT_TEST_QUESTION_MISSING");
      }
      if (words(expected).length + words(forbidden).length === 0) {
        throw new AgentConfigError("Dire au moins un mot attendu ou interdit dans la réponse.", "AGENT_TEST_CHECK_MISSING");
      }
      return book.change((state) => {
        const settings = (state.agents[agent] ??= {});
        const tests = (settings.tests ??= []);
        if (tests.length >= MAX_TESTS) {
          throw new AgentConfigError(`${MAX_TESTS} tests au plus par agent.`, "AGENT_TEST_TOO_MANY");
        }
        const entry = { id: randomUUID(), question: ask, expected: words(expected), forbidden: words(forbidden), by, at: clock().toISOString(), lastRun: null };
        tests.push(entry);
        return Object.freeze({ ...entry });
      });
    },

    async removeTest(agent, id) {
      known(agent);
      return book.change((state) => {
        const tests = state.agents[agent]?.tests ?? [];
        const index = tests.findIndex((entry) => entry.id === id);
        if (index < 0) {
          throw new AgentConfigError("Test introuvable.", "AGENT_TEST_NOT_FOUND");
        }
        tests.splice(index, 1);
        return { removed: id };
      });
    },

    async recordTestRun(agent, id, run) {
      return book.change((state) => {
        const test = (state.agents[agent]?.tests ?? []).find((entry) => entry.id === id);
        if (test) {
          test.lastRun = { at: clock().toISOString(), ...run };
        }
        return test ? Object.freeze({ ...test }) : null;
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
      const documents = (await book.load()).documents.filter((entry) => entry.agent === agent && (includeRetired || entry.status === "en_vigueur"));
      if (queryTerms(query).length === 0 || documents.length === 0) {
        return [];
      }
      const candidates = [];
      for (const document of documents) {
        const text = await texts.read(document.id);
        for (const passage of passagesOf(text)) {
          candidates.push({ document, title: document.title, passage });
        }
      }
      return rankPassages(query, candidates, { limit })
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
      const { instructions, tone, heldTools } = settingsOf(state, agent);
      const current = state.documents.filter((entry) => entry.agent === agent && entry.status === "en_vigueur");
      const notes = state.memory.filter((line) => line.agent === agent).slice(-15);
      return [
        tone ? `${AGENT_TONES[tone].rule}` : "",
        heldTools.length > 0 ? `Ces outils passent par la validation de la direction : ${heldTools.join(", ")}. Quand tu les appelles, l'action est gardée en attente et ne s'exécute qu'après son accord : dis-le dans ta réponse, sans la présenter comme faite.` : "",
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
  return { instructions: saved.instructions ?? "", forbiddenTools: saved.forbiddenTools ?? [], heldTools: saved.heldTools ?? [], tone: saved.tone ?? "", tests: saved.tests ?? [], updatedAt: saved.updatedAt ?? null, updatedBy: saved.updatedBy ?? null };
}

// A test answer checked against its words, without accents or case: every
// expected word must be there, no forbidden one.
export function checkAnswer(answer, { expected = [], forbidden = [] }) {
  const said = fold(answer).replace(/\s+/g, " ");
  const has = (word) => said.includes(fold(word).replace(/\s+/g, " ").trim());
  const missing = expected.filter((word) => !has(word));
  const found = forbidden.filter((word) => has(word));
  return { passed: missing.length === 0 && found.length === 0, missing, found };
}

function sameTitle(left, right) {
  return fold(left).replace(/\s+/g, " ").trim() === fold(right).replace(/\s+/g, " ").trim();
}

function fold(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
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
