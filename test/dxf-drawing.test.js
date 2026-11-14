import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { DesignOfficeError, createDesignOffice, runEngine } from "../src/agent/design-office.js";
import { createMemoryTeamBook } from "../src/agent/team-book.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { createMemoryWorkshopStore, createWorkshop } from "../src/agent/workshop-book.js";

// The dessinateur méthodes inside the Production agent: the engine (dessinateur/,
// Python) decomposes the furniture of an order and draws one DXF per panel,
// deposited on the order for the direction to validate. No DXF while a value is
// to confirm. Invented client and figures only.

const NOW = new Date("2026-11-14T09:00:00Z");
const clock = () => NOW;
const engineReady = await runEngine({ action: "profil_initial" }).then((answer) => answer.ok === true, () => false);
const skip = engineReady ? false : "moteur de dessin absent (pip install -r dessinateur/requirements.txt)";

async function documentsWith(t) {
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-dxf-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir });
  const client = { name: "Client Exemple", address: "Marrakech" };
  const quote = {
    documentType: "quote", documentNumber: "170", date: "02/11/2026", object: "Bibliothèque sur mesure", client,
    items: [{ designation: "Bibliothèque 80 x 110 x 30, MDF", unit: "U", quantity: 1, unitPriceHt: 2500, amountHt: 2500 }],
    totals: { totalHt: 2500, tva: 500, totalTtc: 3000 },
    payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
  };
  const order = { ...quote, documentType: "purchase_order", documentNumber: "171", date: "03/11/2026", payment: { termsRule: "hkids-po-50-50" }, quoteReference: "170" };
  for (const input of [quote, order]) {
    const preview = await documents.preview(input);
    await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true });
  }
  return documents;
}

function agentWith(documents, workshopStore, scripts, extra = {}) {
  const calls = [];
  const teamBook = createMemoryTeamBook({ clock, agents: SPECIALIST_IDS });
  const agent = createDirectorAgent({
    client: { responses: { create: async (payload) => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      const who = Object.keys(scripts).find((key) => payload.instructions.includes(key));
      return scripts[who].shift();
    } } },
    documentService: documents,
    workshopStore,
    teamBook,
    toolRegistry: { list: () => [] },
    executeTool: async () => ({ ok: true, donnees: null }),
    clock,
    ...extra
  });
  return { agent, calls, teamBook };
}
const call = (name, args, id) => ({ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) });
const turn = (...items) => ({ output: items });
const say = (text) => ({ output_text: text, output: [] });
const toProduction = (mission) => turn(call("deleguer_a_un_agent", { agent: "production", mission }, "d1"));

const BOOKCASE = { largeur: "800", hauteur: "1100", profondeur: "300", quantite: "1", nb_tablettes: "2", repartition: "egale", materiau_caisson: "mdf18", assemblage: "embrevement", fond: "rainure", materiau_fond: "hdf3", hauteur_socle: "60", retrait_socle: "20", chant_avant: "arrondi", nb_tablettes_reglables: "0", rainures: "traversantes" };
const parametres = Object.entries(BOOKCASE).map(([nom, valeur]) => ({ nom, valeur, source: "fourni" }));
const draw = (id) => call("dessiner_dxf", { numero: "171", meuble: "bibliotheque", parametres }, id);
const confirm = (reglage, valeurs, id) => call("profil_atelier", { action: "confirmer", reglage, valeurs }, id);
const outputsOf = (payload) => payload.input.filter((item) => item.type === "function_call_output").map((item) => JSON.parse(item.output));

test("Production draws the DXF of an order once the workshop values are confirmed, and the direction validates them", { skip }, async (t) => {
  const documents = await documentsWith(t);
  const workshopStore = createMemoryWorkshopStore({ clock });
  const { agent, calls, teamBook } = agentWith(documents, workshopStore, {
    "Tu es le Director IA": [toProduction("Fais le DXF de la bibliothèque du BC 171 : 800 x 1100 x 300, MDF 18…"), say("…"), toProduction("Le MDF 18 mesure 18,2, le HDF 3,1 ; les méthodes sont bonnes. Refais le DXF du BC 171."), say("…"), toProduction("L'étude technique est finie : refais le DXF du BC 171."), say("…")],
    "Tu es l'agent Production": [
      turn(draw("p1")),
      say("Il faut mesurer le MDF 18 et le HDF 3, et valider les méthodes."),
      turn(
        confirm("profil.materiau.mdf18", [{ cle: "ep_reelle", valeur: "18,2" }], "p2"),
        confirm("profil.materiau.hdf3", [{ cle: "ep_reelle", valeur: "3.1" }], "p3"),
        confirm("profil.assemblage.embrevement", [], "p4"),
        confirm("profil.assemblage.rainure_fond", [], "p5"),
        confirm("profil.usinage", [], "p6")
      ),
      turn(draw("p7")),
      say("Prêt, mais l'étude technique n'est pas terminée."),
      turn(draw("p8")),
      turn(draw("p9")),
      say("2 DXF déposés, à valider.")
    ]
  });

  await agent.chat({ message: "Fais le DXF du BC 171." });
  const first = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Production"));
  assert.ok(first[0].tools.some((tool) => tool.name === "dessiner_dxf") && first[0].tools.some((tool) => tool.name === "profil_atelier"));
  const [refused] = outputsOf(first[1]);
  assert.equal(refused.pret, false);
  assert.match(refused.dxf, /^aucun/);
  assert.ok(refused.questions.some((question) => question.id === "profil.materiau.mdf18"), "the thickness to measure is asked");
  assert.ok(refused.panneaux.every((sheet) => !("dxf_base64" in sheet)), "no file goes to the model");

  await agent.chat({ message: "Le MDF 18 mesure 18,2 et le HDF 3,1, les méthodes sont bonnes." });
  const second = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Production"));
  assert.ok(outputsOf(second[3]).every((answer) => answer.ok), "the five workshop values are recorded");
  const blocked = outputsOf(second[4]).at(-1);
  assert.equal(blocked.pret, true);
  assert.match(blocked.blocage, /étude technique/, "the technical sheet comes first");

  const workshop = createWorkshop({ store: workshopStore, documentService: documents, clock });
  await workshop.advance("171", "etude_technique", { status: "terminee" });
  await agent.chat({ message: "L'étude est finie, refais le DXF." });
  const third = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Production"));
  const deposited = outputsOf(third[6]).at(-1);
  assert.equal(deposited.dxf_deposes.length, 2, "one DXF per panel: the MDF carcass and the HDF back");
  assert.ok(deposited.dxf_deposes.every((name) => /^BC171_(mdf18|hdf3)_panneau1-1_[0-9a-f]{8}\.dxf$/.test(name)));
  assert.match(deposited.suite, /validation de la direction/);
  assert.deepEqual(outputsOf(third[7]).at(-1).deja_deposes, deposited.dxf_deposes, "the same design is not deposited twice");

  const order = await workshop.order("171");
  assert.equal(order.cnc.length, 2);
  assert.ok(order.cnc.every((file) => file.status === "a_valider" && file.format === "dxf" && file.by === "production"));
  assert.equal(order.steps.find((step) => step.id === "dessin_cnc").status, "en_cours");
  const file = await workshop.readCncFile("171", order.cnc[0].id);
  assert.match(file.bytes.toString("utf8", 0, 40), /SECTION/);
  assert.ok((await teamBook.activity({ agent: "production" })).some((entry) => entry.text.includes("2 DXF déposé(s), à valider")));

  // The direction validates them like the draughtsman's: then the cut can start.
  for (const entry of order.cnc) {
    await workshop.decideCncFile("171", entry.id, { approve: true });
  }
  await workshop.advance("171", "decoupe_cnc", { status: "en_cours" });
});

test("only Production draws: the other agents are not given the drawing tools", { skip }, async (t) => {
  const documents = await documentsWith(t);
  const { agent, calls } = agentWith(documents, createMemoryWorkshopStore({ clock }), {
    "Tu es le Director IA": [turn(call("deleguer_a_un_agent", { agent: "commercial", mission: "Fais le DXF du BC 171." }, "d1")), say("…")],
    "Tu es l'agent Commercial": [say("Ce n'est pas mon métier.")]
  });
  await agent.chat({ message: "DXF du 171" });
  const commercial = calls.find((payload) => payload.instructions.includes("Tu es l'agent Commercial"));
  assert.ok(!commercial.tools.some((tool) => ["dessiner_dxf", "profil_atelier"].includes(tool.name)));
  assert.ok(calls[0].instructions.includes("dessinateur méthodes"), "the Director knows where to send a drawing");
});

test("without the engine, the agent says it is not installed instead of failing", async (t) => {
  const missing = createDesignOffice({ engine: (request) => runEngine(request, { python: "python-introuvable-hkids" }) });
  await assert.rejects(missing.draw({ furniture: "bibliotheque" }), (error) => error instanceof DesignOfficeError && error.code === "DESIGN_ENGINE_UNAVAILABLE");

  const documents = await documentsWith(t);
  const { agent, calls } = agentWith(documents, createMemoryWorkshopStore({ clock }), {
    "Tu es le Director IA": [toProduction("Fais le DXF du BC 171."), say("…")],
    "Tu es l'agent Production": [turn(draw("p1"), call("dessiner_dxf", { numero: "999", meuble: "bibliotheque", parametres: [] }, "p2")), say("Le moteur n'est pas installé.")]
  }, { designOffice: missing });
  await agent.chat({ message: "DXF du 171" });
  const [noEngine, noOrder] = outputsOf(calls.filter((payload) => payload.instructions.includes("Tu es l'agent Production"))[1]);
  assert.equal(noEngine.ok, false);
  assert.match(noEngine.erreur, /pas installé/);
  assert.match(noOrder.erreur, /n° 999 n'est pas au carnet/);
});
