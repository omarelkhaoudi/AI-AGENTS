import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { checkAnswer, createMemoryAgentConfig } from "../src/agent/agent-config.js";
import { SPECIALIST_IDS, runSpecialist } from "../src/agent/agent-team.js";
import { createMemoryCashBook } from "../src/agent/cash-book.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

const clock = () => new Date("2026-11-23T09:00:00Z");
const DEPOSIT = { sens: "entree", montant: 2700, categorie: "acompte_client", libelle: "Acompte 60 % lit cabane", moyen: "especes", tiers: "Client Exemple", reference_devis: "170", reference_bc: "", date: "", annonce_par: "Hiba", confirme_doublon: false };
const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });

test("an agent's tone, held tools and response tests are kept in its settings, and told to it", async () => {
  const config = createMemoryAgentConfig({ clock, agents: SPECIALIST_IDS });
  await assert.rejects(config.save("finance", { tone: "familier" }), { code: "AGENT_CONFIG_TONE_UNKNOWN" });
  const saved = await config.save("finance", { tone: "concis", heldTools: ["enregistrer_mouvement_caisse", "fixer_budget"], forbiddenTools: ["fixer_budget"] });
  assert.deepEqual([saved.tone, saved.heldTools, saved.forbiddenTools], ["concis", ["enregistrer_mouvement_caisse"], ["fixer_budget"]], "forbidden wins over held");
  const kept = await config.save("finance", { instructions: "Toujours donner le solde." });
  assert.deepEqual([kept.tone, kept.heldTools], ["concis", ["enregistrer_mouvement_caisse"]], "what is not given stays");

  const briefing = (await config.briefing("finance")).join("\n");
  assert.match(briefing, /Ton concis/);
  assert.match(briefing, /passent par la validation de la direction : enregistrer_mouvement_caisse/);

  await assert.rejects(config.addTest("finance", { question: "Solde ?" }), { code: "AGENT_TEST_CHECK_MISSING" });
  const added = await config.addTest("finance", { question: "Quel est le solde de caisse ?", expected: "solde ; DH", forbidden: ["je ne sais pas"] });
  assert.deepEqual([added.expected, added.forbidden], [["solde", "DH"], ["je ne sais pas"]]);
  await config.recordTestRun("finance", added.id, { passed: true, missing: [], found: [], answer: "Solde : 2 700 DH." });
  assert.equal((await config.settings("finance")).tests[0].lastRun.passed, true);
  await config.save("finance", { tone: "" });
  assert.equal((await config.settings("finance")).tests.length, 1, "saving the settings keeps the tests");
  await config.removeTest("finance", added.id);
  assert.equal((await config.settings("finance")).tests.length, 0);
});

test("a test answer is checked without accents or case", () => {
  assert.deepEqual(checkAnswer("La REMISE passe par la Direction.", { expected: ["remise", "direction"], forbidden: ["accordée"] }), { passed: true, missing: [], found: [] });
  assert.deepEqual(checkAnswer("Remise accordee tout de suite.", { expected: ["direction"], forbidden: ["accordée"] }), { passed: false, missing: ["direction"], found: ["accordée"] });
});

test("a held tool is kept for validation instead of running, and a test run writes nothing", async () => {
  const ran = [];
  const extraTools = [
    { tool: { type: "function", name: "enregistrer_mouvement_caisse", parameters: {} }, run: async (args) => (ran.push(["write", args]), { ok: true }) },
    { tool: { type: "function", name: "bilan_caisse", parameters: {} }, run: async () => (ran.push(["read"]), { ok: true, solde: 2700 }) }
  ];
  const script = () => {
    const turns = [call("bilan_caisse", {}, "r1"), call("enregistrer_mouvement_caisse", { montant: 100 }, "w1"), { output_text: "Fait.", output: [] }];
    const calls = [];
    return { calls, callModel: async (payload) => (calls.push(JSON.parse(JSON.stringify(payload))), turns.shift()) };
  };
  const outputsOf = (calls) => calls.at(-1).input.filter((item) => item.type === "function_call_output").map((item) => JSON.parse(item.output));

  const held = [];
  const first = script();
  await runSpecialist({ agentId: "finance", mission: "Note 100 DH.", model: "test", today: "23/11/2026", toolRegistry: { list: () => [] }, extraTools, heldTools: ["enregistrer_mouvement_caisse", "bilan_caisse"], holdCall: async (tool, args) => (held.push([tool, args]), { ok: true, en_attente: "n° 1" }), callModel: first.callModel });
  assert.deepEqual(held.map(([tool]) => tool), ["bilan_caisse", "enregistrer_mouvement_caisse"]);
  assert.deepEqual(ran, [], "nothing held runs");

  const second = script();
  await runSpecialist({ agentId: "finance", mission: "Note 100 DH.", model: "test", today: "23/11/2026", toolRegistry: { list: () => [] }, extraTools, dryRun: true, callModel: second.callModel });
  assert.deepEqual(ran, [["read"]], "a test reads but never writes");
  const [read, write] = outputsOf(second.calls);
  assert.equal(read.solde, 2700);
  assert.match(write.mode_test, /Mode test/);
});

test("the direction validates or refuses an agent's held action in the cockpit, and its tests run in test mode", async (t) => {
  const repository = new InMemoryRepository();
  const cashBook = createMemoryCashBook({ clock });
  const agentConfigStore = createMemoryAgentConfig({ clock, agents: SPECIALIST_IDS });
  // The model, played: the Director gives Finance the deposit; Finance
  // records it, which is held; in a test, Finance tries to record again.
  const client = { responses: { async create(payload) {
    const outputs = payload.input.filter((item) => item.type === "function_call_output");
    if (payload.instructions.startsWith("Tu es le Director IA")) {
      return outputs.length === 0 ? call("deleguer_a_un_agent", { agent: "finance", mission: "Noter l'acompte de 2 700 DH." }, "d1") : { output_text: "L'acompte attend votre validation.", output: [] };
    }
    return outputs.length === 0 ? call("enregistrer_mouvement_caisse", DEPOSIT, "f1") : { output_text: "Acompte de 2 700 DH : en attente de la validation de la direction.", output: [] };
  } } };
  const direction = await buildAuthenticatedApi({ repository, agentClient: client, cashBook, agentConfigStore, clock });
  t.after(() => direction.app.close());

  const tools = (await direction.inject({ method: "GET", url: "/api/agents/config" })).json().agents.find((agent) => agent.id === "finance").tools;
  assert.equal(tools.find((tool) => tool.name === "enregistrer_mouvement_caisse").holdable, true);
  assert.equal(tools.find((tool) => tool.name === "bilan_caisse").holdable, false, "a reading tool is never held");
  const saved = await direction.inject({ method: "PUT", url: "/api/agents/finance/config", payload: { tone: "formel", heldTools: ["enregistrer_mouvement_caisse", "bilan_caisse"] } });
  assert.deepEqual(saved.json().agent.heldTools, ["enregistrer_mouvement_caisse"]);
  assert.equal(saved.json().agent.tools.find((tool) => tool.name === "enregistrer_mouvement_caisse").held, true);

  const chat = await direction.inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Note l'acompte de 2 700 DH." } });
  assert.equal(chat.statusCode, 200, chat.body);
  assert.equal((await cashBook.entries()).length, 0, "held, not recorded");
  const [action] = (await direction.inject({ method: "GET", url: "/api/agents/held" })).json().held;
  assert.deepEqual([action.number, action.agent, action.tool, action.status, action.args.montant], [1, "finance", "enregistrer_mouvement_caisse", "en_attente", 2700]);
  const indicators = (await direction.inject({ method: "GET", url: "/api/agents/config" })).json().agents.find((agent) => agent.id === "finance").indicators;
  assert.deepEqual([indicators.missions, indicators.heldPending], [1, 1]);

  const operator = await buildAuthenticatedApi({ repository: new InMemoryRepository(), agentConfigStore, cashBook, clock, role: "operator" });
  t.after(() => operator.app.close());
  assert.equal((await operator.inject({ method: "GET", url: "/api/agents/held" })).statusCode, 403);
  assert.equal((await operator.inject({ method: "POST", url: "/api/agents/held/1/decision", payload: { decision: "valider" } })).statusCode, 403);

  const validated = (await direction.inject({ method: "POST", url: "/api/agents/held/1/decision", payload: { decision: "valider" } })).json().action;
  assert.equal(validated.status, "executee");
  assert.equal((await cashBook.entries()).length, 1, "validated, it runs");
  assert.equal((await direction.inject({ method: "POST", url: "/api/agents/held/1/decision", payload: { decision: "refuser" } })).statusCode, 409);

  const another = await agentConfigStore.holdAction("finance", { tool: "enregistrer_mouvement_caisse", args: { ...DEPOSIT, montant: 900 } });
  assert.equal((await direction.inject({ method: "POST", url: `/api/agents/held/${another.number}/decision`, payload: { decision: "refuser" } })).json().action.status, "refusee");
  assert.equal((await cashBook.entries()).length, 1, "refused, it never runs");

  const added = await direction.inject({ method: "POST", url: "/api/agents/finance/tests", payload: { question: "Un client verse 2 700 DH d'acompte.", expected: "validation", forbidden: "enregistré" } });
  assert.equal(added.statusCode, 200, added.body);
  const run = (await direction.inject({ method: "POST", url: "/api/agents/finance/tests/run", payload: {} })).json();
  assert.equal(run.results[0].lastRun.passed, true);
  assert.equal((await cashBook.entries()).length, 1, "a test writes nothing");
  assert.deepEqual(run.agent.indicators.tests, { total: 1, run: 1, passed: 1 });
});
