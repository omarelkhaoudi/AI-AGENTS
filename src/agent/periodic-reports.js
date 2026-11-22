import { join } from "node:path";
import { HKIDS_DOCUMENT_TYPES } from "../documents/document-schema.js";
import { latestIssued } from "../documents/document-ledger.js";
import { OPENING_CATEGORY, localDay } from "./cash-book.js";
import { isHoliday } from "./hr-book.js";
import { taskBoard } from "./improvement-book.js";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";
import { salesReport } from "./sales-book.js";

// The direction's scheduled reports (CDC V2 sections 5 and 6): each working
// morning the report of the day before, each Monday the week before, on the
// first working day of a month the month before. They are composed from the
// books only (documents issued, follow-ups, cash book, workshop book,
// Amélioration, stock): every figure can be checked in the cockpit, and a
// figure the books do not have is said to be missing, never guessed.
//
// Each report is kept, so the cockpit shows it, and sent to the direction on
// WhatsApp when the number is connected. The direction turns each kind on or
// off. CA commandé, facturé and encaissé are three separate figures.

export const DEFAULT_REPORTS_PATH = join(DATA_DIR, "rapports.json");
export const REPORT_KINDS = Object.freeze({ jour: "Rapport du jour", semaine: "Rapport de la semaine", mois: "Rapport du mois" });
const KEPT = 120;
const PAID_CATEGORIES = Object.freeze(["acompte_client", "solde_client", "vente_comptant"]);

export class ReportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ReportError";
    this.code = code;
  }
}

const EMPTY = { settings: { jour: true, semaine: true, mois: true }, reports: [], updatedAt: null, updatedBy: null };

export function createMemoryReportBook({ clock = () => new Date() } = {}) {
  return reportBook(createMemoryJsonBook(EMPTY), clock);
}

export function createFileReportBook({ path = DEFAULT_REPORTS_PATH, clock = () => new Date() } = {}) {
  return reportBook(createFileJsonBook(path, EMPTY), clock);
}

function reportBook(book, clock) {
  return Object.freeze({
    async state() {
      const state = await book.load();
      return { ...state, settings: { ...EMPTY.settings, ...state.settings } };
    },

    // { jour, semaine, mois }: true or false; a kind left out stays as it was.
    async setSettings(settings = {}, { by = "direction" } = {}) {
      const changes = {};
      for (const [kind, value] of Object.entries(settings ?? {})) {
        if (!REPORT_KINDS[kind]) {
          throw new ReportError(`Rapport inconnu : « ${kind} ».`, "REPORT_KIND_UNKNOWN");
        }
        if (typeof value !== "boolean") {
          throw new ReportError(`${REPORT_KINDS[kind]} : oui ou non attendu.`, "REPORT_SETTING_INVALID");
        }
        changes[kind] = value;
      }
      return book.change((state) => {
        state.settings = { ...EMPTY.settings, ...state.settings, ...changes };
        state.updatedAt = clock().toISOString();
        state.updatedBy = String(by || "direction");
        return structuredClone(state);
      });
    },

    // Keeps a report once per kind and period: null when it was already kept,
    // so it is never sent twice.
    async keep(report, { sentBy = "cockpit" } = {}) {
      return book.change((state) => {
        state.reports ??= [];
        if (state.reports.some((entry) => entry.key === report.key)) {
          return null;
        }
        const kept = { ...report, at: clock().toISOString(), sentBy };
        state.reports.unshift(kept);
        state.reports = state.reports.slice(0, KEPT);
        return structuredClone(kept);
      });
    },

    async markSent(key, channel) {
      return book.change((state) => {
        const entry = (state.reports ?? []).find((candidate) => candidate.key === key);
        if (entry) entry.sentBy = channel;
        return entry ? structuredClone(entry) : null;
      });
    }
  });
}

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const isWorking = (iso, holidays) => new Date(`${iso}T00:00:00Z`).getUTCDay() !== 0 && !isHoliday(iso, holidays);
const todayOf = (today) => (today instanceof Date ? localDay(today) : String(today).slice(0, 10));

// The period a report covers, sent on day today (Casablanca): the day: from
// the previous working day to yesterday (a Monday covers Saturday and
// Sunday); the week: Monday to Sunday before; the month: the month before.
export function reportPeriod(kind, today, holidays = []) {
  const day = todayOf(today);
  if (kind === "jour") {
    let from = addDays(day, -1);
    while (!isWorking(from, holidays) && from > addDays(day, -10)) from = addDays(from, -1);
    return { from, to: addDays(day, -1) };
  }
  if (kind === "semaine") {
    const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
    const monday = addDays(day, -weekday);
    return { from: addDays(monday, -7), to: addDays(monday, -1) };
  }
  if (kind === "mois") {
    const first = `${day.slice(0, 7)}-01`;
    const to = addDays(first, -1);
    return { from: `${to.slice(0, 7)}-01`, to };
  }
  throw new ReportError(`Rapport inconnu : « ${kind} ».`, "REPORT_KIND_UNKNOWN");
}

// Whether the report of this kind goes out today: every working day for the
// day, the first working day of the week or of the month for the others.
export function reportDue(kind, today, holidays = []) {
  const day = todayOf(today);
  if (!isWorking(day, holidays)) {
    return false;
  }
  const firstWorking = (start) => {
    let candidate = start;
    while (!isWorking(candidate, holidays)) candidate = addDays(candidate, 1);
    return candidate === day;
  };
  if (kind === "jour") return true;
  if (kind === "semaine") return firstWorking(addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7)));
  if (kind === "mois") return firstWorking(`${day.slice(0, 7)}-01`);
  return false;
}

export const french = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
const dh = (value) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value).replace(/\s/g, " ")} DH`;
const round = (value) => Math.round(value * 100) / 100;
const total = (entries) => round(entries.reduce((sum, entry) => sum + (Number(entry.totalTtc) || 0), 0));

// The report of a period, from the books. data: { issued, followUps, followUpDays,
// entries (cash book), orders (workshop book), schedule (workshop-capacity),
// anomalies, stockAlerts, pending (expenses to settle) }. Salaries are only
// counted in the totals of the cash book, never named.
export function composeReport(kind, { from, to }, data, { today = new Date() } = {}) {
  const { issued = [], followUps = { quotes: {} }, followUpDays = 5, entries = [], orders = [], schedule = null, anomalies = [], stockAlerts = [], pending = null } = data;
  const inPeriod = (iso) => Boolean(iso) && iso >= from && iso <= to;
  const sales = salesReport(issued, followUps, { from, to, today, days: followUpDays, workshopOrders: orders });
  const dayOf = (value) => {
    const french = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? ""));
    return french ? `${french[3]}-${french[2]}-${french[1]}` : String(value ?? "").slice(0, 10);
  };
  const invoices = latestIssued(issued, HKIDS_DOCUMENT_TYPES.INVOICE).filter((entry) => inPeriod(dayOf(entry.date)));
  const credits = latestIssued(issued, HKIDS_DOCUMENT_TYPES.CREDIT_NOTE).filter((entry) => inPeriod(dayOf(entry.date)));
  const live = entries.filter((entry) => !entry.cancelled && inPeriod(entry.day));
  const paid = live.filter((entry) => entry.kind === "entree" && PAID_CATEGORIES.includes(entry.category));
  const takings = live.filter((entry) => entry.kind === "entree" && entry.category !== OPENING_CATEGORY);
  const spending = live.filter((entry) => entry.kind === "sortie");
  const amount = (list) => round(list.reduce((sum, entry) => sum + entry.amount, 0));
  const balance = round(entries.filter((entry) => !entry.cancelled && entry.day <= to).reduce((sum, entry) => sum + (entry.kind === "entree" ? entry.amount : -entry.amount), 0));

  const open = orders.filter((order) => !order.finished);
  const step = (order, id) => order.steps?.find((candidate) => candidate.id === id);
  const delivered = orders.filter((order) => inPeriod(step(order, "livraison_installation")?.doneDate ?? ""));
  const late = open.filter((order) => order.steps?.some((candidate) => candidate.late));
  const blocked = open.filter((order) => order.steps?.some((candidate) => candidate.status === "bloquee"));
  const untenable = (schedule?.orders ?? []).filter((entry) => entry.verdict === "intenable" && !entry.extra);
  const name = (order) => `BC n° ${order.number}${order.client ? ` (${order.client})` : ""}`;
  const list = (items, max = 5) => (items.length > max ? `${items.slice(0, max).join(", ")} et ${items.length - max} autre(s)` : items.join(", "));

  const board = taskBoard(anomalies, today);
  const budgetAlerts = board.open.filter((anomaly) => anomaly.source === "budget");

  const sections = [
    {
      title: "Ventes",
      lines: [
        `Devis émis : ${sales.issued.count}${sales.issued.count > 0 ? ` (${dh(sales.issued.totalTtc)} TTC)` : ""}`,
        `CA commandé : ${dh(sales.signed.totalTtc)} TTC, ${sales.signed.count} bon(s) de commande signé(s)`,
        `CA facturé : ${dh(round(total(invoices) - total(credits)))} TTC, ${invoices.length} facture(s)${credits.length > 0 ? ` moins ${credits.length} avoir(s) de ${dh(total(credits))}` : ""}`,
        `CA encaissé : ${dh(amount(paid))}, acomptes, soldes et ventes au comptant du journal de caisse`,
        sales.conversion === null ? "Taux de transformation : pas de devis émis sur la période" : `Taux de transformation des devis de la période : ${sales.conversion} %`,
        sales.lost.count > 0 ? `Devis perdus : ${sales.lost.count} (${dh(sales.lost.totalTtc)})` : "",
        sales.toFollowUp.length > 0 ? `Devis à relancer : ${list(sales.toFollowUp.map((quote) => `n° ${quote.number} (${quote.client}, ${quote.daysSilent} j sans nouvelles)`))}` : "",
        sales.unknownAmounts.length > 0 ? `Montant illisible sur le devis n° ${sales.unknownAmounts.join(", ")} : non compté` : ""
      ]
    },
    {
      title: "Caisse",
      lines: [
        `Entrées : ${dh(amount(takings))} ; sorties : ${dh(amount(spending))} ; net : ${dh(round(amount(takings) - amount(spending)))}`,
        entries.length > 0 ? `Solde au ${french(to)} : ${dh(balance)}` : "Journal de caisse vide : aucun solde"
      ]
    },
    {
      title: "Atelier",
      lines: [
        `Commandes en cours : ${open.length}${delivered.length > 0 ? ` ; livrées et installées sur la période : ${list(delivered.map(name))}` : ""}`,
        late.length > 0 ? `En retard sur une date prévue : ${list(late.map(name))}` : "Aucune étape en retard sur sa date prévue",
        blocked.length > 0 ? `Bloquées : ${list(blocked.map(name))}` : "",
        untenable.length > 0 ? `Date promise intenable d'après la charge de l'atelier : ${list(untenable.map((entry) => `BC n° ${entry.number} (promis le ${french(entry.promised)}, fin estimée le ${french(entry.end)})`))}` : "",
        schedule && !schedule.configured && open.length > 0 ? "Durées d'étape non fixées : la charge de l'atelier n'est pas estimée" : ""
      ]
    },
    {
      title: "À traiter",
      lines: [
        board.open.length > 0 ? `Anomalies ouvertes : ${board.open.length}${[board.severe.length > 0 ? `${board.severe.length} de gravité haute` : "", board.unassigned.length > 0 ? `${board.unassigned.length} sans responsable` : ""].filter(Boolean).map((part, index) => `${index === 0 ? ", dont " : " et "}${part}`).join("")}` : "Aucune anomalie ouverte",
        board.late.length > 0 ? `Tâches en retard : ${list(board.late.map((anomaly) => `n° ${anomaly.number}${anomaly.task?.person || anomaly.task?.agent ? ` (${anomaly.task.person || anomaly.task.agent})` : ""}`))}` : "",
        board.toConfirm.length > 0 ? `${board.toConfirm.length} tâche(s) résolue(s) à confirmer par la direction` : "",
        stockAlerts.length > 0 ? `Stock sous le minimum : ${list(stockAlerts.map((item) => item.name))}` : "",
        budgetAlerts.length > 0 ? `Alertes budgétaires : ${budgetAlerts.length}` : "",
        pending && pending.missingReceipt.length > 0 ? `${pending.missingReceipt.length} dépense(s) sans justificatif` : "",
        pending && pending.awaitingApproval.length > 0 ? `${pending.awaitingApproval.length} dépense(s) à approuver par la direction` : ""
      ]
    }
  ].map((section) => ({ title: section.title, lines: section.lines.filter(Boolean) }));

  const period = from === to ? `du ${french(from)}` : `du ${french(from)} au ${french(to)}`;
  const title = `${REPORT_KINDS[kind]} — ${period}`;
  return Object.freeze({
    key: `${kind}:${from}:${to}`,
    kind,
    from,
    to,
    title,
    sections,
    text: [`*${title}*`, ...sections.map((section) => [`\n*${section.title}*`, ...section.lines.map((line) => `• ${line}`)].join("\n")), "\nChiffres tirés du cockpit (documents émis, journal de caisse, carnet d'atelier) ; le détail de chacun y est consultable."].join("\n")
  });
}
