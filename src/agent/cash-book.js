import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { roundMoney } from "../documents/document-calculations.js";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";

// The cash book of H KIDS (Hiba's request of 09/11/2026): the boss announces
// each money in or out to the Director, the Director has Finance record it,
// and the balance of the day is there every day.
//
// Each line is one movement: in or out, its amount in dirhams, what it is, how
// it was paid, who paid or was paid, and the sale it belongs to. A line is
// never erased: a mistake is cancelled with its reason and stays in the book.
// The balance of a day is computed from the lines, never typed: the opening
// balance is everything before that day, the closing balance adds the day.

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

export const CASH_METHODS = Object.freeze({ especes: "Espèces", virement: "Virement", cheque: "Chèque", carte: "Carte", autre: "Autre" });

export class CashBookError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CashBookError";
    this.code = code;
  }
}

export function createMemoryCashBook({ clock = () => new Date() } = {}) {
  return createCashBook({ book: createMemoryJsonBook({ entries: [] }), clock });
}

export function createFileCashBook({ path = DEFAULT_CASH_PATH, clock = () => new Date() } = {}) {
  return createCashBook({ book: createFileJsonBook(path, { entries: [] }), clock });
}

function createCashBook({ book, clock }) {
  const today = () => localDay(clock());

  return Object.freeze({
    today,

    // kind: entree | sortie. day: JJ/MM/AAAA or AAAA-MM-JJ, today when empty.
    // A line identical to one already in the book that day (same direction,
    // amount and party or sale) is refused unless confirmed: Hiba often tells
    // the same news twice.
    async record({ kind, amount, label = "", category = "", method = "", party = "", quoteNumber = "", orderNumber = "", day = "", announcedBy = "direction", by = "direction", confirmDuplicate = false }) {
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
        at: clock().toISOString()
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
        entry.cancelled = { at: clock().toISOString(), by: text(by) || "direction", reason: text(reason) };
        return Object.freeze({ ...entry });
      });
    },

    async entries() {
      return (await book.load()).entries;
    },

    // The balance of one day, as the cockpit shows it every morning.
    async day(value = "") {
      const date = value ? isoDay(value) : today();
      if (!date) {
        throw new CashBookError("Date illisible : écrire JJ/MM/AAAA.", "CASH_DATE_INVALID");
      }
      return dayBalance((await book.load()).entries, date);
    },

    // A month in short: what came in and went out by kind, and the day by day.
    async month(value = "") {
      const month = /^\d{4}-\d{2}$/.test(text(value)) ? text(value) : today().slice(0, 7);
      return monthBalance((await book.load()).entries, month);
    },

    // What has been received for one sale, from the lines that name it.
    async collectedFor({ quoteNumber = "", orderNumber = "" }) {
      const lines = (await book.load()).entries.filter((entry) => !entry.cancelled && entry.kind === "entree"
        && ((quoteNumber && entry.quoteNumber === String(quoteNumber)) || (orderNumber && entry.orderNumber === String(orderNumber))));
      return Object.freeze({ total: roundMoney(lines.reduce((sum, entry) => sum + entry.amount, 0)), lines: Object.freeze(lines) });
    }
  });
}

export function dayBalance(entries, date) {
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
    byCategory: Object.freeze(byCategory(counted.filter((entry) => entry.category !== OPENING_CATEGORY))),
    entries: Object.freeze(ofDay.map(describeEntry)),
    currency: "MAD"
  });
}

export function monthBalance(entries, month) {
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
    byCategory: Object.freeze(byCategory(ofMonth.filter((entry) => entry.category !== OPENING_CATEGORY))),
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
    cancelled: entry.cancelled ? Object.freeze({ ...entry.cancelled }) : null
  });
}

export function categoryLabel(kind, category) {
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
