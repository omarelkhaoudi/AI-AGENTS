import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { createFilePlanStore, createMemoryPlanStore } from "../src/agent/plan-store.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

const STEPS = [
  { agent: "finance", task: "Relancer l'acompte Atlas", dueDate: "2026-11-04" },
  { agent: "production", task: "Replanifier l'atelier" }
];

test("a plan survives a restart: the file store reads back what it wrote", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hkids-plans-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "plans.json");

  const created = await createFilePlanStore({ path }).create({ objective: "Débloquer Atlas", steps: STEPS });
  const reopened = createFilePlanStore({ path });
  const plan = await reopened.get(created.id);

  assert.equal(plan.number, 1);
  assert.equal(plan.objective, "Débloquer Atlas");
  assert.deepEqual(plan.steps.map((step) => step.status), ["todo", "todo"]);
  assert.equal((await reopened.get("1")).id, created.id, "a plan is found by its number too");
});

test("progress, overdue steps and the journal follow every change", async () => {
  const store = createMemoryPlanStore({ clock: () => new Date("2026-11-06T09:00:00Z") });
  const plan = await store.create({ objective: "Débloquer Atlas", steps: STEPS });
  assert.equal(plan.progress.overdue, 1, "due on the 4th, still to do on the 6th");

  const blocked = await store.updateStep(plan.id, 2, { status: "blocked", result: "Aluminium en rupture", by: "hiba" });
  assert.equal(blocked.progress.blocked, 1);
  assert.match(blocked.journal.at(-1).text, /Étape 2 .*à faire → bloqué/);
  assert.equal(blocked.journal.at(-1).by, "hiba");

  await store.updateStep(plan.id, 1, { status: "done" });
  const finished = await store.updateStep(plan.id, 2, { status: "done" });
  assert.equal(finished.status, "done", "every step done closes the plan");
  assert.equal(finished.progress.percent, 100);

  const reopened = await store.close(plan.id, "active", { reason: "Nouveau retard" });
  assert.equal(reopened.status, "active");
  const stillOpen = await store.addSteps(plan.id, [{ agent: "commercial", task: "Prévenir le client" }]);
  assert.equal(stillOpen.status, "active", "a plan reopened by hand stays open");
  assert.equal(stillOpen.progress.total, 3);
});

test("days later, the Director picks the plan up, has the next step done, and reports progress", async (t) => {
  const planStore = createMemoryPlanStore();
  const isDirector = (p) => p.instructions.startsWith("Tu es le Director IA");
  const outputs = (p) => p.input.filter((item) => item.type === "function_call_output").map((item) => item.call_id);
  const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
  let day = 1;
  const client = { responses: { create: async (p) => {
    if (!isDirector(p)) {
      return { output_text: day === 1 ? "Acompte Atlas : 12000 MAD en retard." : "Atelier replanifié : Atlas au 12/11.", output: [] };
    }
    const done = outputs(p);
    if (day === 1) {
      if (!done.includes("plan")) {
        return call("etablir_plan_action", {
          objectif: "Débloquer la commande Atlas", strategie: "Encaisser puis replanifier", priorites: ["Acompte"],
          etapes: [{ agent: "finance", tache: "Relancer l'acompte", echeance: "" }, { agent: "production", tache: "Replanifier l'atelier", echeance: "2026-11-10" }]
        }, "plan");
      }
      if (!done.includes("fin")) {
        return call("deleguer_a_un_agent", { agent: "finance", mission: "Relancer l'acompte Atlas" }, "fin");
      }
      return { output_text: "Plan n° 1 lancé : 1/2 étapes.", output: [] };
    }
    if (!done.includes("list")) {
      return call("lister_plans", { statut: "active" }, "list");
    }
    if (!done.includes("prod")) {
      return call("deleguer_a_un_agent", { agent: "production", mission: "Replanifier l'atelier Atlas" }, "prod");
    }
    if (!done.includes("note")) {
      return call("ajuster_plan", {
        numero: 1,
        etapes: [{ etape: 1, statut: "done", resultat: "Acompte reçu", echeance: "" }, { etape: 2, statut: "done", resultat: "", echeance: "" }],
        nouvelles_etapes: [], note: "Acompte reçu le 05/11.", cloture: ""
      }, "note");
    }
    return { output_text: "Plan n° 1 terminé : 2/2 étapes.", output: [] };
  } } };
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), agentClient: client, planStore });
  t.after(() => app.close());

  const first = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Débloque Atlas" } })).body);
  assert.equal(first.plan.number, 1);
  assert.deepEqual(first.plan.steps.map((step) => step.status), ["in_progress", "todo"],
    "an agent's work moves its step to in progress, never straight to done");

  // A later day, a new conversation: the plan is still there.
  day = 2;
  const second = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Où en est le plan Atlas ? L'acompte est arrivé." } })).body);
  assert.equal(second.plan.number, 1);
  assert.equal(second.plan.status, "done");
  assert.deepEqual(second.plan.steps.map((step) => step.status), ["done", "done"]);
  assert.ok(second.plan.journal.some((entry) => entry.text === "Acompte reçu le 05/11."));

  const { plans } = JSON.parse((await inject({ method: "GET", url: "/api/plans" })).body);
  assert.equal(plans.length, 1, "picking a plan up never creates a second one");
});

test("Hiba moves a step from the cockpit, and the journal says she did", async (t) => {
  const planStore = createMemoryPlanStore();
  const plan = await planStore.create({ objective: "Débloquer Atlas", steps: STEPS });
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), planStore });
  t.after(() => app.close());

  const moved = await inject({ method: "PATCH", url: `/api/plans/${plan.id}/steps/2`, payload: { status: "blocked" } });
  const body = JSON.parse(moved.body);
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(body.plan.steps[1].status, "blocked");
  assert.notEqual(body.plan.journal.at(-1).by, "director");

  assert.equal((await inject({ method: "PATCH", url: `/api/plans/${plan.id}/steps/9`, payload: { status: "done" } })).statusCode, 400);
  assert.equal((await inject({ method: "PATCH", url: "/api/plans/inconnu/steps/1", payload: { status: "done" } })).statusCode, 404);

  const closed = JSON.parse((await inject({ method: "POST", url: `/api/plans/${plan.id}/close`, payload: { action: "abandonner" } })).body);
  assert.equal(closed.plan.status, "abandoned");
});
