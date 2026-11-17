import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";

// The automations the direction writes itself, without code (CDC V2, section
// 10.A): « quand un devis est accepté, prévenir la production et me rappeler
// la deuxième échéance dans 30 jours ». A rule is an event, an optional
// filter, and actions, each now or some days later.
//
// What a rule can do stays inside the company and inside the validations:
// it tells an agent (team feed), gives an agent a mission (the agent prepares,
// nothing is generated or sent without the direction), writes to the
// direction on WhatsApp, or gives a task to the person behind an agent. It
// never issues a document, never pays, never writes to a client.
//
// The book (data/automatisations.json) keeps the rules, the actions waiting
// for their day, and what ran.

export const DEFAULT_AUTOMATION_PATH = join(DATA_DIR, "automatisations.json");
const MAX_RUNS = 500;
const MAX_RULES = 60;
const MAX_ACTIONS = 5;
const MAX_TEXT = 1000;
// One rule never runs more than this in a day: a loop or a burst of events
// stops there and says so.
export const MAX_RUNS_PER_RULE_PER_DAY = 20;

// What can start a rule, with what its texts may quote ({numero}, {client}…).
export const AUTOMATION_EVENTS = Object.freeze({
  devis_emis: Object.freeze({ label: "Un devis est émis", fields: ["numero", "client", "montant", "objet"] }),
  devis_accepte: Object.freeze({ label: "Un devis est accepté (bon de commande émis)", fields: ["numero", "client", "montant", "reference_devis", "objet"] }),
  facture_emise: Object.freeze({ label: "Une facture est émise", fields: ["numero", "client", "montant", "reference_devis", "objet"] }),
  bl_emis: Object.freeze({ label: "Un bon de livraison est émis", fields: ["numero", "client", "reference_devis"] }),
  avoir_emis: Object.freeze({ label: "Un avoir est émis", fields: ["numero", "client", "montant", "reference_facture"] }),
  recu_emis: Object.freeze({ label: "Un reçu de paiement est émis", fields: ["numero", "client", "montant", "reference_devis"] }),
  encaissement: Object.freeze({ label: "Un encaissement est noté en caisse", fields: ["montant", "libelle", "client", "reference_devis", "commande", "moyen"] }),
  depense: Object.freeze({ label: "Une dépense est notée en caisse", fields: ["montant", "libelle", "fournisseur", "commande", "moyen"] }),
  etape_terminee: Object.freeze({ label: "Une étape d'atelier est terminée", fields: ["commande", "etape", "client"] }),
  etape_bloquee: Object.freeze({ label: "Une étape d'atelier est bloquée", fields: ["commande", "etape", "client", "raison"] }),
  retard_atelier: Object.freeze({ label: "Une étape d'atelier passe en retard", fields: ["commande", "etape", "fait"] }),
  bl_signe: Object.freeze({ label: "Le client signe son bon de livraison", fields: ["numero", "commande", "client", "signataire"] }),
  nouveau_prospect: Object.freeze({ label: "Un prospect est transmis par le Community Manager", fields: ["prospect", "nom", "ville", "besoin", "reseau"] })
});

export const AUTOMATION_ACTIONS = Object.freeze({
  informer_agent: "Prévenir un agent (fil de l'équipe)",
  mission_agent: "Confier une mission à un agent",
  prevenir_direction: "Écrire à la direction sur WhatsApp",
  tache_equipe: "Donner une tâche au responsable d'un agent"
});

export class AutomationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AutomationError";
    this.code = code;
  }
}

const EMPTY = Object.freeze({ rules: [], queue: [], runs: [] });

export function createMemoryAutomationBook() {
  return createMemoryJsonBook(EMPTY);
}

export function createFileAutomationBook({ path = DEFAULT_AUTOMATION_PATH } = {}) {
  return createFileJsonBook(path, EMPTY);
}

// executors: { informer({agent, text, rule}), mission({agent, text, rule}),
// direction({text, rule}), task({agent, text, dueDays, rule}) }, each async.
export function createAutomation({ book = createMemoryAutomationBook(), executors = {}, agents = [], clock = () => new Date(), log = () => {} } = {}) {
  const known = (agent) => agents.length === 0 || agents.includes(agent);

  function cleanRule(input) {
    const name = text(input.name).slice(0, 120);
    const event = text(input.event);
    if (!Object.hasOwn(AUTOMATION_EVENTS, event)) {
      throw new AutomationError(`Événement inconnu : ${event || "(vide)"}. Possibles : ${Object.keys(AUTOMATION_EVENTS).join(", ")}.`, "AUTOMATION_EVENT_UNKNOWN");
    }
    const filters = {};
    const minimum = Number(String(input.filters?.minAmount ?? "").replace(",", "."));
    if (Number.isFinite(minimum) && minimum > 0) {
      filters.minAmount = Math.round(minimum * 100) / 100;
    }
    const step = text(input.filters?.step);
    if (step) {
      filters.step = step;
    }
    const contains = text(input.filters?.contains).slice(0, 80);
    if (contains) {
      filters.contains = contains;
    }
    const actions = (Array.isArray(input.actions) ? input.actions : []).map(cleanAction);
    if (actions.length === 0) {
      throw new AutomationError("Une règle a au moins une action.", "AUTOMATION_ACTION_MISSING");
    }
    if (actions.length > MAX_ACTIONS) {
      throw new AutomationError(`${MAX_ACTIONS} actions au plus par règle.`, "AUTOMATION_TOO_MANY_ACTIONS");
    }
    return { name: name || AUTOMATION_EVENTS[event].label, event, filters, actions, active: input.active !== false };
  }

  function cleanAction(action) {
    const kind = text(action?.kind);
    if (!Object.hasOwn(AUTOMATION_ACTIONS, kind)) {
      throw new AutomationError(`Action inconnue : ${kind || "(vide)"}. Possibles : ${Object.keys(AUTOMATION_ACTIONS).join(", ")}.`, "AUTOMATION_ACTION_UNKNOWN");
    }
    const message = text(action.text);
    if (!message) {
      throw new AutomationError("Chaque action dit quoi faire (texte).", "AUTOMATION_TEXT_MISSING");
    }
    if (message.length > MAX_TEXT) {
      throw new AutomationError(`Le texte d'une action tient en ${MAX_TEXT} caractères.`, "AUTOMATION_TEXT_TOO_LONG");
    }
    const agent = text(action.agent);
    if (kind !== "prevenir_direction" && (!agent || !known(agent))) {
      throw new AutomationError(`Agent inconnu : ${agent || "(vide)"}.`, "AUTOMATION_AGENT_UNKNOWN");
    }
    const delayDays = Math.max(0, Math.min(365, Math.round(Number(action.delayDays) || 0)));
    const dueDays = Math.max(1, Math.min(60, Math.round(Number(action.dueDays) || 3)));
    return { kind, text: message, ...(kind === "prevenir_direction" ? {} : { agent }), delayDays, ...(kind === "tache_equipe" ? { dueDays } : {}) };
  }

  async function run(rule, action, payload) {
    const message = fill(action.text, payload);
    const executor = { informer_agent: executors.informer, mission_agent: executors.mission, prevenir_direction: executors.direction, tache_equipe: executors.task }[action.kind];
    let outcome;
    try {
      if (!executor) {
        throw new Error("Action indisponible sur ce serveur.");
      }
      const result = await executor({ agent: action.agent, text: message, dueDays: action.dueDays, rule: { id: rule.id, number: rule.number, name: rule.name }, payload });
      outcome = { ok: true, detail: typeof result === "string" ? result.slice(0, 300) : "" };
    } catch (error) {
      outcome = { ok: false, detail: String(error?.message ?? error).slice(0, 300) };
      log(error);
    }
    await book.change((state) => {
      state.runs.push({ id: randomUUID(), at: clock().toISOString(), rule: rule.number, ruleName: rule.name, action: action.kind, agent: action.agent ?? null, text: message.slice(0, 400), ok: outcome.ok, detail: outcome.detail });
      if (state.runs.length > MAX_RUNS) {
        state.runs.splice(0, state.runs.length - MAX_RUNS);
      }
    });
    return outcome;
  }

  return Object.freeze({
    async rules() {
      return (await book.load()).rules;
    },

    async runs({ limit = 50 } = {}) {
      return (await book.load()).runs.slice(-limit).reverse();
    },

    async queue() {
      return (await book.load()).queue;
    },

    async create(input, { by = "direction" } = {}) {
      const rule = cleanRule(input ?? {});
      return book.change((state) => {
        if (state.rules.length >= MAX_RULES) {
          throw new AutomationError(`${MAX_RULES} règles au plus : supprimez-en une d'abord.`, "AUTOMATION_TOO_MANY_RULES");
        }
        const created = { id: randomUUID(), number: state.rules.reduce((max, entry) => Math.max(max, entry.number), 0) + 1, ...rule, createdBy: by, createdAt: clock().toISOString(), updatedAt: null, firedToday: { day: null, count: 0 } };
        state.rules.push(created);
        return { ...created };
      });
    },

    async update(reference, input, { by = "direction" } = {}) {
      return book.change((state) => {
        const rule = findRule(state, reference);
        const next = cleanRule({ ...rule, ...input, filters: input.filters ?? rule.filters, actions: input.actions ?? rule.actions });
        Object.assign(rule, next, { updatedAt: clock().toISOString(), updatedBy: by });
        return { ...rule };
      });
    },

    async setActive(reference, active, { by = "direction" } = {}) {
      return book.change((state) => {
        const rule = findRule(state, reference);
        rule.active = active === true;
        rule.updatedAt = clock().toISOString();
        rule.updatedBy = by;
        // A rule switched off takes its waiting actions with it.
        if (!rule.active) {
          state.queue = state.queue.filter((entry) => entry.ruleId !== rule.id);
        }
        return { ...rule };
      });
    },

    async remove(reference) {
      return book.change((state) => {
        const rule = findRule(state, reference);
        state.rules = state.rules.filter((entry) => entry.id !== rule.id);
        state.queue = state.queue.filter((entry) => entry.ruleId !== rule.id);
        return true;
      });
    },

    // Something happened. The matching rules are found and their actions
    // queued at once; those due now run in the background, so whoever
    // reported the event never waits for an agent.
    async emit(event, payload = {}) {
      if (!Object.hasOwn(AUTOMATION_EVENTS, event)) {
        return { started: 0, done: Promise.resolve([]) };
      }
      const now = clock();
      const day = now.toISOString().slice(0, 10);
      const due = await book.change((state) => {
        const started = [];
        for (const rule of state.rules) {
          if (!rule.active || rule.event !== event || !matches(rule.filters, payload)) {
            continue;
          }
          rule.firedToday = rule.firedToday?.day === day ? rule.firedToday : { day, count: 0 };
          if (rule.firedToday.count >= MAX_RUNS_PER_RULE_PER_DAY) {
            if (rule.firedToday.count === MAX_RUNS_PER_RULE_PER_DAY) {
              rule.firedToday.count += 1;
              state.runs.push({ id: randomUUID(), at: now.toISOString(), rule: rule.number, ruleName: rule.name, action: "limite", agent: null, text: `Règle arrêtée pour aujourd'hui : ${MAX_RUNS_PER_RULE_PER_DAY} déclenchements atteints.`, ok: false, detail: "" });
            }
            continue;
          }
          rule.firedToday.count += 1;
          rule.lastFiredAt = now.toISOString();
          for (const action of rule.actions) {
            const entry = { id: randomUUID(), ruleId: rule.id, action, payload, dueAt: new Date(now.getTime() + action.delayDays * 86_400_000).toISOString(), queuedAt: now.toISOString() };
            if (action.delayDays > 0) {
              state.queue.push(entry);
            } else {
              started.push({ rule: { id: rule.id, number: rule.number, name: rule.name }, action, payload });
            }
          }
        }
        return started;
      });
      const running = Promise.all(due.map((entry) => run(entry.rule, entry.action, entry.payload)));
      running.catch(() => {});
      return { started: due.length, done: running };
    },

    // The actions whose day has come; called by the server's timer.
    async tick(now = clock()) {
      const due = await book.change((state) => {
        const ready = state.queue.filter((entry) => Date.parse(entry.dueAt) <= now.getTime());
        state.queue = state.queue.filter((entry) => Date.parse(entry.dueAt) > now.getTime());
        return ready.map((entry) => ({ entry, rule: state.rules.find((candidate) => candidate.id === entry.ruleId) })).filter((item) => item.rule?.active);
      });
      for (const { entry, rule } of due) {
        await run(rule, entry.action, entry.payload);
      }
      return due.length;
    }
  });
}

function findRule(state, reference) {
  const rule = state.rules.find((entry) => entry.id === reference || String(entry.number) === String(reference));
  if (!rule) {
    throw new AutomationError(`Aucune règle n° ${reference}.`, "AUTOMATION_RULE_NOT_FOUND");
  }
  return rule;
}

function matches(filters = {}, payload) {
  if (filters.minAmount && !(Number(payload.montant_valeur ?? 0) >= filters.minAmount)) {
    return false;
  }
  if (filters.step && payload.etape_id !== filters.step) {
    return false;
  }
  if (filters.contains) {
    const haystack = fold(Object.values(payload).filter((value) => typeof value === "string").join(" "));
    if (!haystack.includes(fold(filters.contains))) {
      return false;
    }
  }
  return true;
}

// {numero}, {client}… replaced by what the event carries; an unknown one stays
// visible, so a typo shows instead of vanishing.
export function fill(template, payload) {
  return String(template).replace(/\{([a-z_]+)\}/g, (whole, key) => (payload[key] === undefined || payload[key] === null || payload[key] === "" ? (Object.hasOwn(payload, key) ? "—" : whole) : String(payload[key])));
}

function fold(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
