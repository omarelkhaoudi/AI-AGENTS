import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";

// What came in on the company's Facebook Page and Instagram account
// (data/reseaux.json): the messages and comments the webhook received, the
// replies the Community Manager prepared and what became of them once the
// direction decided, and the prospects the CM qualified from them for the
// Commercial (CDC V2, section 7: message Instagram → CM → fiche prospect →
// Commercial → devis). Meta may call the webhook twice for the same event; an
// event already recorded is not recorded again.

export const DEFAULT_SOCIAL_PATH = join(DATA_DIR, "reseaux.json");
const MAX_ITEMS = 1000;
const MAX_REPLIES = 1000;

export const SOCIAL_ITEM_STATUSES = Object.freeze(["nouveau", "reponse_a_valider", "repondu", "classe"]);
export const SOCIAL_REPLY_STATUSES = Object.freeze(["a_valider", "envoyee", "refusee", "echec"]);
export const PROSPECT_STATUSES = Object.freeze(["nouveau", "qualifie", "transmis", "devis", "gagne", "perdu"]);
const PROSPECT_FIELDS = Object.freeze(["nom", "compte", "reseau", "telephone", "ville", "besoin", "produit", "budget", "notes"]);

const EMPTY = Object.freeze({ items: [], replies: [], prospects: [], nextProspect: 1 });

export function createMemorySocialInbox({ clock = () => new Date() } = {}) {
  return createSocialInbox({ book: createMemoryJsonBook(EMPTY), clock });
}

export function createFileSocialInbox({ path = DEFAULT_SOCIAL_PATH, clock = () => new Date() } = {}) {
  return createSocialInbox({ book: createFileJsonBook(path, EMPTY), clock });
}

function createSocialInbox({ book, clock }) {
  return Object.freeze({
    // Records the events the webhook parsed; returns only those not seen yet.
    async record(events) {
      return book.change((state) => {
        const added = [];
        for (const event of events) {
          if (state.items.some((item) => item.platform === event.platform && item.externalId === event.externalId)) {
            continue;
          }
          const item = { id: randomUUID().slice(0, 8), ...event, status: "nouveau", prospect: null, receivedAt: clock().toISOString() };
          state.items.push(item);
          added.push(item);
        }
        if (state.items.length > MAX_ITEMS) {
          state.items.splice(0, state.items.length - MAX_ITEMS);
        }
        return added;
      });
    },

    // Newest first. status "a_traiter" means what still waits for an answer.
    async list({ status = "", limit = 50 } = {}) {
      const { items } = await book.load();
      return items
        .filter((item) => !status || (status === "a_traiter" ? item.status === "nouveau" : item.status === status))
        .slice(-limit)
        .reverse();
    },

    async item(id) {
      return (await book.load()).items.find((item) => item.id === id) ?? null;
    },

    async setItemStatus(id, status) {
      if (!SOCIAL_ITEM_STATUSES.includes(status)) {
        throw new Error(`Statut inconnu : ${status}.`);
      }
      return book.change((state) => {
        const item = state.items.find((entry) => entry.id === id);
        if (item) {
          item.status = status;
        }
        return item ?? null;
      });
    },

    // A reply the CM prepared, waiting for the direction's word.
    async addReply({ itemId, text, by, approvalId = null }) {
      return book.change((state) => {
        const item = state.items.find((entry) => entry.id === itemId);
        if (!item) {
          return null;
        }
        const reply = { id: randomUUID(), itemId, platform: item.platform, kind: item.kind, text, by, status: "a_valider", approvalId, preparedAt: clock().toISOString(), decidedAt: null, externalId: null, error: null };
        state.replies.push(reply);
        if (state.replies.length > MAX_REPLIES) {
          state.replies.splice(0, state.replies.length - MAX_REPLIES);
        }
        item.status = "reponse_a_valider";
        return reply;
      });
    },

    async setReplyApproval(id, approvalId) {
      return book.change((state) => {
        const reply = state.replies.find((entry) => entry.id === id);
        if (reply) {
          reply.approvalId = approvalId;
        }
        return reply ?? null;
      });
    },

    async reply(id) {
      return (await book.load()).replies.find((reply) => reply.id === id) ?? null;
    },

    async replies({ status = "", limit = 50 } = {}) {
      const { replies } = await book.load();
      return replies.filter((reply) => !status || reply.status === status).slice(-limit).reverse();
    },

    // envoyee (Meta took it), refusee (by the direction) or echec (Meta
    // refused it). The message goes back to "nouveau" unless it was answered.
    async settleReply(id, { status, externalId = null, error = null, by = "" }) {
      if (!["envoyee", "refusee", "echec"].includes(status)) {
        throw new Error(`Statut inconnu : ${status}.`);
      }
      return book.change((state) => {
        const reply = state.replies.find((entry) => entry.id === id);
        if (!reply || reply.status !== "a_valider") {
          return null;
        }
        Object.assign(reply, { status, externalId, error, decidedBy: by, decidedAt: clock().toISOString() });
        const item = state.items.find((entry) => entry.id === reply.itemId);
        if (item) {
          item.status = status === "envoyee" ? "repondu" : "nouveau";
        }
        return reply;
      });
    },

    // Creates a prospect (P-001…) or completes one. Every change of status is
    // kept in its history with who made it.
    async upsertProspect({ id = "", itemId = "", fields = {}, status = "", by, note = "" }) {
      if (status && !PROSPECT_STATUSES.includes(status)) {
        throw new Error(`Statut inconnu : ${status}. Statuts possibles : ${PROSPECT_STATUSES.join(", ")}.`);
      }
      return book.change((state) => {
        const now = clock().toISOString();
        let prospect = id ? state.prospects.find((entry) => entry.id === id) : null;
        if (id && !prospect) {
          return null;
        }
        const item = itemId ? state.items.find((entry) => entry.id === itemId) : null;
        if (!prospect) {
          prospect = { id: `P-${String(state.nextProspect).padStart(3, "0")}`, status: "nouveau", items: [], history: [{ at: now, by, status: "nouveau", note: note || "Fiche créée." }], createdAt: now, updatedAt: now };
          for (const field of PROSPECT_FIELDS) {
            prospect[field] = "";
          }
          if (item) {
            prospect.reseau = item.platform;
            prospect.compte = item.senderName || item.senderId;
          }
          state.nextProspect += 1;
          state.prospects.push(prospect);
        }
        for (const field of PROSPECT_FIELDS) {
          const value = typeof fields[field] === "string" ? fields[field].trim() : "";
          if (value) {
            prospect[field] = value;
          }
        }
        if (item) {
          if (!prospect.items.includes(item.id)) {
            prospect.items.push(item.id);
          }
          item.prospect = prospect.id;
        }
        if (status && status !== prospect.status) {
          prospect.status = status;
          prospect.history.push({ at: now, by, status, note });
        } else if (note && prospect.history.at(-1)?.note !== note) {
          prospect.history.push({ at: now, by, status: prospect.status, note });
        }
        prospect.updatedAt = now;
        return structuredClone(prospect);
      });
    },

    async prospect(id) {
      return (await book.load()).prospects.find((prospect) => prospect.id === id) ?? null;
    },

    async prospects({ status = "", limit = 100 } = {}) {
      const { prospects } = await book.load();
      return prospects.filter((prospect) => !status || prospect.status === status).slice(-limit).reverse();
    }
  });
}
