import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";

// What went through the company's WhatsApp number (data/whatsapp.json): every
// message received by the webhook and every message sent from the cockpit or
// by the Director, plus which Director conversation each number of the
// direction is in. Meta may call the webhook twice for the same message; the
// ids already seen are kept so it is handled once.

export const DEFAULT_WHATSAPP_PATH = join(DATA_DIR, "whatsapp.json");
const MAX_MESSAGES = 1000;
const MAX_SEEN = 2000;

const EMPTY = Object.freeze({ messages: [], conversations: {}, seen: [] });

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
    }
  });
}

function push(state, entry) {
  const line = Object.freeze({ id: randomUUID(), ...entry });
  state.messages.push(line);
  if (state.messages.length > MAX_MESSAGES) {
    state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  }
  return line;
}
