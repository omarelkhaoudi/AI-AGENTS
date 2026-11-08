import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";
import { normalizeWhatsAppNumber } from "./whatsapp.js";

// The team book (Hiba's request of 09/11/2026): each agent is a head of trade
// that carries its own work and knows what the others did, and each one is tied
// to a real person of the company, who receives its tasks and reports back.
//
// Two things are kept: who the person behind each agent is (name, role,
// WhatsApp number), and the team's activity feed — every mission an agent
// received and what it answered, every money movement recorded, every anomaly
// analysed and rule decided. The feed is what each agent is told about the
// others before it starts a mission.

export const DEFAULT_TEAM_PATH = join(DATA_DIR, "equipe.json");
const MAX_ACTIVITY = 600;

export class TeamBookError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TeamBookError";
    this.code = code;
  }
}

const EMPTY = Object.freeze({ members: {}, activity: [] });

export function createMemoryTeamBook({ clock = () => new Date(), agents = [] } = {}) {
  return createTeamBook({ book: createMemoryJsonBook(EMPTY), clock, agents });
}

export function createFileTeamBook({ path = DEFAULT_TEAM_PATH, clock = () => new Date(), agents = [] } = {}) {
  return createTeamBook({ book: createFileJsonBook(path, EMPTY), clock, agents });
}

function createTeamBook({ book, clock, agents }) {
  const known = (agent) => agents.length === 0 || agents.includes(agent);

  return Object.freeze({
    // The person behind an agent. An empty name unlinks them.
    async link(agent, { name = "", role = "", phone = "", by = "direction" } = {}) {
      if (!known(agent)) {
        throw new TeamBookError(`Agent inconnu : ${agent}.`, "TEAM_AGENT_UNKNOWN");
      }
      const digits = text(phone) ? normalizeWhatsAppNumber(phone) : "";
      if (digits === null) {
        throw new TeamBookError("Numéro WhatsApp illisible : écrire par exemple 06 12 34 56 78 ou +212 6 12 34 56 78.", "TEAM_PHONE_INVALID");
      }
      return book.change((state) => {
        const at = clock().toISOString();
        if (!text(name)) {
          const previous = state.members[agent];
          delete state.members[agent];
          if (previous) {
            push(state, { at, agent, kind: "equipe", text: `${previous.name} n'est plus relié(e) à cet agent.`, by });
          }
          return null;
        }
        const member = { name: text(name), role: text(role), phone: digits, linkedAt: at, linkedBy: by };
        state.members[agent] = member;
        push(state, { at, agent, kind: "equipe", text: `Relié(e) à ${member.name}${member.role ? ` (${member.role})` : ""}.`, by });
        return Object.freeze({ ...member });
      });
    },

    async members() {
      return (await book.load()).members;
    },

    async member(agent) {
      return (await book.load()).members[agent] ?? null;
    },

    // kind: mission, caisse, amelioration, atelier, document, equipe.
    // detail: what came of it (an agent's answer), kept short.
    async log({ agent, kind, text: line, detail = "", ref = "", by = agent }) {
      if (!text(line)) {
        return null;
      }
      return book.change((state) => push(state, { at: clock().toISOString(), agent, kind, text: text(line).slice(0, 400), detail: text(detail).slice(0, 700), ref: text(ref), by }));
    },

    async activity({ agent = null, limit = 50, since = null } = {}) {
      return (await book.load()).activity
        .filter((entry) => (!agent || entry.agent === agent) && (!since || entry.at >= since))
        .slice(-limit)
        .reverse();
    },

    // What the rest of the team did lately, as an agent reads it before a
    // mission: the last entries of the other agents over the past week.
    async newsFor(agent, { limit = 12 } = {}) {
      const since = new Date(clock().getTime() - 7 * 24 * 3600 * 1000).toISOString();
      const entries = (await book.load()).activity.filter((entry) => entry.agent !== agent && entry.at >= since).slice(-limit);
      return entries;
    }
  });
}

function push(state, entry) {
  const line = Object.freeze({ id: randomUUID(), ...entry });
  state.activity.push(line);
  if (state.activity.length > MAX_ACTIVITY) {
    state.activity.splice(0, state.activity.length - MAX_ACTIVITY);
  }
  return line;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
