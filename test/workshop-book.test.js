import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { WORKSHOP_STEP_IDS, buildWorkshopBook, createFileWorkshopStore, createMemoryWorkshopStore, createWorkshop } from "../src/agent/workshop-book.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// The workshop book: each purchase order validated in the cockpit follows the
// eight steps of the manufacturing route, from the technical study to delivery
// and installation. Its progress counts the steps actually finished. Invented
// clients and figures only.

const NOW = new Date("2026-11-06T09:00:00Z");
const clock = () => NOW;

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "hkids-workshop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const client = { name: "Client Exemple", address: "Marrakech" };
const quote = {
  documentType: "quote",
  documentNumber: "170",
  date: "02/11/2026",
  object: "Lit cabane",
  client,
  items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: 3750, amountHt: 3750 }],
  totals: { totalHt: 3750, tva: 750, totalTtc: 4500 },
  payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
};
const order = (number, overrides = {}) => ({
  ...quote,
  documentType: "purchase_order",
  documentNumber: number,
  date: "03/11/2026",
  payment: { termsRule: "hkids-po-50-50" },
  specifications: ["Bois clair"],
  quoteReference: "170",
  ...overrides
});

async function issue(documents, input) {
  const preview = await documents.preview(input);
  await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true });
}

// The technical sheet done and the draughtsman's G-code validated: what the
// CNC cut waits for.
const GCODE = Buffer.from("%\nG21 G90\nG0 X0 Y0\nG1 X100 Y0 F1200\nM30\n%\n");
async function drawingValidated(store, number, by = "direction") {
  await store.updateStep(number, "etude_technique", { status: "terminee", by });
  const id = await store.addCncFile(number, { bytes: GCODE, name: `panneaux-${number}.nc`, format: "gcode", by });
  await store.decideCncFile(number, id, { approve: true, by });
}

async function documentsWith(t, ...inputs) {
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: await tempDir(t) });
  for (const input of inputs) {
    await issue(documents, input);
  }
  return documents;
}

test("a step moves with its dates, its person in charge and a journal line", async () => {
  const store = createMemoryWorkshopStore({ clock });

  await store.updateStep("171", "etude_technique", { status: "en_cours", responsible: "Youssef", plannedDate: "10/11/2026", by: "director" });
  const { order: record } = await store.updateStep("171", "etude_technique", { status: "terminee", by: "hiba" });

  const step = record.steps.etude_technique;
  assert.equal(step.status, "terminee");
  assert.equal(step.startedDate, "2026-11-06");
  assert.equal(step.doneDate, "2026-11-06", "finished today when no date is given");
  assert.equal(step.plannedDate, "2026-11-10");
  assert.equal(step.responsible, "Youssef");
  assert.deepEqual(record.journal.map((entry) => [entry.by, entry.text]), [
    ["director", "Étude technique : à faire → en cours ; responsable : Youssef ; prévue le 10/11/2026."],
    ["hiba", "Étude technique : en cours → terminée."]
  ]);

  const same = await store.updateStep("171", "etude_technique", { status: "terminee" });
  assert.equal(same.changed, false, "saying it again records nothing");
});

test("a step is refused when it is unknown, blocked without a reason, or dated illegibly", async () => {
  const store = createMemoryWorkshopStore({ clock });
  await assert.rejects(store.updateStep("171", "vernissage", { status: "en_cours" }), { code: "WORKSHOP_STEP_UNKNOWN" });
  await assert.rejects(store.updateStep("171", "assemblage", { status: "fini" }), { code: "WORKSHOP_STATUS_UNKNOWN" });
  await assert.rejects(store.updateStep("171", "assemblage", { status: "bloquee" }), { code: "WORKSHOP_BLOCK_REASON_MISSING" });
  await assert.rejects(store.updateStep("171", "assemblage", { plannedDate: "31/02/2026" }), { code: "WORKSHOP_DATE_INVALID" });
  assert.deepEqual(await store.all(), {}, "nothing refused is written");
});

test("an unblocked step drops the reason it was blocked for", async () => {
  const store = createMemoryWorkshopStore({ clock });
  await store.updateStep("171", "finition", { status: "bloquee", note: "Laque en rupture" });
  const { order: record } = await store.updateStep("171", "finition", { status: "en_cours" });
  assert.equal(record.steps.finition.note, "");
});

test("the book survives a restart", async (t) => {
  const path = join(await tempDir(t), "atelier.json");
  await createFileWorkshopStore({ path, clock }).updateStep("171", "assemblage", { status: "en_cours" });
  const reopened = await createFileWorkshopStore({ path, clock }).all();
  assert.equal(reopened["171"].steps.assemblage.status, "en_cours");
});

test("progress counts the finished steps, and blocked or late steps raise an alert", async (t) => {
  const documents = await documentsWith(t, quote, order("171"), order("172", { quoteReference: "" }));
  const store = createMemoryWorkshopStore({ clock });
  await drawingValidated(store, "171");
  await store.updateStep("171", "approvisionnement", { status: "terminee" });
  await store.updateStep("171", "decoupe_cnc", { status: "en_cours", plannedDate: "05/11/2026" });
  await store.updateStep("171", "assemblage", { status: "bloquee", note: "Charnières en rupture" });

  const book = buildWorkshopBook(await documents.listIssued(), await store.all(), NOW);

  const [first, second] = book;
  assert.equal(first.number, "172", "the latest order first");
  assert.equal(second.number, "171");
  assert.deepEqual(second.progress, { done: 3, total: 8, percent: 38 });
  assert.equal(second.currentStep, "Découpe CNC");
  assert.equal(second.status, "bloquée");
  assert.deepEqual(second.alerts, ["Découpe CNC prévue le 05/11/2026, pas terminée", "Assemblage bloquée : Charnières en rupture"]);
  assert.equal(second.quoteNumber, "170");
  assert.equal(second.client, "Client Exemple");
  assert.equal(second.object, "Lit cabane");
  assert.equal(first.status, "à lancer");
  assert.deepEqual(first.progress, { done: 0, total: 8, percent: 0 });
});

test("an installed order whose sale is not fully invoiced is flagged, and only then", async (t) => {
  const documents = await documentsWith(t, quote, order("171"), order("172", { quoteReference: "" }));
  const store = createMemoryWorkshopStore({ clock });
  for (const number of ["171", "172"]) {
    await drawingValidated(store, number);
    for (const step of WORKSHOP_STEP_IDS) {
      await store.updateStep(number, step, { status: "terminee" });
    }
  }

  const book = buildWorkshopBook(await documents.listIssued(), await store.all(), NOW);

  const fromQuote = book.find((entry) => entry.number === "171");
  assert.equal(fromQuote.status, "livrée et installée");
  assert.deepEqual(fromQuote.progress, { done: 8, total: 8, percent: 100 });
  assert.deepEqual(fromQuote.alerts, ["Installée, reste à facturer 4500 DH"]);
  assert.deepEqual(book.find((entry) => entry.number === "172").alerts, [], "an order with no quote cannot be matched to its invoices");
});

test("only an order the cockpit issued can be moved", async (t) => {
  const documents = await documentsWith(t, quote, order("171"));
  const workshop = createWorkshop({ store: createMemoryWorkshopStore({ clock }), documentService: documents, clock });

  await assert.rejects(workshop.advance("999", "assemblage", { status: "en_cours" }), { code: "WORKSHOP_ORDER_NOT_FOUND" });
  const { order: moved } = await workshop.advance("171", "assemblage", { status: "en_cours" });
  assert.equal(moved.status, "en cours");
});

test("the cockpit reads the book and moves a step, and the journal names who did", async (t) => {
  const documents = await documentsWith(t, quote, order("171"));
  const { app, inject } = await buildAuthenticatedApi({
    repository: new InMemoryRepository(),
    documentService: documents,
    workshopStore: createMemoryWorkshopStore({ clock })
  });
  t.after(() => app.close());

  const moved = await inject({ method: "PATCH", url: "/api/workshop/171/steps/etude_technique", payload: { status: "terminee" } });
  assert.equal(moved.statusCode, 200);
  assert.equal(JSON.parse(moved.body).order.progress.done, 1);

  const { orders } = JSON.parse((await inject({ method: "GET", url: "/api/workshop" })).body);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].steps[0].status, "terminee");
  assert.ok(orders[0].journal[0].by, "the journal says who moved the step");

  assert.equal((await inject({ method: "PATCH", url: "/api/workshop/999/steps/assemblage", payload: { status: "en_cours" } })).statusCode, 404);
  assert.equal((await inject({ method: "PATCH", url: "/api/workshop/171/steps/assemblage", payload: { status: "bloquee" } })).statusCode, 400);
});

// The agents, with the model's answers written in advance.
function agentWith(documents, workshopStore, scripts) {
  const calls = [];
  const agent = createDirectorAgent({
    client: { responses: { create: async (payload) => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      const who = Object.keys(scripts).find((key) => payload.instructions.includes(key));
      return scripts[who].shift();
    } } },
    documentService: documents,
    workshopStore,
    toolRegistry: { list: () => [] },
    executeTool: async () => ({ ok: true, donnees: null }),
    clock
  });
  return { agent, calls };
}
const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
// Several calls in one answer, as the model makes them when they do not depend on each other.
const together = (...entries) => ({ output: entries.map(([name, args, id]) => ({ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) })) });
const say = (text) => ({ output_text: text, output: [] });
const step = (etape, statut, extra = {}) => ({ numero: "171", etape, statut, responsable: "", date_prevue: "", date_reelle: "", note: "", ...extra });

test("told that an order moved, the Director records it in the book and reports the real progress", async (t) => {
  const documents = await documentsWith(t, quote, order("171"));
  const workshopStore = createMemoryWorkshopStore({ clock });
  await drawingValidated(workshopStore, "171", "director");
  const { agent, calls } = agentWith(documents, workshopStore, {
    "Tu es le Director IA": [
      together(
        ["avancer_commande", step("etude_technique", "terminee"), "a1"],
        ["avancer_commande", step("approvisionnement", "terminee"), "a2"],
        ["avancer_commande", step("decoupe_cnc", "en_cours", { responsable: "Youssef", date_prevue: "12/11/2026" }), "a3"]
      ),
      say("BC 171 : découpe en cours, 3/8 étapes terminées.")
    ]
  });

  await agent.chat({ message: "Le BC 171 est en découpe chez Youssef, prévue pour le 12/11" });

  const director = calls.filter((payload) => payload.instructions.startsWith("Tu es le Director IA"));
  assert.ok(director[0].tools.some((tool) => tool.name === "carnet_atelier"));
  const outputs = director[1].input.filter((item) => item.type === "function_call_output").map((item) => JSON.parse(item.output));
  assert.ok(outputs.every((output) => output.ok));
  const book = await createWorkshop({ store: workshopStore, documentService: documents, clock }).order("171");
  assert.deepEqual(book.progress, { done: 3, total: 8, percent: 38 });
  assert.equal(book.steps[3].responsible, "Youssef");
  assert.equal(book.steps[3].plannedDate, "2026-11-12");
  assert.ok(book.journal.every((entry) => entry.by === "director"));
});

test("Production reads the book and the orders and moves a step; Commercial only reads the book", async (t) => {
  const documents = await documentsWith(t, quote, order("171"));
  const workshopStore = createMemoryWorkshopStore({ clock });
  const { agent, calls } = agentWith(documents, workshopStore, {
    "Tu es le Director IA": [
      together(
        ["deleguer_a_un_agent", { agent: "production", mission: "L'atelier signale que l'assemblage du BC 171 est bloqué : charnières en rupture." }, "d1"],
        ["deleguer_a_un_agent", { agent: "commercial", mission: "Où en est la fabrication du BC 171 ?" }, "d2"]
      ),
      say("Assemblage du BC 171 bloqué.")
    ],
    "Tu es l'agent Production": [
      call("carnet_atelier", { numero: "171" }, "p1"),
      call("avancer_commande", step("assemblage", "bloquee", { note: "Charnières en rupture" }), "p2"),
      say("Assemblage bloqué enregistré.")
    ],
    "Tu es l'agent Commercial": [
      call("avancer_commande", step("assemblage", "terminee"), "c1"),
      say("Je ne peux pas modifier le carnet.")
    ]
  });

  await agent.chat({ message: "L'assemblage du 171 est bloqué, il manque les charnières. Et le commercial, il en est où ?" });

  const production = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Production"));
  const tools = production[0].tools.map((tool) => tool.name);
  assert.ok(tools.includes("carnet_atelier") && tools.includes("avancer_commande"));
  assert.deepEqual(production[0].tools.find((tool) => tool.name === "consulter_document").parameters.properties.type.enum, ["bon_de_commande"]);
  assert.ok(!tools.includes("preparer_document"), "Production prepares no document");
  const read = JSON.parse(production[1].input.at(-1).output);
  assert.equal(read.bc, "171");
  assert.equal(read.etapes.length, 8);

  const commercial = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Commercial"));
  const commercialTools = commercial[0].tools.map((tool) => tool.name);
  assert.ok(commercialTools.includes("carnet_atelier"));
  assert.ok(!commercialTools.includes("avancer_commande"));
  assert.equal(JSON.parse(commercial[1].input.at(-1).output).ok, false, "the Commercial cannot move a step");

  const book = await createWorkshop({ store: workshopStore, documentService: documents, clock }).order("171");
  assert.equal(book.steps[4].status, "bloquee");
  assert.equal(book.journal.at(-1).by, "production");
});
