import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { MAX_RUNS_PER_RULE_PER_DAY, createAutomation, fill } from "../src/agent/automation.js";
import { runAutomationTool } from "../src/agent/automation-tools.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

const DAY = 86_400_000;

function recorder() {
  const done = [];
  const executor = (kind) => async (input) => {
    done.push({ kind, ...input });
    return `${kind} ok`;
  };
  return { done, executors: { informer: executor("informer"), mission: executor("mission"), direction: executor("direction"), task: executor("task") } };
}

test("a rule fires on its event and filter, now or on its day, with the event's fields in its texts", async () => {
  const now = new Date("2026-11-17T09:00:00Z");
  const { done, executors } = recorder();
  const automation = createAutomation({ executors, agents: SPECIALIST_IDS, clock: () => now });
  const rule = await automation.create({
    name: "Gros devis accepté",
    event: "devis_accepte",
    filters: { minAmount: "10000" },
    actions: [
      { kind: "informer_agent", agent: "production", text: "BC {numero} ({client}, {montant}) à planifier." },
      { kind: "tache_equipe", agent: "finance", text: "Rappel de paiement {client}, BC {numero}.", delayDays: 30, dueDays: 3 }
    ]
  });
  assert.equal(rule.number, 1);

  const small = await automation.emit("devis_accepte", { numero: "170", client: "MADAME EXEMPLE", montant: "5 000,00 DH", montant_valeur: 5000 });
  assert.equal(small.started, 0, "below the minimum amount, nothing");

  const big = await automation.emit("devis_accepte", { numero: "171", client: "MADAME EXEMPLE", montant: "19 500,00 DH", montant_valeur: 19500 });
  await big.done;
  assert.deepEqual(done.map((entry) => [entry.kind, entry.agent, entry.text]), [["informer", "production", "BC 171 (MADAME EXEMPLE, 19 500,00 DH) à planifier."]]);
  assert.equal((await automation.queue()).length, 1, "the reminder waits for its day");

  assert.equal(await automation.tick(new Date(now.getTime() + 29 * DAY)), 0);
  assert.equal(await automation.tick(new Date(now.getTime() + 30 * DAY)), 1);
  assert.deepEqual([done[1].kind, done[1].agent, done[1].dueDays, done[1].text], ["task", "finance", 3, "Rappel de paiement MADAME EXEMPLE, BC 171."]);
  const runs = await automation.runs();
  assert.equal(runs.length, 2);
  assert.ok(runs.every((entry) => entry.ok));

  // Paused, it neither fires nor keeps what it had waiting.
  await automation.emit("devis_accepte", { numero: "172", montant_valeur: 20000 });
  assert.equal((await automation.queue()).length, 1);
  await automation.setActive(1, false);
  assert.equal((await automation.queue()).length, 0);
  assert.equal((await automation.emit("devis_accepte", { numero: "173", montant_valeur: 20000 })).started, 0);
});

test("a rule stops after its daily limit, and a failing action is written, not thrown", async () => {
  const automation = createAutomation({
    executors: { direction: async () => { throw new Error("WhatsApp indisponible"); } },
    agents: SPECIALIST_IDS,
    clock: () => new Date("2026-11-17T09:00:00Z")
  });
  await automation.create({ event: "encaissement", actions: [{ kind: "prevenir_direction", text: "Encaissement de {montant}." }] });
  for (let index = 0; index < MAX_RUNS_PER_RULE_PER_DAY + 3; index += 1) {
    await (await automation.emit("encaissement", { montant: "100,00 DH", montant_valeur: 100 })).done;
  }
  const runs = await automation.runs({ limit: 100 });
  assert.equal(runs.filter((entry) => entry.action === "prevenir_direction").length, MAX_RUNS_PER_RULE_PER_DAY);
  assert.equal(runs.filter((entry) => entry.action === "limite").length, 1, "the limit is said once");
  assert.match(runs.find((entry) => entry.action === "prevenir_direction").detail, /WhatsApp indisponible/);
});

test("a rule is checked before it is kept", async () => {
  const automation = createAutomation({ agents: SPECIALIST_IDS });
  await assert.rejects(automation.create({ event: "inconnu", actions: [{ kind: "prevenir_direction", text: "x" }] }), { code: "AUTOMATION_EVENT_UNKNOWN" });
  await assert.rejects(automation.create({ event: "devis_emis", actions: [] }), { code: "AUTOMATION_ACTION_MISSING" });
  await assert.rejects(automation.create({ event: "devis_emis", actions: [{ kind: "envoyer_au_client", text: "x" }] }), { code: "AUTOMATION_ACTION_UNKNOWN" });
  await assert.rejects(automation.create({ event: "devis_emis", actions: [{ kind: "informer_agent", agent: "inconnu", text: "x" }] }), { code: "AUTOMATION_AGENT_UNKNOWN" });
  await assert.rejects(automation.create({ event: "devis_emis", actions: [{ kind: "informer_agent", agent: "commercial", text: " " }] }), { code: "AUTOMATION_TEXT_MISSING" });
  await assert.rejects(automation.update(9, {}), { code: "AUTOMATION_RULE_NOT_FOUND" });
  assert.equal(fill("BC {numero} — {inconnu} — {objet}", { numero: "164", objet: "" }), "BC 164 — {inconnu} — —");
});

test("the Director writes an automation for the direction only", async () => {
  const automation = createAutomation({ agents: SPECIALIST_IDS });
  const args = { nom: "Étape bloquée", evenement: "etape_bloquee", montant_minimum: 0, etape: "", contient: "", actions: [{ type: "prevenir_direction", agent: "", texte: "BC {commande} bloqué : {raison}", delai_jours: 0, echeance_jours: 0 }] };
  const refused = await runAutomationTool("creer_automatisation", args, { automation, confidential: false });
  assert.equal(refused.ok, false);
  const created = await runAutomationTool("creer_automatisation", args, { automation, confidential: true });
  assert.equal(created.ok, true);
  assert.equal(created.regle.quand, "Une étape d'atelier est bloquée");
  const listed = await runAutomationTool("automatisations", { action: "lister", numero: "" }, { automation, confidential: false });
  assert.equal(listed.regles.length, 1, "the team may read them");
  assert.equal((await runAutomationTool("automatisations", { action: "pause", numero: "1" }, { automation, confidential: true })).regle.active, false);
});

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`never happened: ${label}`);
}

// Invented client, as in every committed fixture.
const ORDER = Object.freeze({
  documentType: "purchase_order",
  documentNumber: "164",
  date: "30/10/2026",
  object: "Lit maisonnette mezzanine",
  client: { name: "MADAME EXEMPLE", address: "12 rue Exemple, Ville Exemple" },
  items: [{ designation: "Lit maisonnette mezzanine", quantity: 1, unitPriceHt: 15000, amountHt: 15000 }],
  totals: { totalHt: 15000, tva: 3000, totalTtc: 18000 },
  payment: { termsRule: "hkids-po-50-50" }
});

test("in the cockpit, a purchase order and a blocked step start the direction's rules", async (t) => {
  const repository = new InMemoryRepository();
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-automations-"));
  const { app, inject } = await buildAuthenticatedApi({ repository, documentOutputDir: outputDir });
  t.after(async () => {
    await app.close();
    await rm(outputDir, { recursive: true, force: true });
  });

  const created = await inject({
    method: "POST",
    url: "/api/automations",
    payload: {
      name: "Devis accepté : lancer la commande",
      event: "devis_accepte",
      actions: [
        { kind: "informer_agent", agent: "production", text: "BC {numero} ({client}, {montant}) : à planifier." },
        { kind: "tache_equipe", agent: "finance", text: "Premier rappel de paiement à {client}.", delayDays: 30 }
      ]
    }
  });
  assert.equal(created.statusCode, 201, created.body);
  const blocked = await inject({ method: "POST", url: "/api/automations", payload: { event: "etape_bloquee", filters: { step: "approvisionnement" }, actions: [{ kind: "prevenir_direction", text: "BC {commande} ({client}) : {etape} bloquée, {raison}." }] } });
  assert.equal(blocked.statusCode, 201, blocked.body);

  const operator = await createAuthenticatedUser(repository, { id: "karim", role: "operator" });
  const asOperator = (options) => app.inject({ ...options, headers: { ...operator.headers } });
  assert.equal((await asOperator({ method: "GET", url: "/api/automations" })).statusCode, 200);
  assert.equal((await asOperator({ method: "POST", url: "/api/automations", payload: { event: "devis_emis", actions: [{ kind: "prevenir_direction", text: "x" }] } })).statusCode, 403);
  assert.equal((await asOperator({ method: "DELETE", url: "/api/automations/1" })).statusCode, 403);

  const preview = JSON.parse((await inject({ method: "POST", url: "/api/documents/preview", payload: ORDER })).body);
  const generated = await inject({ method: "POST", url: "/api/documents/generate", payload: { ...ORDER, userConfirmation: true, previewToken: preview.previewToken } });
  assert.equal(generated.statusCode, 201, generated.body);

  const state = () => inject({ method: "GET", url: "/api/automations" }).then((response) => JSON.parse(response.body));
  const first = await waitFor(async () => (await state()).runs.find((entry) => entry.rule === 1), "the purchase order rule ran");
  assert.equal(first.ok, true);
  assert.equal(first.text, "BC 164 (MADAME EXEMPLE, 18 000,00 DH) : à planifier.");
  assert.equal((await state()).queue.length, 1, "the payment reminder waits 30 days");
  const feed = JSON.parse((await inject({ method: "GET", url: "/api/team" })).body).activity;
  assert.ok(feed.some((entry) => entry.kind === "automatisation" && entry.agent === "production" && entry.text.startsWith("BC 164")));

  const step = await inject({ method: "PATCH", url: "/api/workshop/164/steps/approvisionnement", payload: { status: "bloquee", note: "panneaux MDF en rupture" } });
  assert.equal(step.statusCode, 200, step.body);
  const told = await waitFor(async () => (await state()).runs.find((entry) => entry.rule === 2), "the blocked step rule ran");
  assert.equal(told.text, "BC 164 (MADAME EXEMPLE) : Approvisionnement bloquée, panneaux MDF en rupture.");
  assert.match(told.detail, /WhatsApp n'est pas configuré/);

  await app.automation.tick(new Date(Date.now() + 31 * DAY));
  const reminder = (await state()).runs.find((entry) => entry.action === "tache_equipe");
  assert.equal(reminder.text, "Premier rappel de paiement à MADAME EXEMPLE.");
  assert.match(reminder.detail, /personne n'est reliée/);

  assert.equal((await inject({ method: "POST", url: "/api/automations/2/active", payload: { active: false } })).statusCode, 200);
  assert.equal((await inject({ method: "DELETE", url: "/api/automations/1" })).statusCode, 200);
  assert.deepEqual((await state()).rules.map((rule) => [rule.number, rule.active]), [[2, false]]);
});
