import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { DesignOfficeError, createDesignOffice, runEngine } from "../src/agent/design-office.js";
import { createFileWorkshopStore, createWorkshop } from "../src/agent/workshop-book.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

const clock = () => new Date("2026-11-16T10:00:00Z");
const DXF = "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n";
const sheet = () => ({ title: "Meuble exemple de test", units: "mm", parts: [
  { ref: "P01", name: "Côté CNC", length: 300, width: 200, thickness: 18.2, quantity: 2, material: "MDF mesuré 18,2 mm", materialId: "mdf18", confirmed: true, grain: false, contour: { shape: "rectangle" },
    features: [{ kind: "percage", x: 30, y: 30, diameter: 5, depth: 10 }], operations: [{ type: "cnc", machine: "CNC atelier de test", instructions: "Percer puis détourer selon DXF validés." }, { type: "autre", machine: "Poste assemblage", instructions: "Assembler les deux côtés selon la fiche." }] },
  { ref: "P02", name: "Tablette scie", length: 600, width: 250, thickness: 18, quantity: 3, material: "Panneau mélaminé", confirmed: true, grain: true, stock: { length: 2440, width: 1220, margin: 10, kerf: 3.2 }, operations: [{ type: "sciage_panneaux", machine: "Scie à panneaux atelier", instructions: "Débiter suivant le calepinage, respecter le décor." }] },
  { ref: "P03", name: "Tasseau fourni brut", length: 700, width: 35, thickness: 25, quantity: 1, material: "Hêtre fourni pour cette pièce", confirmed: true, rough: { length: 710, width: 40, thickness: 30 }, operations: [{ type: "rabotage", machine: "Raboteuse atelier", instructions: "Rabotage à 25 mm, contrôler au pied à coulisse." }] }
] });

async function fixture(t, designOffice = createDesignOffice({ clock })) {
  const dir = await mkdtemp(join(tmpdir(), "hkids-methodes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: join(dir, "documents") });
  const order = { documentType: "purchase_order", documentNumber: "171", date: "16/11/2026", object: "Meuble de test", client: { name: "Client Exemple", address: "Marrakech" }, items: [{ designation: "Meuble exemple", quantity: 1, unit: "U", unitPriceHt: 1000, amountHt: 1000 }], totals: { totalHt: 1000, tva: 200, totalTtc: 1200 }, payment: { termsRule: "hkids-po-50-50" } };
  const preview = await documents.preview(order);
  await documents.generate({ ...order, previewToken: preview.previewToken, userConfirmation: true });
  const path = join(dir, "atelier.json");
  const store = createFileWorkshopStore({ path, clock });
  const workshop = createWorkshop({ store, documentService: documents, clock });
  let active;
  const payloads = [];
  const client = { responses: { create: async (payload) => {
    payloads.push(structuredClone(payload));
    const who = payload.instructions.startsWith("Tu es le Director IA") ? "director" : payload.instructions.includes("Tu es l'agent Production.") ? "production" : "draft";
    active.count[who] = (active.count[who] ?? 0) + 1;
    if (active.count[who] > 1) return { output_text: "Livrables et blocages transmis.", output: [] };
    const call = (name, args, i = 0) => ({ type: "function_call", call_id: `${who}-${payloads.length}-${i}`, name, arguments: JSON.stringify(args) });
    return { output: who === "director" ? [call("deleguer_a_un_agent", { agent: "production", mission: "Dossier du BC 171" })] : who === "production" ? [call("deleguer_bureau_etudes", { agent: active.role, mission: "BC 171 : reprendre la fiche fournie." })] : active.calls.map(([name, args], i) => call(name, args, i)) };
  } } };
  const agent = createDirectorAgent({ client, documentService: documents, workshopStore: store, designOffice, clock, toolRegistry: { list: () => [] }, executeTool: async () => ({ ok: true }) });
  async function run(calls, role = "dessinateur_methodes") {
    active = { calls, role, count: {} };
    const start = payloads.length;
    const result = await agent.chat({ message: "Préparer la commande 171." });
    const turns = payloads.slice(start);
    const outputs = turns.find((p) => p.instructions.includes(role === "dessinateur_methodes" ? "Tu es l'agent Dessinateur méthodes" : "Tu es l'agent Dessinateur 2D/3D") && p.input.some((i) => i.type === "function_call_output"));
    return { result, turns, outputs: outputs?.input.filter((i) => i.type === "function_call_output").map((i) => JSON.parse(i.output)) ?? [] };
  }
  async function validate(data = sheet()) {
    const result = await workshop.saveTechnicalSheet("171", data);
    assert.equal(result.ok, true, JSON.stringify(result.questions));
    await workshop.decideTechnicalSheet("171", result.sheet.id, { approve: true, by: "Direction test" });
    return workshop.prepareFabrication("171");
  }
  return { dir, path, store, workshop, documents, designOffice, run, validate };
}

test("Production coordinates two distinct drafting agents, with separate tools and human approvals", async (t) => {
  const f = await fixture(t);
  const draft = await f.run([["preparer_fiche_technique", { numero: "171", fiche: JSON.stringify(sheet()) }]], "dessinateur_2d3d");
  assert.equal(draft.outputs[0].ok, true);
  assert.deepEqual(draft.result.agentRuns.map((r) => r.agent), ["dessinateur_2d3d", "production"]);
  const production = draft.turns.find((p) => p.instructions.includes("Tu es l'agent Production."));
  assert.ok(production.tools.some((x) => x.name === "deleguer_bureau_etudes"));
  assert.ok(!production.tools.some((x) => ["dessiner_dxf", "preparer_gcode"].includes(x.name)));
  const drafter = draft.turns.find((p) => p.instructions.includes("Tu es l'agent Dessinateur 2D/3D"));
  assert.ok(!drafter.tools.some((x) => /gcode|dxf|valider/.test(x.name)));
  const methods = await f.run([["preparer_dossier_fabrication", { numero: "171" }]]);
  assert.equal(methods.outputs[0].code, "WORKSHOP_TECHNICAL_SHEET_NOT_VALIDATED");
});

test("missing information returns questions before saving files", async (t) => {
  const f = await fixture(t);
  const data = sheet(); delete data.parts[0].thickness; data.parts[1].confirmed = false;
  const result = await f.workshop.saveTechnicalSheet("171", data);
  assert.equal(result.ok, false);
  assert.match(result.questions.join(" "), /épaisseur|confirmer/);
  assert.deepEqual((await f.workshop.order("171")).technicalSheets, []);
  for (const invalid of [null, {}, { ...sheet(), parts: [null] }, { ...sheet(), parts: [{ ...sheet().parts[0], operations: {} }] }]) assert.equal((await f.workshop.saveTechnicalSheet("171", invalid)).ok, false);
});

test("actual routes, operation sheets and nesting are versioned and survive restart", async (t) => {
  const f = await fixture(t);
  const dossier = await f.validate();
  assert.deepEqual(dossier.operations.map((o) => [o.part, o.type, o.sequence]), [["P01", "cnc", 1], ["P01", "autre", 2], ["P02", "sciage_panneaux", 1], ["P03", "rabotage", 1]]);
  assert.equal((await f.workshop.prepareFabrication("171")).id, dossier.id);
  for (const op of dossier.operations) assert.equal(op.technicalSheetId, dossier.technicalSheetId);
  const reopened = createWorkshop({ store: createFileWorkshopStore({ path: f.path, clock }), documentService: f.documents, clock });
  const file = dossier.files.find((x) => x.name.endsWith("OP001-1.html"));
  const stored = await reopened.readManufacturingFile("171", file.id);
  assert.match(stored.bytes.toString(), /CNC atelier de test/);
  assert.deepEqual(await readFile(join(f.dir, "commandes", file.file)), stored.bytes);
  const nest = JSON.parse((await reopened.readManufacturingFile("171", dossier.files.find((x) => x.name.endsWith("calepinage-scie.json")).id)).bytes.toString());
  assert.deepEqual(nest[0].sheets[0].placements.map((p) => p.ref), ["P02", "P02", "P02"]);
  const updated = sheet(); updated.parts = [updated.parts[1]]; await f.validate(updated);
  const current = await f.workshop.order("171");
  assert.equal(current.technicalSheets.length, 2);
  assert.ok(current.steps.every((s) => !["dessin_cnc", "decoupe_cnc"].includes(s.id)));
  assert.deepEqual(current.fabricationDossiers.at(-1).operations.map((o) => o.type), ["sciage_panneaux"]);
});

test("G-code generation waits for every current DXF; geometry changes and corrections require new approval", async (t) => {
  let generated = 0;
  const office = { draw: async () => ({ ok: true, pret: true, empreinte: "drawing-hash", pieces: [], panneaux: [1, 2].map((numero) => ({ matiere: "mdf18", numero, sur: 2, dxf_base64: Buffer.from(DXF).toString("base64") })) }), gcode: async () => { generated++; return { ok: true, pret: false, raisons: ["CNC non renseignée."] }; } };
  const f = await fixture(t, office); await f.validate();
  const args = { numero: "171", meuble: "pieces_libres", parametres: [] };
  assert.equal((await f.run([["preparer_gcode", args]])).outputs[0].code, "WORKSHOP_DXF_NOT_VALIDATED");
  assert.equal(generated, 0);
  assert.equal((await f.run([["dessiner_dxf", args]])).outputs[0].dxf_deposes.length, 2);
  await f.run([["preparer_gcode", args]]); assert.equal(generated, 0);
  await f.workshop.decideCncFile("171", (await f.workshop.order("171")).cnc[0].id, { approve: true });
  await f.run([["preparer_gcode", args]]); assert.equal(generated, 0, "one approved panel cannot authorise the remaining panel");
  await f.workshop.decideCncFile("171", (await f.workshop.order("171")).cnc[1].id, { approve: true });
  await f.run([["preparer_gcode", args]]); assert.equal(generated, 1);
  office.draw = async () => ({ ok: true, pret: true, empreinte: "changed-hash", panneaux: [] });
  await f.run([["preparer_gcode", args]]); assert.equal(generated, 1);
  const corrected = sheet(); corrected.parts[0].length = 310; await f.workshop.saveTechnicalSheet("171", corrected);
  assert.equal((await f.workshop.order("171")).cnc[0].obsolete, true);
  await assert.rejects(f.workshop.advance("171", "decoupe_cnc", { status: "en_cours" }), { code: "WORKSHOP_CNC_NOT_VALIDATED" });
});

test("API approvals require human decision rights and downloads belong to their order", async (t) => {
  const f = await fixture(t);
  const leader = await buildAuthenticatedApi({ repository: new InMemoryRepository(), documentService: f.documents, workshopStore: f.store, clock });
  const operator = await buildAuthenticatedApi({ repository: new InMemoryRepository(), documentService: f.documents, workshopStore: f.store, role: "operator", clock });
  t.after(() => Promise.all([leader.app.close(), operator.app.close()]));
  const saved = await operator.inject({ method: "POST", url: "/api/workshop/171/technical-sheet", payload: { sheet: sheet() } });
  assert.equal(saved.statusCode, 201, saved.body);
  const technical = saved.json().sheet;
  const decision = { method: "POST", url: `/api/workshop/171/technical-sheet/${technical.id}/decision`, payload: { decision: "valider" } };
  assert.equal((await operator.inject(decision)).statusCode, 403);
  assert.equal((await leader.inject(decision)).statusCode, 200);
  const dossier = (await leader.inject({ method: "POST", url: "/api/workshop/171/fabrication", payload: {} })).json().dossier;
  const file = await operator.inject({ method: "GET", url: `/api/workshop/171/fabrication/files/${dossier.files[0].id}` });
  assert.equal(file.statusCode, 200); assert.match(file.headers["content-disposition"], /^attachment;/);
  assert.equal((await leader.inject({ method: "GET", url: `/api/workshop/999/fabrication/files/${dossier.files[0].id}` })).statusCode, 404);
});

let engineReady = false;
try { engineReady = (await runEngine({ action: "profil_initial" })).ok === true; } catch { /* optional Python dependency */ }
test("real engine: DXF approval, qualified CNC, simulation, workshop validation and persisted G-code", { skip: engineReady ? false : "Python drawing engine unavailable" }, async (t) => {
  const f = await fixture(t);
  const profile = await f.run([["profil_atelier", { action: "lire", reglage: "", valeurs: [] }]]);
  assert.ok(profile.outputs[0].a_confirmer_cnc.some((q) => q.id === "profil.machine"), "all profile questions must reach the agent without truncated JSON");
  for (const [question, values] of [["profil.materiau.mdf18", { ep_reelle: "18.2" }], ["profil.usinage", {}], ["profil.machine", { modele: "CNC EXEMPLE TEST", controleur: "GRBL 1.1", course_x: "3700", course_y: "2100", course_z: "150", vitesse_broche_max: "24000", changeur_outils: "non", post_processeur: "grbl_mm", origine_xy: "avant_gauche", origine_z: "dessus_matiere" }], ["profil.outil.T1", {}], ["profil.outil.T2", {}], ["profil.outil.T3", {}], ["profil.fixation", {}]]) assert.equal((await f.designOffice.confirmProfile({ question, values })).ok, true, question);
  await f.validate();
  const args = { numero: "171", meuble: "pieces_libres", parametres: [] };
  const first = await f.run([["dessiner_dxf", args], ["dessiner_dxf", args]]);
  assert.ok(first.outputs[0].dxf_deposes.length > 0, JSON.stringify(first.outputs));
  assert.deepEqual(first.outputs[0].dxf_deposes, first.outputs[1].deja_deposes);
  assert.ok((await f.workshop.order("171")).fabricationDossiers[0].files.some((x) => /calepinage-cnc.*svg/.test(x.name)));
  for (const file of (await f.workshop.order("171")).cnc) await f.workshop.decideCncFile("171", file.id, { approve: true, by: "Direction test" });
  const unqualified = await f.run([["preparer_gcode", args]]);
  assert.equal(unqualified.outputs[0].pret, false); assert.match(unqualified.outputs[0].raisons.join(" "), /non qualifié/);
  assert.equal((await f.designOffice.recordPilot({ conforming: true, notes: "120 x 80 mesurés, profondeur 3 mm et coupe conforme" })).ok, false);
  assert.equal((await f.designOffice.pilot()).pret, true);
  assert.equal((await f.designOffice.recordPilot({ conforming: true, notes: "120 x 80 mesurés, profondeur 3 mm et coupe conforme" })).ok, true);
  const made = await f.run([["preparer_gcode", args], ["preparer_gcode", args]]);
  assert.equal(made.outputs[0].pret, true, JSON.stringify(made.outputs));
  assert.ok(made.outputs[0].gcode_deposes.length > 0); assert.deepEqual(made.outputs[0].gcode_deposes, made.outputs[1].deja_deposes);
  const gcodes = (await f.workshop.order("171")).cnc.filter((file) => file.format === "gcode");
  await assert.rejects(f.workshop.advance("171", "decoupe_cnc", { status: "en_cours" }), { code: "WORKSHOP_CNC_NOT_VALIDATED" });
  await assert.rejects(f.workshop.decideCncFile("171", gcodes[0].id, { approve: true }), { code: "WORKSHOP_CNC_SIMULATION_REQUIRED" });
  for (const file of gcodes) {
    assert.ok(file.simulation.ok && file.sourceDxfIds.length);
    await f.workshop.decideCncFile("171", file.id, { approve: true, by: "Responsable atelier test", workshopValidation: "Simulation, fraise, origine et fixation contrôlées." });
    const bytes = (await f.workshop.readCncFile("171", file.id)).bytes;
    assert.deepEqual(await readFile(join(f.dir, "commandes", file.archivePath)), bytes); assert.match(bytes.toString(), /G21/);
  }
  await f.workshop.advance("171", "decoupe_cnc", { status: "en_cours" });
});

test("without Python the drawing engine reports its installation error", async () => {
  const office = createDesignOffice({ engine: (request) => runEngine(request, { python: "python-introuvable-hkids" }) });
  await assert.rejects(office.draw({ furniture: "pieces_libres" }), (e) => e instanceof DesignOfficeError && e.code === "DESIGN_ENGINE_UNAVAILABLE");
});

test("G-code uploads cannot bypass DXF approval", async (t) => {
  const f = await fixture(t); await f.workshop.advance("171", "etude_technique", { status: "terminee" });
  await assert.rejects(f.workshop.depositCncFile("171", { name: "premature.nc", content: Buffer.from("G21 G90\nG0 X0 Y0 Z5\nM30\n") }), { code: "WORKSHOP_DXF_NOT_VALIDATED" });
});
