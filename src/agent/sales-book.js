import { join } from "node:path";
import { roundMoney } from "../documents/document-calculations.js";
import { HKIDS_DOCUMENT_TYPES } from "../documents/document-schema.js";
import { latestIssued } from "../documents/document-ledger.js";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";

// The quotes of the cockpit and their follow-up (CDC V1.1, section 13: the
// Commercial director produces a verifiable report in figures and tells of a
// late follow-up or a late delivery).
//
// What is sold is read from the documents actually issued: a quote is ordered
// once a purchase order names it, never on a model's word. What is kept here
// is only what the documents cannot say: each follow-up made (when, how, by
// whom), the quotes the client turned down, and which reminders were already
// sent, so the same one is never sent twice.
//
// A quote with no news for 5 days (HKIDS_FOLLOW_UP_DAYS) is to follow up: the
// person behind the Commercial agent is told. Twice that long, the direction
// is told too.

export const DEFAULT_FOLLOW_UP_DAYS = 5;
export const DEFAULT_FOLLOW_UP_PATH = join(DATA_DIR, "relances.json");
export const FOLLOW_UP_CHANNELS = Object.freeze({ whatsapp: "WhatsApp", telephone: "téléphone", email: "e-mail", visite: "visite", autre: "autre" });
export const QUOTE_STATES = Object.freeze({ ouvert: "ouvert", commande: "commandé", perdu: "perdu" });

export class SalesBookError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SalesBookError";
    this.code = code;
  }
}

const EMPTY = Object.freeze({ quotes: {}, notified: {} });

export function createMemoryFollowUpBook({ clock = () => new Date(), days = DEFAULT_FOLLOW_UP_DAYS } = {}) {
  return createFollowUpBook({ book: createMemoryJsonBook(EMPTY), clock, days });
}

export function createFileFollowUpBook({ path = DEFAULT_FOLLOW_UP_PATH, clock = () => new Date(), days = DEFAULT_FOLLOW_UP_DAYS } = {}) {
  return createFollowUpBook({ book: createFileJsonBook(path, EMPTY), clock, days });
}

function createFollowUpBook({ book, clock, days }) {
  const record = (state, number) => (state.quotes[String(number)] ??= { followUps: [], lost: null });

  return Object.freeze({
    days,

    // A follow-up made: by WhatsApp, telephone… on a day (today when none is
    // given). A quote turned down is lost; a new follow-up opens it again.
    async record(number, { channel = "autre", note = "", day = "", lost = false, reason = "", by = "direction" } = {}) {
      if (!FOLLOW_UP_CHANNELS[channel]) {
        throw new SalesBookError(`Canal inconnu : ${channel}. Canaux : ${Object.keys(FOLLOW_UP_CHANNELS).join(", ")}.`, "FOLLOW_UP_CHANNEL_UNKNOWN");
      }
      const when = day ? isoDay(day) : clock().toISOString().slice(0, 10);
      if (!when) {
        throw new SalesBookError("Date illisible : écrire JJ/MM/AAAA.", "FOLLOW_UP_DATE_INVALID");
      }
      if (lost && !text(reason)) {
        throw new SalesBookError("Un devis perdu dit pourquoi (prix, délai, concurrent, projet abandonné…).", "FOLLOW_UP_REASON_MISSING");
      }
      return book.change((state) => {
        const entry = record(state, number);
        const at = clock().toISOString();
        entry.followUps.push({ at, day: when, channel, note: text(note), by });
        entry.lost = lost ? { at, day: when, reason: text(reason), by } : null;
        return structuredClone(entry);
      });
    },

    async state() {
      return book.load();
    },

    // The reminders not yet sent, among those due; they are marked sent at
    // once, so two sweeps never send the same one.
    async claimReminders(reminders) {
      return book.change((state) => {
        const fresh = reminders.filter((reminder) => state.notified[reminder.key] === undefined);
        for (const reminder of fresh) {
          state.notified[reminder.key] = clock().toISOString();
        }
        return fresh;
      });
    }
  });
}

// Every quote issued by the cockpit and where it stands today.
export function quotePipeline(issued, state = EMPTY, { today = new Date(), days = DEFAULT_FOLLOW_UP_DAYS } = {}) {
  const day = isoDay(today);
  const orders = latestIssued(issued, HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER);
  return latestIssued(issued, HKIDS_DOCUMENT_TYPES.QUOTE).map((quote) => {
    const record = state.quotes?.[quote.number] ?? { followUps: [], lost: null };
    const order = orders.find((candidate) => candidate.quoteReference === quote.number) ?? null;
    const issuedOn = isoDay(quote.date);
    const followUps = [...record.followUps].sort((a, b) => a.day.localeCompare(b.day));
    const lastContact = [issuedOn, ...followUps.map((entry) => entry.day)].filter(Boolean).sort().at(-1) ?? null;
    const status = order ? "commande" : record.lost ? "perdu" : "ouvert";
    const silent = status === "ouvert" && lastContact ? daysBetween(lastContact, day) : null;
    return Object.freeze({
      number: quote.number,
      date: issuedOn,
      client: quote.client,
      object: quote.object ?? "",
      totalTtc: quote.totalTtc,
      status,
      order: order ? Object.freeze({ number: order.number, date: isoDay(order.date), totalTtc: order.totalTtc }) : null,
      followUps: Object.freeze(followUps.map((entry) => Object.freeze({ ...entry }))),
      lost: record.lost ? Object.freeze({ ...record.lost }) : null,
      lastContact,
      daysSilent: silent,
      // 1: to follow up now; 2: no news for twice as long, the direction is told.
      level: silent === null ? 0 : silent >= 2 * days ? 2 : silent >= days ? 1 : 0
    });
  }).sort((a, b) => Number(b.number) - Number(a.number));
}

// The report of a period, every figure with the documents it is made of, so
// anyone can check it against the cockpit.
export function salesReport(issued, state, { from, to, today = new Date(), days = DEFAULT_FOLLOW_UP_DAYS, workshopOrders = [] }) {
  const pipeline = quotePipeline(issued, state, { today, days });
  const inPeriod = (date) => Boolean(date) && date >= from && date <= to;
  const amount = (entries, pick = (entry) => entry.totalTtc) => roundMoney(entries.reduce((sum, entry) => sum + (pick(entry) ?? 0), 0));
  const issuedInPeriod = pipeline.filter((quote) => inPeriod(quote.date));
  const signed = pipeline.filter((quote) => quote.order && inPeriod(quote.order.date));
  const lost = pipeline.filter((quote) => quote.lost && inPeriod(quote.lost.day));
  const open = pipeline.filter((quote) => quote.status === "ouvert");
  const due = open.filter((quote) => quote.level > 0).sort((a, b) => b.daysSilent - a.daysSilent);
  const convertedFromPeriod = issuedInPeriod.filter((quote) => quote.order).length;
  const unknown = [...issuedInPeriod, ...signed].filter((quote) => quote.totalTtc === null).map((quote) => quote.number);
  const lateDeliveries = workshopOrders.filter((order) => order.steps?.some((step) => step.id === "livraison_installation" && step.late));

  return Object.freeze({
    from,
    to,
    followUpDays: days,
    issued: Object.freeze({ count: issuedInPeriod.length, totalTtc: amount(issuedInPeriod), numbers: issuedInPeriod.map((quote) => quote.number) }),
    signed: Object.freeze({
      count: signed.length,
      totalTtc: amount(signed, (quote) => quote.order.totalTtc ?? quote.totalTtc),
      pairs: signed.map((quote) => `devis ${quote.number} → BC ${quote.order.number}`)
    }),
    conversion: issuedInPeriod.length > 0 ? Math.round((convertedFromPeriod / issuedInPeriod.length) * 100) : null,
    lost: Object.freeze({ count: lost.length, totalTtc: amount(lost), quotes: lost.map((quote) => ({ number: quote.number, reason: quote.lost.reason })) }),
    open: Object.freeze({ count: open.length, totalTtc: amount(open), numbers: open.map((quote) => quote.number) }),
    toFollowUp: Object.freeze(due),
    lateDeliveries: Object.freeze(lateDeliveries.map((order) => {
      const step = order.steps.find((candidate) => candidate.id === "livraison_installation");
      return Object.freeze({ number: order.number, client: order.client, plannedDate: step.plannedDate });
    })),
    unknownAmounts: Object.freeze([...new Set(unknown)])
  });
}

// What is due to be told, one key per quote, level and last contact: a new
// follow-up gives a new last contact, and so a new reminder if it is late again.
export function dueReminders(pipeline) {
  return pipeline
    .filter((quote) => quote.level > 0)
    .map((quote) => Object.freeze({ key: `devis:${quote.number}:${quote.level}:${quote.lastContact}`, quote }));
}

export function isoDay(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const french = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? "").trim());
  const iso = french ? `${french[3]}-${french[2]}-${french[1]}` : String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return null;
  }
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

export function frenchDay(iso) {
  const [year, month, day] = String(iso ?? "").split("-");
  return day ? `${day}/${month}/${year}` : "";
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
