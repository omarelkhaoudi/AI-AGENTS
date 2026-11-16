import assert from "node:assert/strict";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createAiUsage, createAiUsageFromEnv, createMemoryAiUsageBook } from "../src/agent/ai-usage.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// CDC sections 11 and 14: the cost of the AI is followed and controlled. Each
// call to the model is counted for its agent; the cost is an estimate from the
// public price of the model; a monthly budget alerts at 80 % and 100 %.

const clock = () => new Date("2026-11-16T10:00:00Z");
// 1 000 000 tokens read, 400 000 of them cached, 200 000 written, on gpt-5:
// 0,6 × 1,25 + 0,4 × 0,125 + 0,2 × 10 = 2,80 $.
const USAGE = Object.freeze({ input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 400_000 }, output_tokens: 200_000 });

test("each call is counted for its agent and priced from the model's public price", async () => {
  const usage = createAiUsage({ clock, usdToMad: 10 });
  await usage.record({ agent: "director", model: "gpt-5", usage: USAGE });
  await usage.record({ agent: "commercial", model: "gpt-5-2025-08-07", usage: { input_tokens: 100_000, output_tokens: 10_000 } });
  await usage.record({ agent: "finance", model: "modele-inconnu", usage: { input_tokens: 5_000, output_tokens: 1_000 } });
  await usage.recordTranscription({ model: "gpt-4o-transcribe", usage: { type: "tokens", input_tokens: 10_000, input_token_details: { audio_tokens: 9_000 }, output_tokens: 1_000 } });
  await usage.record({ agent: "director", model: "gpt-5", usage: null });

  const month = await usage.summary();
  assert.equal(month.month, "2026-11");
  assert.equal(month.calls, 4, "a call with no usage reported is not counted");
  assert.deepEqual(month.byAgent.map((line) => [line.agent, line.calls, line.costUsd]), [["director", 1, 2.8], ["commercial", 1, 0.23], ["transcription", 1, 0.07], ["finance", 1, 0]]);
  assert.equal(month.costUsd, 3.09);
  assert.equal(month.costMad, 30.9, "in dirhams at the rate given");
  assert.equal(month.unpricedCalls, 1, "a model with no known price is counted, never priced by guess");
  assert.equal(month.projectedUsd, 5.79, "16 days elapsed of 30");
  assert.equal(month.budget, null);
  assert.equal((await usage.summary({ month: "2026-10" })).calls, 0);
});

test("a monthly budget alerts at 80 % and at 100 %, each once, and stops the Director only when asked", async () => {
  const alerts = [];
  const usage = createAiUsageFromEnv({ env: { HKIDS_AI_BUDGET_USD: "7", HKIDS_AI_BUDGET_STOP: "on", HKIDS_AI_PRICES: '{"modele-maison":[1,1,1]}' }, clock, onAlert: (alert) => alerts.push(alert) });
  await usage.record({ agent: "director", model: "gpt-5", usage: USAGE });
  assert.equal(alerts.length, 0, "2,80 $ of 7 $");
  assert.equal(await usage.overBudget(), false);
  await usage.record({ agent: "director", model: "gpt-5", usage: USAGE });
  assert.deepEqual(alerts.map((alert) => alert.level), [80], "5,60 $ of 7 $");
  assert.match(alerts[0].text, /consommé à 80 % : 5,60 \$ sur 7,00 \$/);
  await usage.record({ agent: "director", model: "modele-maison", usage: { input_tokens: 2_000_000, output_tokens: 0 } });
  assert.deepEqual(alerts.map((alert) => alert.level), [80, 100], "a price given in .env is used");
  assert.match(alerts[1].text, /Budget IA du mois atteint : 7,60 \$ dépensés sur 7,00 \$.*Le Director s'arrête/);
  await usage.record({ agent: "director", model: "gpt-5", usage: USAGE });
  assert.equal(alerts.length, 2, "each level is told once a month");
  assert.equal(await usage.overBudget(), true);
  assert.deepEqual((await usage.summary()).budget, { usd: 7, usedPercent: 149, remainingUsd: 0, reached: true, stops: true });

  const lenient = createAiUsage({ clock, budgetUsd: 1 });
  await lenient.record({ agent: "director", model: "gpt-5", usage: USAGE });
  assert.equal(await lenient.overBudget(), false, "without HKIDS_AI_BUDGET_STOP the Director keeps answering");
});

test("the Director and its agents are counted, answer what the AI cost, and stop at the budget when asked", async (t) => {
  const usage = createAiUsage({ clock, budgetUsd: 5, stopAtBudget: true });
  const calls = [];
  const scripts = {
    "Tu es le Director IA": [
      { usage: USAGE, output: [{ type: "function_call", name: "deleguer_a_un_agent", call_id: "d1", arguments: JSON.stringify({ agent: "commercial", mission: "Où en sont les devis ?" }) }] },
      { usage: { input_tokens: 2_000, output_tokens: 500 }, output: [{ type: "function_call", name: "couts_ia", call_id: "c1", arguments: JSON.stringify({ mois: "" }) }] },
      { usage: USAGE, output_text: "L'IA a coûté environ 3 $ ce mois.", output: [] }
    ],
    "Tu es l'agent Commercial": [{ usage: { input_tokens: 100_000, output_tokens: 10_000 }, output_text: "Aucun devis ouvert.", output: [] }]
  };
  const agent = createDirectorAgent({
    client: { responses: { create: async (payload) => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      return scripts[Object.keys(scripts).find((key) => payload.instructions.includes(key))].shift();
    } } },
    documentService: new HkidsDocumentService({ repository: new InMemoryRepository() }),
    toolRegistry: { list: () => [] },
    executeTool: async () => ({ ok: true, donnees: null }),
    aiUsage: usage,
    clock
  });

  await agent.chat({ message: "Combien coûte l'IA ce mois ?" });
  const told = JSON.parse(calls.at(-1).input.filter((item) => item.type === "function_call_output").at(-1).output);
  assert.equal(told.ok, true);
  assert.deepEqual(told.byAgent.map((line) => line.agent), ["director", "commercial"], "the Commercial's own call is counted for it");
  assert.equal(told.byAgent[1].costUsd, 0.23);
  assert.match(told.note, /la facture OpenAI fait foi/);

  const month = await usage.summary();
  assert.equal(month.byAgent[0].calls, 3);
  assert.ok(month.budget.reached);
  await assert.rejects(agent.chat({ message: "Bonjour" }), (error) => error.code === "AGENT_BUDGET_REACHED" && /budget IA du mois est atteint/.test(error.message));
  assert.equal(calls.length, 4, "no call is made to the model once the budget is reached");

  const { inject, app } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), aiUsage: usage, directorAgent: agent });
  t.after(() => app.close());
  const response = await inject({ method: "GET", url: "/api/ai-usage" });
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).costUsd, month.costUsd);
  const refused = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Bonjour" } });
  assert.equal(refused.statusCode, 503);
  assert.equal(JSON.parse(refused.body).details.code, "AGENT_BUDGET_REACHED");
});
