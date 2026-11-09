import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { createMemoryCashBook } from "../src/agent/cash-book.js";
import { createMemoryImprovementBook } from "../src/agent/improvement-book.js";
import { createMemoryTeamBook } from "../src/agent/team-book.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { directorBriefing } from "../src/agent/company-tools.js";
import { createFileWorkshopStore, createMemoryWorkshopStore, createWorkshop } from "../src/agent/workshop-book.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// Hiba's request of 09/11/2026: each order has a chef de charge who answers
// for it, the client's architect and the member of the team who deals with
// them, and a draughtsman who turns the technical sheet into the G-code of the
// CNC machine. The file reaches the machine only once the direction validated
// it. Invented clients, people and figures only.

const NOW = new Date("2026-11-09T09:00:00Z");
const clock = () => NOW;
const GCODE = "%\nG21 G90\nG0 X0 Y0 Z5\nG1 Z-18 F300\nG1 X600 Y0 F1200\nM30\n%\n";
const DXF = "  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const base64 = (value) => Buffer.from(value).toString("base64");

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "hkids-design-office-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const client = { name: "Client Exemple", address: "Marrakech" };
const quote = {
  documentType: "quote",
  documentNumber: "170",
  date: "02/11/2026",
  object: "Chambre enfant sur mesure",
  client,
  items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: 3750, amountHt: 3750 }],
  totals: { totalHt: 3750, tva: 750, totalTtc: 4500 },
  payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
};
const order = { ...quote, documentType: "purchase_order", documentNumber: "171", date: "03/11/2026", payment: { termsRule: "hkids-po-50-50" }, specifications: ["Bois clair"], quoteReference: "170" };

async function documentsWith(t) {
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: await tempDir(t) });
  for (const input of [quote, order]) {
    const preview = await documents.preview(input);
    await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true });
  }
  return documents;
}

test("an order names its chef de charge, the client's architect, who deals with them and the draughtsman", async (t) => {
  const workshop = createWorkshop({ store: createMemoryWorkshopStore({ clock }), documentService: await documentsWith(t), clock });

  const { changed, order: named } = await workshop.setTeam("171", { lead: "Samir", architect: "Cabinet Exemple", architectPhone: "06 12 34 56 78", liaison: "Hiba", drafter: "Karim" }, { by: "hiba" });
  assert.equal(changed, true);
  assert.deepEqual({ ...named.team }, { lead: "Samir", architect: "Cabinet Exemple", architectPhone: "212612345678", liaison: "Hiba", drafter: "Karim", drafterPhone: "" });
  assert.equal(named.journal.at(-1).text, "Équipe de la commande : chef de charge : Samir ; architecte : Cabinet Exemple ; téléphone de l'architecte : 212612345678 ; lien avec l'architecte : Hiba ; dessinateur : Karim.");

  const { order: changedLead } = await workshop.setTeam("171", { lead: "Youssef", architect: "" });
  assert.deepEqual([changedLead.team.lead, changedLead.team.architect, changedLead.team.drafter], ["Youssef", "", "Karim"], "only the roles given change; an empty one is removed");
  assert.equal((await workshop.setTeam("171", { lead: "Youssef" })).changed, false, "saying it again records nothing");

  await assert.rejects(workshop.setTeam("171", { architectPhone: "pas de numéro" }), { code: "WORKSHOP_PHONE_INVALID" });
  await assert.rejects(workshop.setTeam("999", { lead: "Samir" }), { code: "WORKSHOP_ORDER_NOT_FOUND" });
});

test("the draughtsman's G-code waits for the direction before the CNC cut can start", async (t) => {
  const workshop = createWorkshop({ store: createMemoryWorkshopStore({ clock }), documentService: await documentsWith(t), clock });
  await workshop.setTeam("171", { drafter: "Karim" });

  await assert.rejects(workshop.depositCncFile("171", { content: base64(GCODE), name: "panneaux.nc" }), { code: "WORKSHOP_STUDY_NOT_DONE" }, "the technical sheet comes first");
  await workshop.advance("171", "etude_technique", { status: "terminee" });

  await assert.rejects(workshop.depositCncFile("171", { content: JPEG, name: "photo.nc" }), { code: "WORKSHOP_CNC_CONTENT" }, "a photo renamed .nc never reaches the machine");
  await assert.rejects(workshop.depositCncFile("171", { content: base64(GCODE), name: "panneaux.pdf" }), { code: "WORKSHOP_CNC_FORMAT" });
  await assert.rejects(workshop.depositCncFile("171", { content: "", name: "vide.nc" }), { code: "WORKSHOP_CNC_EMPTY" });

  const first = await workshop.depositCncFile("171", { content: `data:application/octet-stream;base64,${base64(GCODE)}`, name: "C:\\Plans\\panneaux-lit.nc", note: "MDF 18 mm", by: "karim" });
  let current = await workshop.order("171");
  const drawing = current.steps.find((step) => step.id === "dessin_cnc");
  assert.deepEqual([drawing.status, drawing.responsible], ["en_cours", "Karim"], "the drawing is under way, by the draughtsman");
  assert.deepEqual(current.cnc.map((file) => [file.name, file.format, file.status, file.note]), [["panneaux-lit.nc", "gcode", "a_valider", "MDF 18 mm"]]);
  assert.ok(current.alerts.includes("Fichier CNC « panneaux-lit.nc » à valider par la direction avant la découpe"));

  await assert.rejects(workshop.advance("171", "decoupe_cnc", { status: "en_cours" }), { code: "WORKSHOP_CNC_NOT_VALIDATED" });
  await assert.rejects(workshop.advance("171", "dessin_cnc", { status: "terminee" }), { code: "WORKSHOP_CNC_NOT_VALIDATED" });
  await workshop.advance("171", "decoupe_cnc", { status: "bloquee", note: "En attente du G-code validé" });

  await assert.rejects(workshop.decideCncFile("171", first, { approve: false }), { code: "WORKSHOP_CNC_REASON_MISSING" });
  await workshop.decideCncFile("171", first, { approve: false, reason: "Cote du montant fausse (1200 au lieu de 1250)", by: "Hiba" });
  await assert.rejects(workshop.decideCncFile("171", first, { approve: true }), { code: "WORKSHOP_CNC_ALREADY_DECIDED" });
  current = await workshop.order("171");
  assert.equal(current.steps.find((step) => step.id === "dessin_cnc").status, "en_cours", "a refused file leaves the drawing to do");

  const second = await workshop.depositCncFile("171", { content: Buffer.from(DXF), name: "panneaux-lit-v2.dxf", by: "karim" });
  const validated = await workshop.decideCncFile("171", second, { approve: true, by: "Hiba" });
  assert.deepEqual([validated.status, validated.decidedBy], ["valide", "Hiba"]);
  current = await workshop.order("171");
  assert.equal(current.steps.find((step) => step.id === "dessin_cnc").status, "terminee", "validated, the drawing is finished");
  assert.deepEqual(current.alerts, ["Découpe CNC bloquée : En attente du G-code validé"]);

  const { order: cutting } = await workshop.advance("171", "decoupe_cnc", { status: "en_cours" });
  assert.equal(cutting.steps.find((step) => step.id === "decoupe_cnc").status, "en_cours");
  assert.deepEqual((await workshop.readCncFile("171", second)).bytes.toString(), DXF);
  assert.ok(current.journal.some((entry) => entry.text === "Dessin CNC : fichier « panneaux-lit.nc » refusé : Cote du montant fausse (1200 au lieu de 1250)."));
});

test("a cut already under way before the rule may still finish", async () => {
  const store = createMemoryWorkshopStore({ clock });
  // As written by the book before the design office existed.
  await store.all().then((orders) => Object.assign(orders, { 171: { steps: { decoupe_cnc: { status: "en_cours" } }, journal: [] } }));
  const { order: record } = await store.updateStep("171", "decoupe_cnc", { status: "terminee" });
  assert.equal(record.steps.decoupe_cnc.status, "terminee");
});

test("the machine files survive a restart", async (t) => {
  const path = join(await tempDir(t), "atelier.json");
  const store = createFileWorkshopStore({ path, clock });
  await store.updateStep("171", "etude_technique", { status: "terminee" });
  const id = await store.addCncFile("171", { bytes: Buffer.from(GCODE), name: "panneaux.nc", format: "gcode" });
  const reopened = createFileWorkshopStore({ path, clock });
  assert.equal((await reopened.readCncFile("171", id)).bytes.toString(), GCODE);
});

test("the draughtsman deposits from the cockpit; only the direction validates, and the file is always a download", async (t) => {
  const documents = await documentsWith(t);
  const workshopStore = createMemoryWorkshopStore({ clock });
  const teamBook = createMemoryTeamBook({ clock, agents: SPECIALIST_IDS });
  const leader = await buildAuthenticatedApi({ repository: new InMemoryRepository(), documentService: documents, workshopStore, teamBook, clock });
  const operator = await buildAuthenticatedApi({ repository: new InMemoryRepository(), documentService: documents, workshopStore, teamBook, role: "operator", userId: "karim", clock });
  t.after(() => Promise.all([leader.app.close(), operator.app.close()]));
  const json = (response) => JSON.parse(response.body);

  const team = await leader.inject({ method: "PATCH", url: "/api/workshop/171/team", payload: { lead: "Samir", drafter: "Karim", unknown: "ignored" } });
  assert.equal(team.statusCode, 200);
  assert.deepEqual([json(team).order.team.lead, json(team).order.team.drafter], ["Samir", "Karim"]);
  assert.equal((await leader.inject({ method: "PATCH", url: "/api/workshop/999/team", payload: { lead: "Samir" } })).statusCode, 404);

  const early = await operator.inject({ method: "POST", url: "/api/workshop/171/cnc", payload: { name: "panneaux.nc", content: base64(GCODE) } });
  assert.equal(early.statusCode, 400);
  assert.equal(json(early).details.code, "WORKSHOP_STUDY_NOT_DONE");
  await leader.inject({ method: "PATCH", url: "/api/workshop/171/steps/etude_technique", payload: { status: "terminee" } });

  const deposited = await operator.inject({ method: "POST", url: "/api/workshop/171/cnc", payload: { name: "panneaux.nc", content: base64(GCODE), note: "MDF 18 mm" } });
  assert.equal(deposited.statusCode, 201);
  const { id } = json(deposited);

  const download = await leader.inject({ method: "GET", url: `/api/workshop/171/cnc/${id}` });
  assert.equal(download.statusCode, 200);
  assert.equal(download.body, GCODE);
  assert.equal(download.headers["content-type"], "application/octet-stream");
  assert.match(download.headers["content-disposition"], /^attachment; filename="panneaux\.nc"$/);
  assert.equal(download.headers["x-content-type-options"], "nosniff");
  assert.equal((await leader.inject({ method: "GET", url: "/api/workshop/171/cnc/nope" })).statusCode, 404);

  assert.equal((await operator.inject({ method: "POST", url: `/api/workshop/171/cnc/${id}/decision`, payload: { decision: "valider" } })).statusCode, 403, "validating for the machine is a decision");
  assert.equal((await leader.inject({ method: "POST", url: `/api/workshop/171/cnc/${id}/decision`, payload: { decision: "peut-etre" } })).statusCode, 400);
  const decided = await leader.inject({ method: "POST", url: `/api/workshop/171/cnc/${id}/decision`, payload: { decision: "valider" } });
  assert.equal(decided.statusCode, 200);
  assert.equal(json(decided).order.steps.find((step) => step.id === "dessin_cnc").status, "terminee");
  assert.equal((await leader.inject({ method: "POST", url: `/api/workshop/171/cnc/${id}/decision`, payload: { decision: "refuser", reason: "trop tard" } })).statusCode, 409);
  assert.ok((await teamBook.activity({ agent: "production" })).some((entry) => entry.text.includes("fichier CNC « panneaux.nc » validé")));
});

// The agents, with the model's answers written in advance.
function agentWith(documents, workshopStore, scripts, books = {}) {
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
    clock,
    ...books
  });
  return { agent, calls };
}
const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
const say = (text) => ({ output_text: text, output: [] });
const roles = (extra) => ({ numero: "171", chef_de_charge: "", architecte: "", telephone_architecte: "", lien_architecte: "", dessinateur: "", telephone_dessinateur: "", ...extra });

test("told who answers for an order, the Director records it; Production can too; neither can validate a CNC file", async (t) => {
  const documents = await documentsWith(t);
  const workshopStore = createMemoryWorkshopStore({ clock });
  const { agent, calls } = agentWith(documents, workshopStore, {
    "Tu es le Director IA": [
      call("equipe_commande", roles({ chef_de_charge: "Samir", architecte: "Cabinet Exemple", lien_architecte: "Hiba" }), "e1"),
      call("deleguer_a_un_agent", { agent: "production", mission: "Karim fait le G-code du BC 171 ; Samir n'est plus chef de charge, c'est Youssef." }, "d1"),
      say("Équipe du BC 171 enregistrée.")
    ],
    "Tu es l'agent Production": [
      call("equipe_commande", roles({ chef_de_charge: "Youssef", dessinateur: "Karim", telephone_dessinateur: "06 70 00 00 03", architecte: "-" }), "p1"),
      say("Youssef chef de charge, Karim au dessin.")
    ]
  });

  await agent.chat({ message: "Samir est chef de charge du BC 171, l'architecte c'est le Cabinet Exemple et c'est moi qui le suis. Dis à la production que Karim fait le G-code et que Youssef remplace Samir." });

  const director = calls.filter((payload) => payload.instructions.startsWith("Tu es le Director IA"));
  const directorTools = director[0].tools.map((tool) => tool.name);
  assert.ok(directorTools.includes("equipe_commande"));
  assert.ok(director[0].instructions.includes("Bureau d'études"));
  assert.ok(!directorTools.some((name) => /valid/i.test(name)), "no agent validates a machine file");
  assert.equal(JSON.parse(director[1].input.at(-1).output).equipe.chef_de_charge, "Samir");

  const production = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Production"));
  assert.ok(production[0].tools.some((tool) => tool.name === "equipe_commande"));
  const book = await createWorkshop({ store: workshopStore, documentService: documents, clock }).order("171");
  assert.deepEqual({ ...book.team }, { lead: "Youssef", architect: "", architectPhone: "", liaison: "Hiba", drafter: "Karim", drafterPhone: "212670000003" });
  assert.equal(book.journal.at(-1).by, "production");
});

test("Commercial reads who answers for an order but cannot change it", async (t) => {
  const documents = await documentsWith(t);
  const { calls, agent } = agentWith(documents, createMemoryWorkshopStore({ clock }), {
    "Tu es le Director IA": [call("deleguer_a_un_agent", { agent: "commercial", mission: "Qui est le chef de charge du BC 171 ?" }, "d1"), say("…")],
    "Tu es l'agent Commercial": [call("carnet_atelier", { numero: "171" }, "c1"), say("À désigner.")]
  });
  await agent.chat({ message: "Qui est chef de charge du 171 ?" });
  const commercial = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Commercial"));
  assert.ok(!commercial[0].tools.some((tool) => tool.name === "equipe_commande"));
  const read = JSON.parse(commercial[1].input.at(-1).output);
  assert.deepEqual(read.equipe, { chef_de_charge: "à désigner", architecte: "aucun", lien_avec_l_architecte: null, dessinateur: "à désigner" });
  assert.deepEqual(read.fichiers_cnc, []);
});

test("the Director is told which orders have no chef de charge and which CNC files wait", async (t) => {
  const documents = await documentsWith(t);
  const store = createMemoryWorkshopStore({ clock });
  const workshop = createWorkshop({ store, documentService: documents, clock });
  const books = {
    cash: createMemoryCashBook({ clock }),
    improvement: createMemoryImprovementBook({ clock }),
    team: createMemoryTeamBook({ clock, agents: SPECIALIST_IDS })
  };

  let lines = await directorBriefing({ books, workshop });
  assert.ok(lines.includes("Bons de commande en cours sans chef de charge : n° 171 (equipe_commande quand la direction le désigne)."));

  await workshop.setTeam("171", { lead: "Samir" });
  await workshop.advance("171", "etude_technique", { status: "terminee" });
  await workshop.depositCncFile("171", { content: base64(GCODE), name: "panneaux.nc" });
  lines = await directorBriefing({ books, workshop });
  assert.ok(!lines.some((line) => line.includes("sans chef de charge")));
  assert.ok(lines.includes("1 fichier(s) CNC attendent la validation de la direction dans le cockpit (BC n° 171) : la découpe ne peut pas commencer avant."));
});
