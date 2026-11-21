import { join } from "node:path";
import { roundMoney } from "../documents/document-calculations.js";
import { CASH_CATEGORIES, CONFIDENTIAL_CATEGORIES } from "./cash-book.js";
import { cashForecast } from "./business-analysis.js";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";

// The direction's budgets (CDC V2 section 6): what it allows to spend each
// month by kind of expense, what it allows for one purchase order, and the
// least cash it wants to keep. The spending is read from the cash book, never
// typed twice. Each is the direction's own figure: none is invented, and an
// unset budget gives no alert.
//
// Overrun of a monthly budget or of an order's, and cash forecast under the
// minimum (or below zero when no minimum is set), are facts for Amélioration
// (source « budget »), told to Finance.

export const DEFAULT_BUDGET_PATH = join(DATA_DIR, "budgets.json");
export const BUDGET_CATEGORIES = CASH_CATEGORIES.sortie;
// Above it, no budget is credible: a typing error (a zero too many).
const MAX_BUDGET = 100_000_000;

export class BudgetBookError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "BudgetBookError";
    this.code = code;
  }
}

const EMPTY = { monthly: {}, orders: {}, cashFloor: null, updatedAt: null, updatedBy: null };

export function createMemoryBudgetBook({ clock = () => new Date() } = {}) {
  return budgetBook(createMemoryJsonBook(EMPTY), clock);
}

export function createFileBudgetBook({ path = DEFAULT_BUDGET_PATH, clock = () => new Date() } = {}) {
  return budgetBook(createFileJsonBook(path, EMPTY), clock);
}

const text = (value) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

// "" or null clears; otherwise a number of dirhams, 0 or more.
function amount(value, label) {
  if (value === null || text(value) === "" || /^(aucun|aucune|-)$/i.test(text(value))) {
    return null;
  }
  const raw = text(value).replace(/\s|dh|mad/gi, "").replace(",", ".");
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_BUDGET) {
    throw new BudgetBookError(`${label} : un montant en dirhams est attendu (« ${text(value)} »).`, "BUDGET_AMOUNT_INVALID");
  }
  return roundMoney(parsed);
}

export const orderKey = (value) => text(value).replace(/^(bc|bon de commande)?\s*(n°|no|n)?\s*/i, "");

function budgetBook(book, clock) {
  return Object.freeze({
    async state() {
      return book.load();
    },

    // Changes only what is given: monthly and orders are maps whose "" value
    // clears one budget; cashFloor "" clears the minimum. All or nothing.
    async set({ monthly, orders, cashFloor } = {}, { by = "direction" } = {}) {
      const changes = { monthly: {}, orders: {} };
      for (const [category, value] of Object.entries(monthly ?? {})) {
        if (!Object.hasOwn(BUDGET_CATEGORIES, category)) {
          throw new BudgetBookError(`Catégorie de dépense inconnue : « ${category} ». Catégories : ${Object.values(BUDGET_CATEGORIES).join(", ")}.`, "BUDGET_CATEGORY_UNKNOWN");
        }
        changes.monthly[category] = amount(value, `Budget ${BUDGET_CATEGORIES[category]}`);
      }
      for (const [number, value] of Object.entries(orders ?? {})) {
        const key = orderKey(number);
        if (!key) {
          throw new BudgetBookError("Donner le numéro du bon de commande.", "BUDGET_ORDER_MISSING");
        }
        changes.orders[key] = amount(value, `Budget du BC n° ${key}`);
      }
      const floor = cashFloor === undefined ? undefined : amount(cashFloor, "Trésorerie minimale");
      return book.change((state) => {
        for (const [category, value] of Object.entries(changes.monthly)) {
          if (value === null) delete state.monthly[category];
          else state.monthly[category] = value;
        }
        for (const [number, value] of Object.entries(changes.orders)) {
          if (value === null) delete state.orders[number];
          else state.orders[number] = value;
        }
        if (floor !== undefined) {
          state.cashFloor = floor;
        }
        state.updatedAt = clock().toISOString();
        state.updatedBy = text(by) || "direction";
        return structuredClone(state);
      });
    }
  });
}

const percent = (spent, budget) => (budget > 0 ? Math.round((spent / budget) * 1000) / 10 : spent > 0 ? null : 0);

// Where each budget stands today: the month's spending by kind against its
// budget, each order's spending against its own, and the cash forecast of the
// next days against the minimum. confidential: false masks the amounts of a
// confidential kind (salaries) for a person without the right to see them.
export function budgetStatus(budgets, entries, orders, { today, confidential = true, forecastDays = 15 }) {
  const day = today instanceof Date ? today.toISOString().slice(0, 10) : String(today).slice(0, 10);
  const month = day.slice(0, 7);
  const spending = entries.filter((entry) => !entry.cancelled && entry.kind === "sortie");
  const ofMonth = spending.filter((entry) => entry.day.startsWith(month));
  const categories = Object.entries(budgets.monthly ?? {}).map(([category, budget]) => {
    const spent = roundMoney(ofMonth.filter((entry) => entry.category === category).reduce((sum, entry) => sum + entry.amount, 0));
    const hidden = !confidential && CONFIDENTIAL_CATEGORIES.includes(category);
    return {
      category,
      label: BUDGET_CATEGORIES[category] ?? category,
      budget: hidden ? null : budget,
      spent: hidden ? null : spent,
      percent: percent(spent, budget),
      over: spent > budget + 0.004,
      masked: hidden
    };
  });
  const byNumber = new Map(orders.map((order) => [String(order.number), order]));
  const orderLines = Object.entries(budgets.orders ?? {}).map(([number, budget]) => {
    const spent = roundMoney(spending.filter((entry) => entry.orderNumber === number).reduce((sum, entry) => sum + entry.amount, 0));
    const order = byNumber.get(number);
    return { number, client: order?.client ?? "", finished: order?.finished === true, budget, spent, percent: percent(spent, budget), over: spent > budget + 0.004 };
  }).sort((a, b) => Number(b.number) - Number(a.number) || b.number.localeCompare(a.number));
  const forecast = cashForecast(orders, entries, { today: day, days: forecastDays });
  const floor = Number.isFinite(budgets.cashFloor) ? budgets.cashFloor : null;
  const below = forecast.hasBook && (floor !== null ? forecast.lowest.balance < floor : forecast.lowest.balance < 0);
  return {
    month,
    categories,
    orders: orderLines,
    cash: {
      floor,
      balance: forecast.balance,
      lowest: forecast.lowest,
      days: forecast.days,
      perDay: forecast.perDay,
      inflows: forecast.inflows,
      hasBook: forecast.hasBook,
      below
    },
    updatedAt: budgets.updatedAt ?? null,
    updatedBy: budgets.updatedBy ?? null
  };
}

const dh = (value) => `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value).replace(/ | /g, " ")} DH`;
const french = (iso) => iso.split("-").reverse().join("/");
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const monthName = (month) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

// The budgets overrun and the cash too low, as facts for Amélioration. The
// status must be read with the direction's rights: a salary budget's fact
// carries no amount, since everyone reads Amélioration.
export function budgetFacts(status) {
  const fact = (key, kind, orderNumber, reference, message) => ({ source: "budget", key, kind, severity: "haute", owner: "finance", client: "", orderNumber, step: null, reference, fact: message });
  return [
    ...status.categories.filter((line) => line.over).map((line) => fact(
      `budget:categorie:${line.category}:${status.month}`,
      "budget_depasse",
      "",
      line.label,
      CONFIDENTIAL_CATEGORIES.includes(line.category)
        ? `Budget « ${line.label} » de ${monthName(status.month)} dépassé (montants réservés à la direction, vue Caisse).`
        : `Budget « ${line.label} » de ${monthName(status.month)} dépassé : ${dh(line.spent)} dépensés pour un budget de ${dh(line.budget)}${line.percent !== null ? ` (${String(line.percent).replace(".", ",")} %)` : ""}.`
    )),
    ...status.orders.filter((line) => line.over).map((line) => fact(
      `budget:bc:${line.number}`,
      "budget_depasse",
      line.number,
      `BC n° ${line.number}`,
      `Budget du BC n° ${line.number}${line.client ? ` (${line.client})` : ""} dépassé : ${dh(line.spent)} de dépenses notées à la caisse pour un budget de ${dh(line.budget)}${line.percent !== null ? ` (${String(line.percent).replace(".", ",")} %)` : ""}.`
    )),
    ...(status.cash.below ? [fact(
      "budget:tresorerie",
      "tresorerie_insuffisante",
      "",
      "Trésorerie",
      `Trésorerie insuffisante : la prévision des ${status.cash.days} prochains jours descend à ${dh(status.cash.lowest.balance)} le ${french(status.cash.lowest.day)}, ${status.cash.floor !== null ? `sous le minimum de ${dh(status.cash.floor)} fixé par la direction` : "sous zéro"} (solde du jour ${dh(status.cash.balance)}, encaissements attendus ${dh(status.cash.inflows)}, dépenses au rythme de ${dh(status.cash.perDay)} par jour). Relancer les encaissements ou décaler une dépense.`
    )] : [])
  ];
}
