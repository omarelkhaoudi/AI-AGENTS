import { join } from "node:path";
import { isHoliday } from "./hr-book.js";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";
import { WORKSHOP_STEPS } from "./workshop-book.js";

// The workshop's capacity (CDC V2 sections 5 and 9): is a delivery date
// promised to a client compatible with what the workshop already has to do?
//
// The direction says, for each step of the route, how many working days it
// takes for one order and how many orders the team can carry in that step at
// the same time. From the workshop book (what is done, in progress, to do) the
// orders are scheduled one after the other, the earliest promised first, on
// working days (Monday to Saturday, public holidays left out). A promise later
// than its order's estimated end is held; one earlier is an alert.
//
// No duration is invented: a step without one leaves the estimate unknown,
// and says which step is missing. It is an estimate from the direction's own
// figures, never a commitment: the workshop confirms.

export const DEFAULT_CAPACITY_PATH = join(DATA_DIR, "capacite-atelier.json");
const DELIVERY_STEP = "livraison_installation";
const MAX_DAYS = 120;
const MAX_PARALLEL = 20;

export class CapacityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CapacityError";
    this.code = code;
  }
}

const EMPTY = { steps: {}, updatedAt: null, updatedBy: null };

export function createMemoryCapacityBook({ clock = () => new Date() } = {}) {
  return capacityBook(createMemoryJsonBook(EMPTY), clock);
}

export function createFileCapacityBook({ path = DEFAULT_CAPACITY_PATH, clock = () => new Date() } = {}) {
  return capacityBook(createFileJsonBook(path, EMPTY), clock);
}

const text = (value) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const STEP_LABELS = Object.fromEntries(WORKSHOP_STEPS.map((step) => [step.id, step.label]));

function whole(value, label, min, max) {
  if (value === null || value === undefined || text(value) === "") {
    return null;
  }
  const parsed = Number(text(value).replace(",", "."));
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new CapacityError(`${label} : un nombre entier de ${min} à ${max} est attendu (« ${text(value)} »).`, "CAPACITY_VALUE_INVALID");
  }
  return parsed;
}

function capacityBook(book, clock) {
  return Object.freeze({
    async state() {
      return book.load();
    },

    // { stepId: { days, parallel } }: a step left out stays as it was; days ""
    // removes the step's figures. parallel defaults to one order at a time,
    // and is shown so.
    async set(steps = {}, { by = "direction" } = {}) {
      const changes = {};
      for (const [stepId, value] of Object.entries(steps ?? {})) {
        if (!STEP_LABELS[stepId]) {
          throw new CapacityError(`Étape inconnue : « ${stepId} ».`, "CAPACITY_STEP_UNKNOWN");
        }
        const days = whole(value?.days, `Durée de « ${STEP_LABELS[stepId]} »`, 1, MAX_DAYS);
        const parallel = whole(value?.parallel, `Commandes en même temps en « ${STEP_LABELS[stepId]} »`, 1, MAX_PARALLEL);
        changes[stepId] = days === null ? null : { days, parallel: parallel ?? 1 };
      }
      return book.change((state) => {
        for (const [stepId, value] of Object.entries(changes)) {
          if (value === null) delete state.steps[stepId];
          else state.steps[stepId] = value;
        }
        state.updatedAt = clock().toISOString();
        state.updatedBy = text(by) || "direction";
        return structuredClone(state);
      });
    }
  });
}

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const isWorking = (iso, holidays) => new Date(`${iso}T00:00:00Z`).getUTCDay() !== 0 && !isHoliday(iso, holidays);

// The first working day on or after iso.
function workingFrom(iso, holidays) {
  let day = iso;
  while (!isWorking(day, holidays)) day = addDays(day, 1);
  return day;
}

// The last of count working days starting on start (itself a working day).
function endAfter(start, count, holidays) {
  let day = start;
  let left = count - 1;
  while (left > 0) {
    day = addDays(day, 1);
    if (isWorking(day, holidays)) left -= 1;
  }
  return day;
}

function workingBetween(from, to, holidays) {
  let count = 0;
  for (let day = from; day < to; day = addDays(day, 1)) {
    if (isWorking(day, holidays)) count += 1;
  }
  return count;
}

const promiseOf = (order) => order.steps?.find((step) => step.id === DELIVERY_STEP)?.plannedDate ?? null;

// Each open order scheduled, the earliest promise first (an order without a
// promise after them, by number). A step takes a free place among the orders
// the step can carry at once, after the previous step of the same order. A
// step in progress holds its place first, for what is left of its duration
// from today (a day at least); a blocked step is counted as if it started
// again today, for its whole duration.
//
// extra: a new order to try (« can we deliver before the 20th? »), with its
// promise or without, which is scheduled among the others.
export function workshopSchedule(orders, capacity, { today, holidays = [], extra = null }) {
  const start = workingFrom(today instanceof Date ? today.toISOString().slice(0, 10) : String(today).slice(0, 10), holidays);
  const steps = capacity.steps ?? {};
  const open = orders.filter((order) => !order.finished).map((order) => ({ order, promised: promiseOf(order), number: String(order.number), extra: false }));
  if (extra) {
    open.push({ order: { number: "nouvelle commande", client: "", steps: WORKSHOP_STEPS.map((step) => ({ id: step.id, status: "a_faire", plannedDate: step.id === DELIVERY_STEP ? extra.promised ?? null : null })) }, promised: extra.promised ?? null, number: "nouvelle commande", extra: true });
  }
  open.sort((a, b) => (a.promised ?? "9999").localeCompare(b.promised ?? "9999") || (a.extra ? 1 : 0) - (b.extra ? 1 : 0) || Number(a.number) - Number(b.number));

  const places = {};
  const placeFor = (stepId) => (places[stepId] ??= Array.from({ length: steps[stepId]?.parallel ?? 1 }, () => start));
  // Takes the earliest free place of the step, not before ready.
  const book = (stepId, ready, duration) => {
    const slots = placeFor(stepId);
    const index = slots.reduce((best, free, i) => (free < slots[best] ? i : best), 0);
    const begin = workingFrom(slots[index] > ready ? slots[index] : ready, holidays);
    const end = endAfter(begin, duration, holidays);
    slots[index] = workingFrom(addDays(end, 1), holidays);
    return end;
  };
  const plans = open.map((entry) => {
    const remaining = (entry.order.steps ?? []).filter((step) => step.status !== "terminee");
    const missing = remaining.filter((step) => !steps[step.id]?.days).map((step) => step.label ?? STEP_LABELS[step.id]);
    return { entry, remaining, missing, ready: start, last: start, from: 0, blocked: remaining.some((step) => step.status === "bloquee") };
  });
  // A step already started holds its place first: the steps not yet begun
  // come after it, whatever their promise.
  for (const plan of plans.filter((candidate) => candidate.missing.length === 0)) {
    const first = plan.remaining[0];
    if (first && ["en_cours", "bloquee"].includes(first.status)) {
      const { days } = steps[first.id];
      const duration = first.status === "en_cours" && first.startedDate ? Math.max(1, days - workingBetween(first.startedDate, start, holidays)) : days;
      plan.last = book(first.id, start, duration);
      plan.ready = workingFrom(addDays(plan.last, 1), holidays);
      plan.from = 1;
    }
  }
  const results = [];
  for (const plan of plans) {
    const { entry } = plan;
    if (plan.missing.length > 0) {
      results.push({ number: entry.number, client: entry.order.client ?? "", promised: entry.promised, end: null, verdict: "inconnu", missing: plan.missing, extra: entry.extra, blocked: plan.blocked });
      continue;
    }
    for (const step of plan.remaining.slice(plan.from)) {
      plan.last = book(step.id, plan.ready, steps[step.id].days);
      plan.ready = workingFrom(addDays(plan.last, 1), holidays);
    }
    const lastDay = plan.last;
    results.push({
      number: entry.number,
      client: entry.order.client ?? "",
      promised: entry.promised,
      end: lastDay,
      verdict: entry.promised ? (lastDay <= entry.promised ? "tenable" : "intenable") : "sans_date",
      lateBy: entry.promised && lastDay > entry.promised ? workingBetween(addDays(entry.promised, 1), addDays(lastDay, 1), holidays) : 0,
      missing: [],
      extra: entry.extra,
      blocked: plan.blocked
    });
  }
  return { from: start, orders: results, configured: Object.keys(steps).length > 0 };
}

// The orders whose promise the workshop cannot hold, as facts for
// Amélioration. Told to Production; a new promise is a new fact.
export function capacityFacts(schedule) {
  return schedule.orders.filter((entry) => entry.verdict === "intenable" && !entry.extra).map((entry) => ({
    source: "planning",
    key: `planning:bc:${entry.number}:${entry.promised}`,
    kind: "date_promise_intenable",
    severity: "haute",
    owner: "production",
    client: entry.client,
    orderNumber: entry.number,
    step: DELIVERY_STEP,
    reference: `BC n° ${entry.number}`,
    fact: `BC n° ${entry.number}${entry.client ? ` (${entry.client})` : ""} : livraison promise le ${french(entry.promised)}, mais la charge de l'atelier mène à une fin estimée le ${french(entry.end)} (${entry.lateBy} jour(s) ouvrable(s) de plus)${entry.blocked ? ", en supposant l'étape bloquée relancée aujourd'hui" : ""}. Replanifier avec l'atelier, ou prévenir le client.`
  }));
}

export const french = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
export { STEP_LABELS, DELIVERY_STEP };
