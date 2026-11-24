import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";

// What left the company's e-mail address (data/emails.json): to whom, the
// subject, the text, the documents joined, who clicked, and whether the mail
// server took it. A failure is kept too, with its reason.

export const DEFAULT_EMAIL_PATH = join(DATA_DIR, "emails.json");
const MAX_MESSAGES = 1000;
const EMPTY = Object.freeze({ messages: [] });

export function createMemoryEmailOutbox({ clock = () => new Date() } = {}) {
  return createOutbox({ book: createMemoryJsonBook(EMPTY), clock });
}

export function createFileEmailOutbox({ path = DEFAULT_EMAIL_PATH, clock = () => new Date() } = {}) {
  return createOutbox({ book: createFileJsonBook(path, EMPTY), clock });
}

function createOutbox({ book, clock }) {
  return Object.freeze({
    // status: envoye (the server took it) or echec (with the reason).
    async record({ to, recipient = "", subject, text, documents = [], kind = "autre", by, status, messageId = null, error = null }) {
      return book.change((state) => {
        const entry = {
          number: state.messages.reduce((max, message) => Math.max(max, message.number), 0) + 1,
          to, recipient, subject, text, documents, kind, by, status, messageId, error,
          at: clock().toISOString()
        };
        state.messages.push(entry);
        if (state.messages.length > MAX_MESSAGES) {
          state.messages.splice(0, state.messages.length - MAX_MESSAGES);
        }
        return { ...entry };
      });
    },

    async messages({ limit = 100 } = {}) {
      return (await book.load()).messages.slice(-limit).reverse();
    }
  });
}
