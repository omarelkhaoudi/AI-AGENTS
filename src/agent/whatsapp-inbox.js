import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";

// What went through the company's WhatsApp number (data/whatsapp.json): every
// message received by the webhook and every message sent from the cockpit or
// by the Director, plus which Director conversation each number of the
// direction is in. Meta may call the webhook twice for the same message; the
// ids already seen are kept so it is handled once.
//
// What the Director prepared for a number of the direction and that waits for
// its word on WhatsApp (« valide », « envoie », « annule ») is kept here too,
// two days at most, so a restart between the question and the answer loses
// nothing.

export const DEFAULT_WHATSAPP_PATH = join(DATA_DIR, "whatsapp.json");
const MAX_MESSAGES = 1000;
const MAX_SEEN = 2000;

const MAX_PENDING = 8;
const PENDING_HOURS = 48;

const EMPTY = Object.freeze({ messages: [], conversations: {}, seen: [], pending: {}, held: {} });

// Messages held for a number outside WhatsApp's 24-hour window, until the
// person answers the template: 30 days, 20 per number at most.
const HELD_DAYS = 30;
const MAX_HELD = 20;

export function createMemoryWhatsAppInbox({ clock = () => new Date() } = {}) {
  return createInbox({ book: createMemoryJsonBook(EMPTY), clock });
}

export function createFileWhatsAppInbox({ path = DEFAULT_WHATSAPP_PATH, clock = () => new Date() } = {}) {
  return createInbox({ book: createFileJsonBook(path, EMPTY), clock });
}

function createInbox({ book, clock }) {
  return Object.freeze({
    // Records a received message once. Returns null when Meta sent it before.
    async receive({ metaId, number, name = "", sender, agent = null, type = "text", text = "", at = null }) {
      return book.change((state) => {
        if (metaId && state.seen.includes(metaId)) {
          return null;
        }
        if (metaId) {
          state.seen.push(metaId);
          if (state.seen.length > MAX_SEEN) {
            state.seen.splice(0, state.seen.length - MAX_SEEN);
          }
        }
        return push(state, { direction: "in", metaId: metaId ?? null, number, name, sender, agent, type, text, at: at ?? clock().toISOString(), receivedAt: clock().toISOString() });
      });
    },

    // status: sent (Meta took it) or failed (with the reason).
    async sent({ number, name = "", text, by, kind = "autre", status = "sent", metaId = null, error = null }) {
      return book.change((state) => push(state, { direction: "out", metaId, number, name, text, by, kind, status, error, at: clock().toISOString() }));
    },

    // A message that could not leave (the 24-hour window is closed) and waits
    // for the person to answer the template. It shows as « en attente ».
    async hold({ number, name = "", text, by, kind = "autre" }) {
      return book.change((state) => {
        const line = push(state, { direction: "out", metaId: null, number, name, text, by, kind, status: "waiting", error: null, at: clock().toISOString() });
        state.held ??= {};
        const kept = heldFresh(state.held[number], clock());
        state.held[number] = [...kept, { id: line.id, name, text, by, kind, at: line.at }].slice(-MAX_HELD);
        return line;
      });
    },

    async heldFor(number) {
      return heldFresh((await book.load()).held?.[number], clock());
    },

    // The held message left (sent) or could not (failed): its line says so.
    async release(number, id, { status, metaId = null, error = null }) {
      return book.change((state) => {
        state.held ??= {};
        const left = heldFresh(state.held[number], clock()).filter((item) => item.id !== id);
        if (left.length > 0) {
          state.held[number] = left;
        } else {
          delete state.held[number];
        }
        const index = state.messages.findIndex((message) => message.id === id);
        if (index >= 0) {
          state.messages[index] = { ...state.messages[index], status, metaId, error, deliveredAt: clock().toISOString() };
        }
      });
    },

    // What a voice note said, once transcribed, kept on the received message.
    async transcribed(id, text) {
      return book.change((state) => {
        const index = state.messages.findIndex((message) => message.id === id);
        if (index >= 0) {
          state.messages[index] = { ...state.messages[index], text, transcribed: true };
        }
      });
    },

    async messages({ limit = 200 } = {}) {
      return (await book.load()).messages.slice(-limit).reverse();
    },

    async conversationOf(number) {
      return (await book.load()).conversations[number] ?? null;
    },

    async setConversation(number, conversationId) {
      return book.change((state) => {
        state.conversations[number] = conversationId;
      });
    },

    // What waits for this number's word, oldest first. An item has a key (a
    // newer one with the same key replaces it) and whatever is needed to act.
    async pendingOf(number) {
      return fresh((await book.load()).pending?.[number], clock());
    },

    async addPending(number, items) {
      return book.change((state) => {
        state.pending ??= {};
        const kept = fresh(state.pending[number], clock()).filter((item) => !items.some((added) => added.key === item.key));
        state.pending[number] = [...kept, ...items.map((item) => ({ ...item, at: clock().toISOString() }))].slice(-MAX_PENDING);
      });
    },

    async removePending(number, keys) {
      return book.change((state) => {
        state.pending ??= {};
        const left = fresh(state.pending[number], clock()).filter((item) => !keys.includes(item.key));
        if (left.length > 0) {
          state.pending[number] = left;
        } else {
          delete state.pending[number];
        }
      });
    }
  });
}

function heldFresh(items, now) {
  const limit = now.getTime() - HELD_DAYS * 24 * 60 * 60 * 1000;
  return (Array.isArray(items) ? items : []).filter((item) => new Date(item.at).getTime() >= limit);
}

function fresh(items, now) {
  const limit = now.getTime() - PENDING_HOURS * 60 * 60 * 1000;
  return (Array.isArray(items) ? items : []).filter((item) => new Date(item.at).getTime() >= limit);
}

function push(state, entry) {
  const line = Object.freeze({ id: randomUUID(), ...entry });
  state.messages.push(line);
  if (state.messages.length > MAX_MESSAGES) {
    state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  }
  return line;
}
