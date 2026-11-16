import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";

// What the AI costs (CDC sections 11 and 14: « contrôle des coûts d'utilisation
// des modèles IA »). Every call to the model is counted for the agent that made
// it: calls and tokens are what OpenAI reports, the cost is an estimate from the
// public price of the model. OpenAI's invoice is the reference.
//
// A monthly budget (HKIDS_AI_BUDGET_USD) raises an alert at 80 % and at 100 %,
// each once a month; HKIDS_AI_BUDGET_STOP=on also stops the Director once the
// budget is reached, until the month ends or the budget is raised.

export const DEFAULT_AI_USAGE_PATH = join(DATA_DIR, "couts-ia.json");

// Public list prices in USD per million tokens: input, cached input, output.
// HKIDS_AI_PRICES (JSON, same shape) corrects or completes them.
export const MODEL_PRICES = Object.freeze({
  "gpt-5": Object.freeze([1.25, 0.125, 10]),
  "gpt-5-mini": Object.freeze([0.25, 0.025, 2]),
  "gpt-5-nano": Object.freeze([0.05, 0.005, 0.4]),
  "gpt-4.1": Object.freeze([2, 0.5, 8]),
  "gpt-4.1-mini": Object.freeze([0.4, 0.1, 1.6]),
  "gpt-4o": Object.freeze([2.5, 1.25, 10]),
  "gpt-4o-mini": Object.freeze([0.15, 0.075, 0.6])
});
// Voice notes: text and audio heard, text written, per million tokens; or per
// minute for a model billed by duration.
export const TRANSCRIPTION_PRICES = Object.freeze({
  "gpt-4o-transcribe": Object.freeze({ text: 2.5, audio: 6, output: 10, minute: 0.006 }),
  "gpt-4o-mini-transcribe": Object.freeze({ text: 1.25, audio: 3, output: 5, minute: 0.003 }),
  "whisper-1": Object.freeze({ minute: 0.006 })
});
export const TRANSCRIPTION_AGENT = "transcription";
const ALERT_LEVELS = Object.freeze([80, 100]);
const KEPT_DAYS = 400;
const EMPTY = Object.freeze({ days: {}, alerts: {} });

export function createMemoryAiUsageBook() {
  return createMemoryJsonBook(EMPTY);
}

export function createFileAiUsageBook({ path = DEFAULT_AI_USAGE_PATH } = {}) {
  return createFileJsonBook(path, EMPTY);
}

// Read from .env. A budget or a rate that is not a positive number is none.
export function createAiUsageFromEnv({ env = process.env, book = createMemoryAiUsageBook(), clock = () => new Date(), onAlert = null } = {}) {
  const positive = (name) => (Number(env[name]) > 0 ? Number(env[name]) : null);
  let prices = {};
  try {
    prices = typeof env.HKIDS_AI_PRICES === "string" && env.HKIDS_AI_PRICES.trim() !== "" ? JSON.parse(env.HKIDS_AI_PRICES) : {};
  } catch {
    prices = {};
  }
  return createAiUsage({ book, clock, onAlert, prices, budgetUsd: positive("HKIDS_AI_BUDGET_USD"), usdToMad: positive("HKIDS_USD_MAD"), stopAtBudget: String(env.HKIDS_AI_BUDGET_STOP ?? "").trim().toLowerCase() === "on" });
}

export function createAiUsage({ book = createMemoryAiUsageBook(), clock = () => new Date(), prices = {}, budgetUsd = null, usdToMad = null, stopAtBudget = false, onAlert = null } = {}) {
  const table = { ...MODEL_PRICES, ...Object.fromEntries(Object.entries(prices ?? {}).filter(([, value]) => Array.isArray(value) && value.length === 3 && value.every((price) => Number.isFinite(Number(price)) && Number(price) >= 0)).map(([model, value]) => [model, value.map(Number)])) };

  // The price of a model, by its name or the name its dated version starts with.
  function priceOf(model) {
    const name = String(model ?? "");
    const key = Object.keys(table).filter((known) => name === known || name.startsWith(`${known}-`)).sort((a, b) => b.length - a.length)[0];
    return key ? table[key] : null;
  }

  async function add({ agent, model, calls = 1, input = 0, cached = 0, output = 0, cost = null }) {
    const now = clock();
    const day = dayOf(now);
    const month = day.slice(0, 7);
    const alert = await book.change((state) => {
      state.days ??= {};
      state.alerts ??= {};
      const line = ((state.days[day] ??= {})[agent] ??= { calls: 0, input: 0, cached: 0, output: 0, costUsd: 0, unpriced: 0, models: [] });
      line.calls += calls;
      line.input += input;
      line.cached += cached;
      line.output += output;
      if (cost === null) {
        line.unpriced += calls;
      } else {
        line.costUsd = round6(line.costUsd + cost);
      }
      if (model && !line.models.includes(model)) {
        line.models.push(model);
      }
      for (const old of Object.keys(state.days).sort().slice(0, -KEPT_DAYS)) {
        delete state.days[old];
      }
      if (!budgetUsd) {
        return null;
      }
      const spent = monthCost(state.days, month);
      const reached = ALERT_LEVELS.filter((level) => spent >= (budgetUsd * level) / 100 && !(state.alerts[month] ?? []).includes(level));
      if (reached.length === 0) {
        return null;
      }
      state.alerts[month] = [...(state.alerts[month] ?? []), ...reached];
      return { level: Math.max(...reached), month, spentUsd: round2(spent), budgetUsd };
    });
    if (alert && typeof onAlert === "function") {
      await Promise.resolve(onAlert(Object.freeze({ ...alert, text: alertText(alert, stopAtBudget) }))).catch(() => {});
    }
    return alert;
  }

  return Object.freeze({
    budgetUsd,
    stopAtBudget,

    // usage: what the Responses API returns with each answer.
    async record({ agent = "director", model = "", usage = null } = {}) {
      if (!usage) {
        return null;
      }
      const input = count(usage.input_tokens);
      const cached = Math.min(input, count(usage.input_tokens_details?.cached_tokens));
      const output = count(usage.output_tokens);
      const price = priceOf(model);
      const cost = price ? ((input - cached) * price[0] + cached * price[1] + output * price[2]) / 1_000_000 : null;
      return add({ agent, model, input, cached, output, cost });
    },

    // usage: what the transcription API returns, in tokens or in seconds.
    async recordTranscription({ model = "", usage = null } = {}) {
      if (!usage) {
        return null;
      }
      const price = TRANSCRIPTION_PRICES[model] ?? null;
      if (usage.type === "duration" || Number.isFinite(Number(usage.seconds))) {
        const seconds = Math.max(0, Number(usage.seconds) || 0);
        return add({ agent: TRANSCRIPTION_AGENT, model, cost: price?.minute ? (seconds / 60) * price.minute : null });
      }
      const input = count(usage.input_tokens);
      const audio = Math.min(input, count(usage.input_token_details?.audio_tokens ?? usage.input_tokens_details?.audio_tokens));
      const output = count(usage.output_tokens);
      const cost = price?.audio ? (audio * price.audio + (input - audio) * price.text + output * price.output) / 1_000_000 : null;
      return add({ agent: TRANSCRIPTION_AGENT, model, input, output, cost });
    },

    // The month's figures: the total, each agent, each day, and the budget.
    async summary({ month = "" } = {}) {
      const now = clock();
      const wanted = /^\d{4}-\d{2}$/.test(String(month)) ? String(month) : dayOf(now).slice(0, 7);
      const state = await book.load();
      const days = Object.entries(state.days ?? {}).filter(([day]) => day.startsWith(wanted)).sort(([a], [b]) => a.localeCompare(b));
      const agents = {};
      const byDay = [];
      for (const [day, lines] of days) {
        let dayCost = 0;
        let dayCalls = 0;
        for (const [agent, line] of Object.entries(lines)) {
          const total = (agents[agent] ??= { agent, calls: 0, input: 0, cached: 0, output: 0, costUsd: 0, unpriced: 0 });
          for (const key of ["calls", "input", "cached", "output", "unpriced"]) {
            total[key] += line[key] ?? 0;
          }
          total.costUsd = round6(total.costUsd + (line.costUsd ?? 0));
          dayCost += line.costUsd ?? 0;
          dayCalls += line.calls ?? 0;
        }
        byDay.push({ day, calls: dayCalls, costUsd: round2(dayCost) });
      }
      const byAgent = Object.values(agents).sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls).map((line) => ({ ...line, costUsd: round2(line.costUsd), costMad: usdToMad ? round2(line.costUsd * usdToMad) : null }));
      const costUsd = round2(Object.values(agents).reduce((sum, line) => sum + line.costUsd, 0));
      const unpriced = byAgent.reduce((sum, line) => sum + line.unpriced, 0);
      const current = wanted === dayOf(now).slice(0, 7);
      const elapsed = current ? now.getUTCDate() : daysIn(wanted);
      return Object.freeze({
        month: wanted,
        calls: byAgent.reduce((sum, line) => sum + line.calls, 0),
        inputTokens: byAgent.reduce((sum, line) => sum + line.input, 0),
        outputTokens: byAgent.reduce((sum, line) => sum + line.output, 0),
        costUsd,
        costMad: usdToMad ? round2(costUsd * usdToMad) : null,
        usdToMad,
        // Calls whose model has no known price: counted, not priced.
        unpricedCalls: unpriced,
        // At the pace of the days elapsed, what the whole month would cost.
        projectedUsd: current && elapsed > 0 ? round2((costUsd / elapsed) * daysIn(wanted)) : null,
        budget: budgetUsd ? { usd: budgetUsd, usedPercent: Math.round((costUsd / budgetUsd) * 100), remainingUsd: round2(Math.max(0, budgetUsd - costUsd)), reached: costUsd >= budgetUsd, stops: stopAtBudget } : null,
        byAgent,
        byDay,
        note: "Estimation d'après les jetons comptés par OpenAI et le tarif public du modèle ; la facture OpenAI fait foi."
      });
    },

    // True when the direction asked for the Director to stop at the budget and
    // the month has reached it.
    async overBudget() {
      if (!stopAtBudget || !budgetUsd) {
        return false;
      }
      return monthCost((await book.load()).days ?? {}, dayOf(clock()).slice(0, 7)) >= budgetUsd;
    }
  });
}

function alertText({ level, spentUsd, budgetUsd }, stops) {
  return level >= 100
    ? `Budget IA du mois atteint : ${formatUsd(spentUsd)} dépensés sur ${formatUsd(budgetUsd)} (estimation).${stops ? " Le Director s'arrête jusqu'à la fin du mois ou jusqu'à ce que le budget soit relevé (HKIDS_AI_BUDGET_USD)." : " Le Director continue de répondre ; relevez ou surveillez le budget (HKIDS_AI_BUDGET_USD)."}`
    : `Budget IA du mois consommé à ${level} % : ${formatUsd(spentUsd)} sur ${formatUsd(budgetUsd)} (estimation).`;
}

function monthCost(days, month) {
  return Object.entries(days).filter(([day]) => day.startsWith(month)).reduce((sum, [, lines]) => sum + Object.values(lines).reduce((inner, line) => inner + (line.costUsd ?? 0), 0), 0);
}

function dayOf(date) {
  return date.toISOString().slice(0, 10);
}

function daysIn(month) {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index, 0)).getUTCDate();
}

function count(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Math.round(Number(value)) : 0;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function formatUsd(value) {
  return `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value).replace(/ /g, " ")} $`;
}
