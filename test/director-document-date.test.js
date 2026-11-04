import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";

// Hiba sometimes dates a purchase order on the day the order was taken, not on
// the day she types it. The date she gives is the one printed; without one the
// document carries today's date.
const isDirector = (payload) => payload.instructions.startsWith("Tu es le Director IA");
const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
const say = (text) => ({ output_text: text, output: [] });

const order = (date, id) => call("preparer_document", {
  type: "bon_de_commande", client_nom: "Client Exemple", client_adresse: "Marrakech", objet: "Lit superposé",
  lignes: [{ designation: "Lit superposé avec 2 matelas", quantite: 1, prix_unitaire: 14000, prix_ttc: true }],
  caracteristiques: [], conditions_paiement: "50/50", reference_devis: "", reference_bl: "", numero: "", photo: 0, date
}, id);

async function run(t, commercialTurns) {
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-agent-date-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const calls = [];
  const director = [
    call("deleguer_a_un_agent", { agent: "commercial", mission: "Bon de commande Client Exemple, Marrakech : lit superposé 14000 DH TTC, 50/50. Date du document : 08/08/2026." }, "d1"),
    say("Bon de commande prêt.")
  ];
  const agent = createDirectorAgent({
    client: { responses: { create: async (payload) => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      return isDirector(payload) ? director.shift() : commercialTurns.shift();
    } } },
    documentService: new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir }),
    toolRegistry: { list: () => [] },
    executeTool: async () => ({ ok: true, donnees: null }),
    clock: () => new Date("2026-11-04T10:00:00Z")
  });
  const result = await agent.chat({ message: "BC daté du 08/08/2026" });
  const commercial = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Commercial"));
  return { result, commercial };
}

test("the date the direction gives is the date printed on the document", async (t) => {
  const { result, commercial } = await run(t, [order("08/08/2026", "c1"), say("Bon de commande daté du 08/08/2026.")]);

  assert.equal(result.documents[0].preview.document.date, "08/08/2026");
  assert.match(commercial[1].input.at(-1).output, /"date":"08\/08\/2026"/, "the agent is told the date actually applied");
  assert.match(commercial[0].instructions, /champ date au format JJ\/MM\/AAAA/);
});

test("without a date the document carries today's", async (t) => {
  const { result } = await run(t, [order("", "c1"), say("Bon de commande prêt.")]);

  assert.equal(result.documents[0].preview.document.date, "04/11/2026");
});

test("a date that is not JJ/MM/AAAA is refused, never replaced by today's", async (t) => {
  const { result, commercial } = await run(t, [order("8 août 2026", "c1"), order("08/08/2026", "c2"), say("Corrigé.")]);

  assert.match(commercial[1].input.at(-1).output, /date/);
  assert.equal(result.documents.length, 1);
  assert.equal(result.documents[0].preview.document.date, "08/08/2026");
});
