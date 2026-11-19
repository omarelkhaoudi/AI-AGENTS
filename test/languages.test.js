import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { DIRECTOR_LANGUAGE_RULE, TEAM_LANGUAGE_RULE, darijaAmountNote, darijaAmounts, taskWords } from "../src/agent/languages.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

const clock = () => new Date("2026-11-19T09:00:00Z");
const dirhams = (text) => darijaAmounts(text).map((amount) => amount.dirhams);

test("Darija amounts are read in dirhams: a « mlyoun » is 10 000 DH, never a million", () => {
  assert.deepEqual(dirhams("khlsat mlyoun l acompte"), [10_000]);
  assert.deepEqual(dirhams("khlsat mlyoun o nos"), [15_000]);
  assert.deepEqual(dirhams("3tani jouj mlayn"), [20_000]);
  assert.deepEqual(dirhams("bghit sarir b 2 mlyoun"), [20_000]);
  assert.deepEqual(dirhams("الكليان خلص مليون"), [10_000]);
  assert.deepEqual(dirhams("خلص ٢ مليون"), [20_000], "Arabic digits too");
  assert.deepEqual(dirhams("dkhel 100 alf ryal f la caisse"), [5_000]);
  assert.deepEqual(dirhams("20 alf centimes"), [200]);
  assert.deepEqual(dirhams("khass 400 ryal dyal lmousamir"), [20]);

  // Said in dirhams, or plain French: nothing to convert.
  assert.deepEqual(dirhams("khlsat 3 alf derham"), []);
  assert.deepEqual(dirhams("Mme Alami a payé 3 000 DH, malfaçon sur le lit 120"), []);
  assert.deepEqual(dirhams("50 centimes"), []);

  // A bare « 300 alf »: rials most of the time, but it is asked.
  const [bare] = darijaAmounts("khlesni 300 alf");
  assert.deepEqual([bare.dirhams, bare.doubtful], [15_000, true]);
  assert.match(darijaAmountNote("khlesni 300 alf"), /« 300 alf » = 15 000 DH si ce sont des rials .*300 000 DH si ce sont des dirhams : à demander/);
  assert.equal(darijaAmountNote("Fais le devis de Mme Alami"), "");
});

test("a task is taken or resolved in French or in Darija, in either script", () => {
  assert.deepEqual(taskWords("Tâche 4 prise en charge"), { number: "4", action: "prise_en_charge" });
  assert.deepEqual(taskWords("tâche 4 résolue : chevet remplacé"), { number: "4", action: "resolue" });
  assert.deepEqual(taskWords("mohima 4 salat"), { number: "4", action: "resolue" });
  assert.deepEqual(taskWords("tache 7 kmmelt, bdlt charnières"), { number: "7", action: "resolue" });
  assert.deepEqual(taskWords("ana 3liha, tache 7"), { number: "7", action: "prise_en_charge" });
  assert.deepEqual(taskWords("المهمة ٤ تقضات"), { number: "4", action: "resolue" });
  assert.deepEqual(taskWords("المهمة 4 أنا عليها"), { number: "4", action: "prise_en_charge" });
  assert.equal(taskWords("tache 3 ok"), null, "neither word: the message is a report");
  assert.equal(taskWords("salit lyoum"), null, "no task number");
});

test("the Director and every specialist are told to read Arabic and Darija, and what to confirm", async (t) => {
  for (const rule of [DIRECTOR_LANGUAGE_RULE, TEAM_LANGUAGE_RULE]) {
    assert.match(rule, /darija marocaine, en lettres arabes ou latines/);
    assert.match(rule, /« mlyoun » \/ « مليون » = 10 000 DH/);
    assert.match(rule, /documents .* restent toujours en français/);
  }
  assert.match(DIRECTOR_LANGUAGE_RULE, /Réponds à la direction dans sa langue/);
  assert.doesNotMatch(TEAM_LANGUAGE_RULE, /Réponds à la direction dans sa langue/);

  const calls = [];
  const agentClient = {
    responses: {
      async create(payload) {
        calls.push(payload);
        const delegated = payload.input.some((item) => item.type === "function_call_output");
        if (payload.instructions.startsWith("Tu es le Director IA") && !delegated) {
          return { output: [{ type: "function_call", name: "deleguer_a_un_agent", call_id: "d1", arguments: JSON.stringify({ agent: "finance", mission: "Entrée de caisse à confirmer" }) }] };
        }
        return { output_text: "Je comprends 10 000 DH, c'est bien ça ?", output: [] };
      }
    }
  };
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), agentClient, clock });
  t.after(() => app.close());

  const answer = await inject({ method: "POST", url: "/api/agent/chat", payload: { message: "Mme Alami khlsat mlyoun l acompte dyal devis 170" } });
  assert.equal(answer.statusCode, 200, answer.body);
  const director = calls.find((payload) => payload.instructions.startsWith("Tu es le Director IA"));
  assert.match(director.instructions, /Réponds à la direction dans sa langue/);
  assert.match(director.instructions, /Note du cockpit, montants en darija repérés dans ce message : « mlyoun » = 10 000 DH/);
  const finance = calls.find((payload) => payload.instructions.includes("Tu fais partie de l'équipe"));
  assert.match(finance.instructions, /Montants en darija/);
});
