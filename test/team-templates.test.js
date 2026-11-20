import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { createMemoryAgentConfig } from "../src/agent/agent-config.js";
import { PLANS } from "../src/company/plans.js";
import { AGENT_REQUIRES, STARTER_MAX_AGENTS, TEAM_TEMPLATES, allowedAgents, changeTeam, defaultTeam, templateFromEnv } from "../src/agent/team-templates.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

// The library of agents (CDC section 10-E): a team per kind of company,
// opened by its plan, adjusted by its direction. Invented companies only.
const clock = () => new Date("2026-11-19T09:00:00Z");

test("every template is a coherent team: known agents, essentials within it and with what they work under", () => {
  for (const [id, template] of Object.entries(TEAM_TEMPLATES)) {
    assert.ok(template.agents.every((agent) => SPECIALIST_IDS.includes(agent)), id);
    assert.ok(template.essentials.every((agent) => template.agents.includes(agent)), id);
    assert.ok(template.essentials.length <= STARTER_MAX_AGENTS, id);
    for (const list of [template.agents, template.essentials]) {
      assert.ok(list.every((agent) => !AGENT_REQUIRES[agent] || list.includes(AGENT_REQUIRES[agent])), `${id} : un agent sans celui dont il dépend`);
    }
    assert.equal(id === "fabricant" ? template.trade === "" : /Pas d'atelier|pas d'atelier/.test(template.trade), true, id);
  }
  assert.equal(templateFromEnv({}), "fabricant", "H-KIDS keeps its own team");
  assert.equal(templateFromEnv({ HKIDS_TEAM_TEMPLATE: " Restaurant " }), "restaurant");
  assert.throws(() => templateFromEnv({ HKIDS_TEAM_TEMPLATE: "garage" }), { code: "TEAM_TEMPLATE_UNKNOWN" });
});

test("the plan opens the template's essentials, its whole team, or the whole library", () => {
  assert.deepEqual(defaultTeam("fabricant", null), [...SPECIALIST_IDS], "the pilot: everyone");
  assert.deepEqual(defaultTeam("restaurant", PLANS.starter), ["finance", "purchasing", "hr", "marketing"]);
  assert.deepEqual(defaultTeam("restaurant", PLANS.business), [...TEAM_TEMPLATES.restaurant.agents]);
  assert.equal(allowedAgents("restaurant", PLANS.business).includes("production"), false);
  assert.deepEqual(allowedAgents("restaurant", PLANS.enterprise), [...SPECIALIST_IDS]);

  const options = { templateId: "restaurant", plan: PLANS.business };
  assert.throws(() => changeTeam(["marketing", "community_manager"], "marketing", false, options), { code: "TEAM_AGENT_REQUIRED" });
  assert.throws(() => changeTeam(["finance"], "community_manager", true, options), { code: "TEAM_AGENT_REQUIRED" });
  assert.throws(() => changeTeam(["finance"], "production", true, options), { code: "TEAM_AGENT_NOT_IN_PLAN" });
  assert.throws(() => changeTeam(["finance"], "production", true, { templateId: "restaurant", plan: PLANS.starter }), /offre Starter/);
  assert.throws(() => changeTeam(["finance", "purchasing", "hr", "marketing", "commercial"], "legal", true, { templateId: "fabricant", plan: PLANS.starter }), { code: "TEAM_AGENT_NOT_IN_PLAN" });
  assert.throws(() => changeTeam(["commercial", "finance", "production", "hr"], "administration", true, { templateId: "fabricant", plan: PLANS.starter }), { code: "TEAM_FULL" });
  assert.deepEqual(changeTeam(["finance"], "legal", true, options), ["finance", "legal"]);
  assert.throws(() => changeTeam([], "inconnu", true, options), { code: "AGENT_UNKNOWN" });
});

test("the team is kept, and what a plan no longer opens leaves it", async () => {
  const config = createMemoryAgentConfig({ clock, agents: SPECIALIST_IDS, templateId: "restaurant", plan: PLANS.business });
  await config.setActive("legal", false, { by: "sara" });
  assert.equal(await config.isActive("legal"), false);
  await assert.rejects(config.setActive("production", true), { name: "AgentConfigError", code: "TEAM_AGENT_NOT_IN_PLAN" });
  assert.equal((await config.team()).includes("community_manager"), true);
});

// The model, played: the Director of a restaurant delegates to Production,
// which is not in its team, then to Finance, which is.
function modelPlaying() {
  const calls = [];
  return {
    calls,
    responses: {
      async create(payload) {
        calls.push(JSON.parse(JSON.stringify(payload)));
        const outputs = payload.input.filter((item) => item.type === "function_call_output");
        const call = (agent, id) => ({ output: [{ type: "function_call", name: "deleguer_a_un_agent", call_id: id, arguments: JSON.stringify({ agent, mission: "Point sur la semaine." }) }] });
        if (payload.instructions.startsWith("Tu es le Director IA")) {
          return outputs.length === 0 ? call("production", "d1") : outputs.length === 1 ? call("finance", "d2") : { output_text: "Voici le point.", output: [] };
        }
        return { output_text: "Caisse du jour équilibrée.", output: [] };
      }
    }
  };
}

test("an agent outside the team gets no mission, and the Director knows its team and trade", async (t) => {
  const repository = new InMemoryRepository();
  const client = modelPlaying();
  const { app, inject } = await buildAuthenticatedApi({ repository, agentClient: client, clock, subscription: PLANS.starter, teamTemplate: "restaurant" });
  t.after(() => app.close());

  const answer = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Point sur la semaine." } });
  assert.equal(answer.statusCode, 200, answer.body);
  const director = client.calls.find((payload) => payload.instructions.startsWith("Tu es le Director IA"));
  assert.match(director.instructions, /Ton équipe dans cette entreprise : finance/);
  assert.match(director.instructions, /restaurant/);
  assert.equal(client.calls.some((payload) => payload.instructions.includes("Tu es l'agent Production")), false, "Production is never called");
  const outputs = client.calls.at(-1).input.filter((item) => item.type === "function_call_output").map((item) => item.output).join("\n");
  assert.match(outputs, /n'est pas dans l'équipe de cette entreprise/);
  const finance = client.calls.find((payload) => payload.instructions.includes("Tu es l'agent Administration / Finance"));
  assert.ok(finance, "Finance works");
  assert.match(finance.instructions, /Activité de l'entreprise : L'entreprise est un restaurant/);
});

test("the direction turns agents on and off in « Équipe IA », within its plan", async (t) => {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository, clock, subscription: PLANS.business, teamTemplate: "restaurant" });
  t.after(() => app.close());

  const { team, agents } = JSON.parse((await inject({ method: "GET", url: "/api/agents/config" })).body);
  assert.deepEqual([team.template, team.plan.id, team.max], ["restaurant", "business", null]);
  assert.equal(team.templateLabel, "Restaurant / traiteur");
  assert.equal(agents.find((agent) => agent.id === "production").active, false);
  assert.equal(agents.find((agent) => agent.id === "community_manager").requires, "marketing");

  const refused = await inject({ method: "POST", url: "/api/agents/production/active", payload: { active: true } });
  assert.equal(refused.statusCode, 400);
  assert.equal(JSON.parse(refused.body).details.code, "TEAM_AGENT_NOT_IN_PLAN");
  assert.equal(JSON.parse((await inject({ method: "POST", url: "/api/agents/marketing/active", payload: { active: false } })).body).details.code, "TEAM_AGENT_REQUIRED");
  assert.equal((await inject({ method: "POST", url: "/api/agents/marketing/active", payload: { active: "non" } })).statusCode, 400);

  const off = await inject({ method: "POST", url: "/api/agents/community_manager/active", payload: { active: false } });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(JSON.parse(off.body).team.active.includes("community_manager"), false);
  assert.equal((await inject({ method: "POST", url: "/api/agents/community_manager/active", payload: { active: true } })).statusCode, 200);

  const feed = JSON.parse((await inject({ method: "GET", url: "/api/team" })).body).activity.map((entry) => entry.text);
  assert.ok(feed.some((line) => /retiré de l'équipe/.test(line)));

  const operator = await createAuthenticatedUser(repository, { id: "karim", role: "operator" });
  assert.equal((await app.inject({ method: "POST", url: "/api/agents/legal/active", payload: { active: false }, headers: operator.headers })).statusCode, 403);
});

test("H-KIDS, the pilot, keeps its whole team", async (t) => {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository, clock, subscription: null });
  t.after(() => app.close());
  const { team } = JSON.parse((await inject({ method: "GET", url: "/api/agents/config" })).body);
  assert.deepEqual([team.template, team.plan, team.active.length], ["fabricant", null, SPECIALIST_IDS.length]);
});
