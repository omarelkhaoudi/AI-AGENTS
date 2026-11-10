import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { roundMoney } from "../documents/document-calculations.js";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";
import { createFileReceiptStore, createMemoryReceiptStore } from "./receipt-store.js";

// The cash book of H KIDS (Hiba's request of 09/11/2026): the boss announces
// each money in or out to the Director, the Director has Finance record it,
// and the balance of the day is there every day.
//
// Each line is one movement: in or out, its amount in dirhams, what it is, how
// it was paid, who paid or was paid, and the sale it belongs to. A line is
// never erased: a mistake is cancelled with its reason and stays in the book.
// The balance of a day is computed from the lines, never typed: the opening
// balance is everything before that day, the closing balance adds the day.
//
// An expense (CDC V1.1, section 6) goes through four states, in order:
// declared (announced), justified (a receipt or invoice is joined), approved
// (by a person of the direction, in the cockpit, required above the alert
// threshold) and reconciled (found on the bank statement or in the cash
// count). An agent may declare and join a receipt; only a person approves or
// reconciles.

export const DEFAULT_CASH_PATH = join(DATA_DIR, "caisse.json");

export const CASH_CATEGORIES = Object.freeze({
  entree: Object.freeze({
    acompte_client: "Acompte client",
    solde_client: "Solde client",
    vente_comptant: "Vente au comptant",
    apport: "Apport",
    autre_entree: "Autre entrée"
  }),
  sortie: Object.freeze({
    achat_matiere: "Achat de matières",
    fournisseur: "Fournisseur / sous-traitant",
    salaire: "Salaires",
    loyer: "Loyer",
    transport: "Transport et livraison",
    charges: "Charges (eau, électricité, téléphone…)",
    impots_taxes: "Impôts et taxes",
    autre_sortie: "Autre sortie"
  })
});

// The balance the book starts from, the day Hiba begins with it. It counts in
// the balance, not in the day's takings.
export const OPENING_CATEGORY = "solde_depart";

// An expense of these categories is confidential whoever records it; any other
// expense may be marked so. Only the direction (the view_confidential right)
// sees its amount, what it is and who was paid; the others see a masked line,
// still counted in the balances, since the cash in hand must stay right.
export const CONFIDENTIAL_CATEGORIES = Object.freeze(["salaire"]);
export const CONFIDENTIAL_CATEGORY = "confidentiel";

export const EXPENSE_STATUSES = Object.freeze({ declaree: "Déclarée", justifiee: "Justifiée", approuvee: "Approuvée", rapprochee: "Rapprochée" });

// An expense of this amount or more is flagged and waits for the direction's
// approval. HKIDS_EXPENSE_ALERT_DH changes it.
export const DEFAULT_EXPENSE_THRESHOLD = 2000;

// What a proof of payment may be: a photo of the receipt or the invoice as PDF.
export const RECEIPT_TYPES = Object.freeze({ "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" });
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

export const CASH_METHODS = Object.freeze({ especes: "Espèces", virement: "Virement", cheque: "Chèque", carte: "Carte", autre: "Autre" });

export class CashBookError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CashBookError";
    this.code = code;
  }
}

export function createMemoryCashBook({ clock = () => new Date(), expenseThreshold = DEFAULT_EXPENSE_THRESHOLD } = {}) {
  return createCashBook({ book: createMemoryJsonBook({ entries: [] }), receipts: createMemoryReceiptStore(), clock, expenseThreshold });
}

export function createFileCashBook({ path = DEFAULT_CASH_PATH, receiptsDir = undefined, clock = () => new Date(), expenseThreshold = DEFAULT_EXPENSE_THRESHOLD } = {}) {
  return createCashBook({ book: createFileJsonBook(path, { entries: [] }), receipts: createFileReceiptStore(receiptsDir ? { dir: receiptsDir } : {}), clock, expenseThreshold });
}

function createCashBook({ book, receipts, clock, expenseThreshold }) {
  const today = () => localDay(clock());
  const threshold = Number.isFinite(Number(expenseThreshold)) && Number(expenseThreshold) > 0 ? roundMoney(Number(expenseThreshold)) : DEFAULT_EXPENSE_THRESHOLD;
  const find = (state, reference) => {
    const entry = state.entries.find((other) => other.id === reference || String(other.number) === String(reference));
    if (!entry) {
      throw new CashBookError(`Aucun mouvement n° ${reference} au journal de caisse.`, "CASH_ENTRY_NOT_FOUND");
    }
    if (entry.cancelled) {
      throw new CashBookError(`Le mouvement n° ${entry.number} est annulé.`, "CASH_ENTRY_CANCELLED");
    }
    return entry;
  };
  const expense = (state, reference) => {
    const entry = find(state, reference);
    if (entry.kind !== "sortie") {
      throw new CashBookError(`Le mouvement n° ${entry.number} est une entrée : seule une dépense s'approuve et se rapproche.`, "CASH_NOT_AN_EXPENSE");
    }
    return entry;
  };

  return Object.freeze({
    today,
    expenseThreshold: threshold,

    // kind: entree | sortie. day: JJ/MM/AAAA or AAAA-MM-JJ, today when empty.
    // A line identical to one already in the book that day (same direction,
    // amount and party or sale) is refused unless confirmed: Hiba often tells
    // the same news twice.
    async record({ kind, amount, label = "", category = "", method = "", party = "", quoteNumber = "", orderNumber = "", day = "", announcedBy = "direction", by = "direction", confirmDuplicate = false, confidential = false }) {
      if (!Object.hasOwn(CASH_CATEGORIES, kind)) {
        throw new CashBookError("Dire s'il s'agit d'une entrée ou d'une sortie d'argent.", "CASH_KIND_UNKNOWN");
      }
      const value = roundMoney(Number(amount));
      if (!Number.isFinite(value) || value <= 0) {
        throw new CashBookError("Le montant doit être un nombre de dirhams supérieur à zéro.", "CASH_AMOUNT_INVALID");
      }
      const opening = category === OPENING_CATEGORY;
      if (opening && kind !== "entree") {
        throw new CashBookError("Le solde de départ s'enregistre comme une entrée.", "CASH_CATEGORY_UNKNOWN");
      }
      const chosen = opening || Object.hasOwn(CASH_CATEGORIES[kind], category) ? category : `autre_${kind}`;
      const date = day ? isoDay(day) : today();
      if (!date) {
        throw new CashBookError("Date illisible : écrire JJ/MM/AAAA.", "CASH_DATE_INVALID");
      }
      if (date > today()) {
        throw new CashBookError("Un mouvement ne s'enregistre pas à une date future : il sera noté le jour où il a lieu.", "CASH_DATE_FUTURE");
      }
      const entry = {
        id: randomUUID(),
        day: date,
        kind,
        amount: value,
        category: chosen,
        label: text(label) || categoryLabel(kind, chosen),
        method: Object.hasOwn(CASH_METHODS, method) ? method : "autre",
        party: text(party),
        quoteNumber: text(quoteNumber),
        orderNumber: text(orderNumber),
        announcedBy: text(announcedBy) || "direction",
        recordedBy: text(by) || "direction",
        at: clock().toISOString(),
        // Set when recorded, so a later change of threshold does not move
        // the expenses already in the book.
        needsApproval: kind === "sortie" && value >= threshold,
        confidential: kind === "sortie" && (confidential === true || CONFIDENTIAL_CATEGORIES.includes(chosen)),
        receipts: []
      };
      return book.change((state) => {
        const twin = state.entries.find((other) => !other.cancelled && other.day === entry.day && other.kind === entry.kind && other.amount === entry.amount
          && ((entry.party && other.party.toLowerCase() === entry.party.toLowerCase()) || (entry.quoteNumber && other.quoteNumber === entry.quoteNumber) || (entry.orderNumber && other.orderNumber === entry.orderNumber) || (!entry.party && !entry.quoteNumber && !entry.orderNumber && other.label === entry.label)));
        if (twin && !confirmDuplicate) {
          throw new CashBookError(`Un mouvement identique est déjà au journal ce jour-là (n° ${twin.number} : ${twin.label}, ${twin.amount} DH). S'il s'agit bien d'un second mouvement, le confirmer.`, "CASH_DUPLICATE");
        }
        entry.number = state.entries.reduce((max, other) => Math.max(max, other.number ?? 0), 0) + 1;
        state.entries.push(entry);
        return Object.freeze({ ...entry });
      });
    },

    // A line recorded by mistake is cancelled, never erased: it stays in the
    // book with who cancelled it, when and why, and no longer counts.
    async cancel(reference, { reason = "", by = "direction" } = {}) {
      if (!text(reason)) {
        throw new CashBookError("Dire pourquoi le mouvement est annulé.", "CASH_CANCEL_REASON_MISSING");
      }
      return book.change((state) => {
        const entry = state.entries.find((other) => other.id === reference || String(other.number) === String(reference));
        if (!entry) {
          throw new CashBookError(`Aucun mouvement n° ${reference} au journal de caisse.`, "CASH_ENTRY_NOT_FOUND");
        }
        if (entry.cancelled) {
          throw new CashBookError(`Le mouvement n° ${entry.number} est déjà annulé.`, "CASH_ENTRY_CANCELLED");
        }
        if (entry.reconciliation) {
          throw new CashBookError(`La dépense n° ${entry.number} est déjà rapprochée avec la banque ou la caisse : elle ne s'annule plus.`, "CASH_ALREADY_RECONCILED");
        }
        entry.cancelled = { at: clock().toISOString(), by: text(by) || "direction", reason: text(reason) };
        return Object.freeze({ ...entry });
      });
    },

    // A proof of payment for a movement: a photo (JPEG, PNG) or a PDF.
    async attachReceipt(reference, { bytes, mimeType, name = "", by = "direction" }) {
      const extension = RECEIPT_TYPES[mimeType];
      if (!extension) {
        throw new CashBookError("Le justificatif doit être une photo (JPEG ou PNG) ou un PDF.", "CASH_RECEIPT_INVALID");
      }
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new CashBookError("Le justificatif est vide.", "CASH_RECEIPT_INVALID");
      }
      if (bytes.length > MAX_RECEIPT_BYTES) {
        throw new CashBookError(`Le justificatif dépasse ${MAX_RECEIPT_BYTES / 1024 / 1024} Mo.`, "CASH_RECEIPT_INVALID");
      }
      // Checked before the file is written, so no file is left for a line
      // that does not exist.
      find(await book.load(), reference);
      const id = `${randomUUID()}.${extension}`;
      await receipts.put(id, bytes);
      return book.change((state) => {
        const entry = find(state, reference);
        entry.receipts = [...(entry.receipts ?? []), { id, name: text(name) || `justificatif.${extension}`, mimeType, size: bytes.length, at: clock().toISOString(), by: text(by) || "direction" }];
        return describeEntry(entry);
      });
    },

    async receipt(reference, id) {
      const entry = (await book.load()).entries.find((other) => String(other.number) === String(reference) || other.id === reference);
      const meta = entry?.receipts?.find((receipt) => receipt.id === id);
      const bytes = meta ? await receipts.get(meta.id) : null;
      if (!bytes) {
        throw new CashBookError("Justificatif introuvable.", "CASH_RECEIPT_NOT_FOUND");
      }
      return Object.freeze({ ...meta, bytes });
    },

    // A person of the direction approves an expense, once it is justified.
    async approve(reference, { by }) {
      return book.change((state) => {
        const entry = expense(state, reference);
        if ((entry.receipts ?? []).length === 0) {
          throw new CashBookError(`Joindre d'abord le justificatif de la dépense n° ${entry.number}.`, "CASH_RECEIPT_MISSING");
        }
        if (entry.approval) {
          throw new CashBookError(`La dépense n° ${entry.number} est déjà approuvée.`, "CASH_ALREADY_APPROVED");
        }
        entry.approval = { at: clock().toISOString(), by: text(by) || "direction" };
        return describeEntry(entry);
      });
    },

    // The expense is found on the bank statement or in the cash count.
    async reconcile(reference, { by, note = "" }) {
      return book.change((state) => {
        const entry = expense(state, reference);
        if ((entry.receipts ?? []).length === 0) {
          throw new CashBookError(`Joindre d'abord le justificatif de la dépense n° ${entry.number}.`, "CASH_RECEIPT_MISSING");
        }
        if (entry.needsApproval && !entry.approval) {
          throw new CashBookError(`La dépense n° ${entry.number} dépasse le seuil d'alerte : elle doit être approuvée avant d'être rapprochée.`, "CASH_APPROVAL_MISSING");
        }
        if (entry.reconciliation) {
          throw new CashBookError(`La dépense n° ${entry.number} est déjà rapprochée.`, "CASH_ALREADY_RECONCILED");
        }
        entry.reconciliation = { at: clock().toISOString(), by: text(by) || "direction", note: text(note) };
        return describeEntry(entry);
      });
    },

    // The expenses still to put in order: without a proof, waiting for
    // approval, or not yet reconciled.
    async pending({ confidential = true } = {}) {
      const open = (await book.load()).entries.filter((entry) => entry.kind === "sortie" && !entry.cancelled).map((entry) => shown(describeEntry(entry), confidential));
      return Object.freeze({
        threshold,
        missingReceipt: Object.freeze(open.filter((entry) => entry.status === "declaree")),
        awaitingApproval: Object.freeze(open.filter((entry) => entry.status === "justifiee" && entry.needsApproval)),
        toReconcile: Object.freeze(open.filter((entry) => entry.status === "approuvee" || (entry.status === "justifiee" && !entry.needsApproval)))
      });
    },

    async entries() {
      return (await book.load()).entries;
    },

    // The balance of one day, as the cockpit shows it every morning.
    // confidential: false for a person without the right to see them.
    async day(value = "", { confidential = true } = {}) {
      const date = value ? isoDay(value) : today();
      if (!date) {
        throw new CashBookError("Date illisible : écrire JJ/MM/AAAA.", "CASH_DATE_INVALID");
      }
      return dayBalance((await book.load()).entries, date, { confidential });
    },

    // A month in short: what came in and went out by kind, and the day by day.
    async month(value = "", { confidential = true } = {}) {
      const month = /^\d{4}-\d{2}$/.test(text(value)) ? text(value) : today().slice(0, 7);
      return monthBalance((await book.load()).entries, month, { confidential });
    },

    // What has been received for one sale, from the lines that name it.
    async collectedFor({ quoteNumber = "", orderNumber = "" }) {
      const lines = (await book.load()).entries.filter((entry) => !entry.cancelled && entry.kind === "entree"
        && ((quoteNumber && entry.quoteNumber === String(quoteNumber)) || (orderNumber && entry.orderNumber === String(orderNumber))));
      return Object.freeze({ total: roundMoney(lines.reduce((sum, entry) => sum + entry.amount, 0)), lines: Object.freeze(lines) });
    }
  });
}

export function dayBalance(entries, date, { confidential = true } = {}) {
  const live = entries.filter((entry) => !entry.cancelled);
  const before = live.filter((entry) => entry.day < date);
  const ofDay = entries.filter((entry) => entry.day === date).sort((a, b) => a.at.localeCompare(b.at));
  const counted = ofDay.filter((entry) => !entry.cancelled);
  const takings = counted.filter((entry) => entry.kind === "entree" && entry.category !== OPENING_CATEGORY);
  const spending = counted.filter((entry) => entry.kind === "sortie");
  const opening = balanceOf(before);
  const closing = balanceOf([...before, ...counted]);
  return Object.freeze({
    day: date,
    opening: opening.total,
    carriedIn: sum(counted.filter((entry) => entry.category === OPENING_CATEGORY)),
    totalIn: sum(takings),
    totalOut: sum(spending),
    net: roundMoney(sum(takings) - sum(spending)),
    closing: closing.total,
    // Cash in hand and money at the bank, told apart: the box is counted, the
    // bank is checked on the statement.
    closingCash: closing.cash,
    closingBank: closing.bank,
    byCategory: Object.freeze(byCategory(grouped(counted.filter((entry) => entry.category !== OPENING_CATEGORY), confidential))),
    entries: Object.freeze(ofDay.map((entry) => shown(describeEntry(entry), confidential))),
    currency: "MAD"
  });
}

export function monthBalance(entries, month, { confidential = true } = {}) {
  const live = entries.filter((entry) => !entry.cancelled);
  const ofMonth = live.filter((entry) => entry.day.startsWith(month));
  const takings = ofMonth.filter((entry) => entry.kind === "entree" && entry.category !== OPENING_CATEGORY);
  const spending = ofMonth.filter((entry) => entry.kind === "sortie");
  const days = [...new Set(ofMonth.map((entry) => entry.day))].sort();
  return Object.freeze({
    month,
    opening: balanceOf(live.filter((entry) => entry.day < `${month}-01`)).total,
    totalIn: sum(takings),
    totalOut: sum(spending),
    net: roundMoney(sum(takings) - sum(spending)),
    closing: balanceOf(live.filter((entry) => entry.day.slice(0, 7) <= month)).total,
    byCategory: Object.freeze(byCategory(grouped(ofMonth.filter((entry) => entry.category !== OPENING_CATEGORY), confidential))),
    days: Object.freeze(days.map((day) => {
      const balance = dayBalance(entries, day);
      return Object.freeze({ day, totalIn: balance.totalIn, totalOut: balance.totalOut, closing: balance.closing });
    })),
    currency: "MAD"
  });
}

export function describeEntry(entry) {
  return Object.freeze({
    id: entry.id,
    number: entry.number,
    day: entry.day,
    kind: entry.kind,
    amount: entry.amount,
    category: entry.category,
    categoryLabel: categoryLabel(entry.kind, entry.category),
    label: entry.label,
    method: entry.method,
    methodLabel: CASH_METHODS[entry.method] ?? entry.method,
    party: entry.party,
    quoteNumber: entry.quoteNumber,
    orderNumber: entry.orderNumber,
    announcedBy: entry.announcedBy,
    recordedBy: entry.recordedBy,
    at: entry.at,
    cancelled: entry.cancelled ? Object.freeze({ ...entry.cancelled }) : null,
    receipts: Object.freeze((entry.receipts ?? []).map(({ id, name, mimeType, size, at, by }) => Object.freeze({ id, name, mimeType, size, at, by }))),
    // Only an expense has a state; null for money received.
    status: entry.kind === "sortie" ? expenseStatus(entry) : null,
    statusLabel: entry.kind === "sortie" ? EXPENSE_STATUSES[expenseStatus(entry)] : null,
    needsApproval: entry.needsApproval === true,
    confidential: entry.confidential === true,
    approval: entry.approval ? Object.freeze({ ...entry.approval }) : null,
    reconciliation: entry.reconciliation ? Object.freeze({ ...entry.reconciliation }) : null
  });
}

// A confidential line as a person without the right sees it: that money went
// out, its number, day and state, nothing of what it is or for whom.
export function maskEntry(entry) {
  if (!entry.confidential) {
    return entry;
  }
  return Object.freeze({
    ...entry,
    amount: null,
    category: CONFIDENTIAL_CATEGORY,
    categoryLabel: categoryLabel(entry.kind, CONFIDENTIAL_CATEGORY),
    label: "Dépense confidentielle",
    party: "",
    quoteNumber: "",
    orderNumber: "",
    cancelled: entry.cancelled ? Object.freeze({ at: entry.cancelled.at, by: entry.cancelled.by, reason: "réservé à la direction" }) : null,
    receipts: Object.freeze([]),
    masked: true
  });
}

function shown(entry, confidential) {
  return confidential ? entry : maskEntry(entry);
}

// The confidential lines in one total, so no category tells a salary apart.
function grouped(entries, confidential) {
  return confidential ? entries : entries.map((entry) => (entry.confidential ? { ...entry, category: CONFIDENTIAL_CATEGORY } : entry));
}

function expenseStatus(entry) {
  if (entry.reconciliation) {
    return "rapprochee";
  }
  if (entry.approval) {
    return "approuvee";
  }
  return (entry.receipts ?? []).length > 0 ? "justifiee" : "declaree";
}

export function categoryLabel(kind, category) {
  if (category === CONFIDENTIAL_CATEGORY) {
    return "Dépenses confidentielles";
  }
  return category === OPENING_CATEGORY ? "Solde de départ" : CASH_CATEGORIES[kind]?.[category] ?? category;
}

function balanceOf(entries) {
  let total = 0;
  let cash = 0;
  for (const entry of entries) {
    const signed = entry.kind === "entree" ? entry.amount : -entry.amount;
    total += signed;
    if (entry.method === "especes") {
      cash += signed;
    }
  }
  return { total: roundMoney(total), cash: roundMoney(cash), bank: roundMoney(total - cash) };
}

function byCategory(entries) {
  const totals = new Map();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.category}`;
    const current = totals.get(key) ?? { kind: entry.kind, category: entry.category, label: categoryLabel(entry.kind, entry.category), amount: 0, count: 0 };
    current.amount = roundMoney(current.amount + entry.amount);
    current.count += 1;
    totals.set(key, current);
  }
  return [...totals.values()].sort((a, b) => (a.kind === b.kind ? b.amount - a.amount : a.kind === "entree" ? -1 : 1)).map((entry) => Object.freeze(entry));
}

function sum(entries) {
  return roundMoney(entries.reduce((total, entry) => total + entry.amount, 0));
}

// The day in Morocco, where the company is: the server may run on UTC.
export function localDay(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Casablanca", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function isoDay(value) {
  const french = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value).trim());
  const iso = french ? `${french[3]}-${french[2]}-${french[1]}` : String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return null;
  }
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

function text(value) {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}
