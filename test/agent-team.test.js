import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { SPECIALIST_IDS, readToolsFor } from "../src/agent/agent-team.js";
import { createMvpToolRegistry } from "../src/tools/mvp-tools.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// A stand-in for the model. Each request is answered by the first rule whose
// test matches it, so the Director and the agents it delegates to can be played
// in whatever order the server runs them, parallel calls included.
function modelPlaying(rules) {
  const calls = [];
  return {
    calls,
    responses: {
      async create(payload) {
        calls.push(JSON.parse(JSON.stringify(payload)));
        const rule = rules.find((candidate) => candidate.when(payload));
        assert.ok(rule, `no scripted answer for: ${payload.instructions.split("\n")[0]}`);
        return rule.then(payload);
      }
    }
  };
}

const isDirector = (payload) => payload.instructions.startsWith("Tu es le Director IA");
const isAgent = (name) => (payload) => payload.instructions.includes(`Tu es l'agent ${name}`);
const hasToolOutput = (payload) => payload.input.some((item) => item.type === "function_call_output");
const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
const say = (text) => ({ output_text: text, output: [] });

async function api(t, client) {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository, agentClient: client });
  t.after(() => app.close());
  return { inject, repository };
}

test("every specialised agent is offered exactly the read tools its role is granted", () => {
  const registry = createMvpToolRegistry({});
  const ids = (agent) => readToolsFor(agent, registry).map((tool) => tool.id).sort();

  assert.deepEqual(SPECIALIST_IDS, ["commercial", "finance", "production", "purchasing", "hr", "marketing", "community_manager", "after_sales", "legal"]);
  assert.ok(ids("finance").includes("get_pending_payments"));
  assert.ok(!ids("finance").includes("execute_invoice_payment"), "a payment is never a research step");
  assert.ok(!ids("commercial").includes("get_pending_payments"), "finance data stays with finance");
  assert.ok(ids("purchasing").includes("get_material_requirements"));
  for (const agent of SPECIALIST_IDS) {
    assert.ok(ids(agent).length > 0, agent);
  }
});

test("the Director delegates to Finance, which reads its own data through the checked tools", async (t) => {
  const client = modelPlaying([
    { when: (p) => isDirector(p) && !hasToolOutput(p), then: () => call("deleguer_a_un_agent", { agent: "finance", mission: "Qu'est-ce qu'on doit encaisser cette semaine ?" }, "d1") },
    { when: (p) => isAgent("Administration / Finance")(p) && !hasToolOutput(p), then: () => call("get_pending_payments", {}, "f1") },
    { when: isAgent("Administration / Finance"), then: () => say("À encaisser : Demo Client Atlas, 12000 MAD, en retard de 2 jours. Brouillon de relance : Bonjour Madame…") },
    { when: isDirector, then: () => say("Finance : 12000 MAD à encaisser, en retard. Relance prête.") }
  ]);
  const { inject, repository } = await api(t, client);

  const response = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Combien dois-je encaisser cette semaine ?" } });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(body.agentRuns.length, 1);
  assert.equal(body.agentRuns[0].agent, "finance");
  assert.deepEqual(body.agentRuns[0].tools, ["get_pending_payments"]);
  assert.match(body.reply, /12000 MAD/);

  // What the tool returned reached the agent: real data, not the model's guess.
  const financeTurn = client.calls.find((p) => isAgent("Administration / Finance")(p) && hasToolOutput(p));
  const toolOutput = JSON.parse(financeTurn.input.find((item) => item.type === "function_call_output").output);
  assert.equal(toolOutput.ok, true);
  assert.ok(JSON.stringify(toolOutput.donnees).includes("payment-atlas-deposit"));

  // And the read is in the audit trail, under the finance agent.
  const events = await repository.listAuditEvents();
  assert.ok(events.some((event) => event.type === "tool_completed" && event.agentId === "finance"));
});

test("a question on several trades is delegated to several agents at once", async (t) => {
  const client = modelPlaying([
    { when: (p) => isDirector(p) && !hasToolOutput(p), then: () => ({ output: [
      { type: "function_call", name: "deleguer_a_un_agent", call_id: "d1", arguments: JSON.stringify({ agent: "production", mission: "Quelles commandes risquent d'être en retard ?" }) },
      { type: "function_call", name: "deleguer_a_un_agent", call_id: "d2", arguments: JSON.stringify({ agent: "purchasing", mission: "Que faut-il commander ?" }) }
    ] }) },
    { when: isAgent("Production"), then: () => say("Commande Atlas en danger.") },
    { when: isAgent("Achats"), then: () => say("Commander 20 plaques d'aluminium.") },
    { when: isDirector, then: () => say("Production et achats : voir ci-dessous.") }
  ]);
  const { inject } = await api(t, client);

  const body = JSON.parse((await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Retards et achats ?" } })).body);
  assert.deepEqual(body.agentRuns.map((run) => run.agent).sort(), ["production", "purchasing"]);
});

test("an agent asking for a tool outside its role is refused, and told so", async (t) => {
  const client = modelPlaying([
    { when: (p) => isDirector(p) && !hasToolOutput(p), then: () => call("deleguer_a_un_agent", { agent: "commercial", mission: "Combien de créances ?" }, "d1") },
    { when: (p) => isAgent("Commercial")(p) && !hasToolOutput(p), then: () => call("get_pending_payments", {}, "c1") },
    { when: isAgent("Commercial"), then: () => say("Je n'ai pas accès aux paiements.") },
    { when: isDirector, then: () => say("La finance doit répondre.") }
  ]);
  const { inject } = await api(t, client);

  await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "créances ?" } });
  const commercialTurn = client.calls.find((p) => isAgent("Commercial")(p) && hasToolOutput(p));
  const refusal = JSON.parse(commercialTurn.input.find((item) => item.type === "function_call_output").output);
  assert.equal(refusal.ok, false);
  assert.match(refusal.erreur, /non autorisé/);
  assert.ok(!commercialTurn.tools.some((tool) => tool.name === "get_pending_payments"), "it was never offered either");
});
