import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The Director's action plans, kept from one day to the next. A plan has an
// objective, a strategy, priorities and steps; each step belongs to an agent,
// moves from "à faire" to "fait" (or "bloqué"), may have a due date, and keeps
// what was found when it was done. A journal records every change, so Hiba can
// see how a plan moved and who moved it.
//
// Stored as one JSON file under data/ (ignored by git): it survives a restart
// without a schema migration. The store is an interface, so the plans can move
// to the database later without the Director noticing.

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DEFAULT_PLANS_PATH = join(PROJECT_ROOT, "data", "plans-director.json");

export const STEP_STATUSES = Object.freeze(["todo", "in_progress", "done", "blocked"]);
export const PLAN_STATUSES = Object.freeze(["active", "done", "abandoned"]);

export class PlanStoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PlanStoreError";
    this.code = code;
  }
}

export function createMemoryPlanStore({ clock = () => new Date() } = {}) {
  let plans = [];
  return createPlanStore({
    clock,
    load: async () => plans,
    save: async (next) => {
      plans = next;
    }
  });
}

export function createFilePlanStore({ path = DEFAULT_PLANS_PATH, clock = () => new Date() } = {}) {
  return createPlanStore({
    clock,
    load: async () => {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },
    // Written to a temporary file and renamed, so a crash never leaves half a file.
    save: async (plans) => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify(plans, null, 2));
      await rename(temporary, path);
    }
  });
}

function createPlanStore({ load, save, clock }) {
  // Changes are applied one at a time, so two requests never overwrite each other.
  let queue = Promise.resolve();
  const exclusive = (work) => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };
  const now = () => clock().toISOString();

  async function mutate(id, change) {
    return exclusive(async () => {
      const plans = await load();
      const plan = plans.find((entry) => entry.id === id);
      if (!plan) {
        throw new PlanStoreError(`Plan introuvable : ${id}`, "PLAN_NOT_FOUND");
      }
      change(plan);
      plan.updatedAt = now();
      refreshPlanStatus(plan, now());
      await save(plans);
      return withProgress(plan, clock());
    });
  }

  return Object.freeze({
    // target, when the plan pursues a figure: { indicator, amount, currency, from, to }.
    async create({ objective, strategy = "", priorities = [], steps = [], createdBy = null, request = "", target = null }) {
      return exclusive(async () => {
        const plans = await load();
        const createdAt = now();
        const plan = {
          id: randomUUID(),
          number: plans.reduce((max, entry) => Math.max(max, entry.number ?? 0), 0) + 1,
          objective,
          strategy,
          priorities,
          request,
          target,
          status: "active",
          createdAt,
          updatedAt: createdAt,
          createdBy,
          steps: steps.map((step) => newStep(step, createdAt)),
          journal: [{ at: createdAt, by: "director", text: "Plan créé." }]
        };
        plans.push(plan);
        await save(plans);
        return withProgress(plan, clock());
      });
    },

    async list({ status = null } = {}) {
      const plans = await load();
      return plans
        .filter((plan) => !status || plan.status === status)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((plan) => withProgress(plan, clock()));
    },

    async get(id) {
      const plan = (await load()).find((entry) => entry.id === id || String(entry.number) === String(id));
      return plan ? withProgress(plan, clock()) : null;
    },

    // index is 1-based, as the plan is read by a person.
    async updateStep(id, index, { status = null, result = null, dueDate = null, by = "director" } = {}) {
      return mutate(id, (plan) => {
        const step = plan.steps[index - 1];
        if (!step) {
          throw new PlanStoreError(`Le plan n'a pas d'étape ${index}.`, "STEP_NOT_FOUND");
        }
        if (status && !STEP_STATUSES.includes(status)) {
          throw new PlanStoreError(`Statut d'étape inconnu : ${status}`, "INVALID_STEP_STATUS");
        }
        const changes = [];
        if (status && status !== step.status) {
          changes.push(`${STEP_LABELS[step.status]} → ${STEP_LABELS[status]}`);
          step.status = status;
        }
        if (result) {
          step.result = result;
          changes.push("résultat enregistré");
        }
        if (dueDate) {
          step.dueDate = dueDate;
          changes.push(`échéance ${dueDate}`);
        }
        step.updatedAt = now();
        if (changes.length > 0) {
          plan.journal.push({ at: now(), by, text: `Étape ${index} (${step.task}) : ${changes.join(", ")}.` });
        }
      });
    },

    async addSteps(id, steps, { by = "director" } = {}) {
      return mutate(id, (plan) => {
        const at = now();
        for (const step of steps) {
          plan.steps.push(newStep(step, at));
          plan.journal.push({ at, by, text: `Étape ajoutée : ${step.task}.` });
        }
      });
    },

    async addNote(id, text, { by = "director" } = {}) {
      return mutate(id, (plan) => {
        plan.journal.push({ at: now(), by, text });
      });
    },

    async close(id, status, { by = "director", reason = "" } = {}) {
      if (!PLAN_STATUSES.includes(status)) {
        throw new PlanStoreError(`Statut de plan inconnu : ${status}`, "INVALID_PLAN_STATUS");
      }
      return mutate(id, (plan) => {
        plan.status = status;
        plan.closedManually = true;
        plan.journal.push({ at: now(), by, text: `Plan ${status === "done" ? "terminé" : status === "abandoned" ? "abandonné" : "réouvert"}${reason ? ` : ${reason}` : ""}.` });
      });
    }
  });
}

export const STEP_LABELS = Object.freeze({ todo: "à faire", in_progress: "en cours", done: "fait", blocked: "bloqué" });

function newStep(step, at) {
  return {
    agent: step.agent,
    task: step.task,
    status: STEP_STATUSES.includes(step.status) ? step.status : "todo",
    dueDate: step.dueDate || null,
    result: step.result || null,
    updatedAt: at
  };
}

// A plan whose every step is done is done, unless someone closed or reopened it
// by hand: then their decision stands.
function refreshPlanStatus(plan, at) {
  if (plan.closedManually) {
    return;
  }
  const allDone = plan.steps.length > 0 && plan.steps.every((step) => step.status === "done");
  if (allDone && plan.status === "active") {
    plan.status = "done";
    plan.journal.push({ at, by: "director", text: "Toutes les étapes sont faites : plan terminé." });
  }
}

function withProgress(plan, today) {
  const day = today.toISOString().slice(0, 10);
  const steps = plan.steps.map((step, index) => ({
    ...step,
    index: index + 1,
    overdue: Boolean(step.dueDate && step.status !== "done" && step.dueDate < day)
  }));
  const done = steps.filter((step) => step.status === "done").length;
  return Object.freeze({
    ...plan,
    steps,
    progress: Object.freeze({
      done,
      total: steps.length,
      percent: steps.length === 0 ? 0 : Math.round((done / steps.length) * 100),
      blocked: steps.filter((step) => step.status === "blocked").length,
      overdue: steps.filter((step) => step.overdue).length
    })
  });
}
