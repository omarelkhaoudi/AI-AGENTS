import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { createFileCashBook, createMemoryCashBook } from "../src/agent/cash-book.js";
import { createMemoryImprovementBook } from "../src/agent/improvement-book.js";
import { createMemoryTeamBook } from "../src/agent/team-book.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { createMemoryWorkshopStore, createWorkshop } from "../src/agent/workshop-book.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// Hiba's three requests of 09/11/2026: money in and out announced to the
// Director and kept by Finance with a balance every day; anomalies analysed by
// their agent into a rule the direction validates; agents tied to real people
// and aware of what the others did. Invented clients and figures only.

const NOW = new Date("2026-11-09T10:00:00Z");
const clock = () => NOW;

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "hkids-books-"));
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
const order = { ...quote, documentType: "purchase_order", documentNumber: "171", date: "03/11/2026", payment: { termsRule: "hkids-po-50-50" }, specifications: ["Bois clair"], quoteReference: "170" };

async function documentsWith(t, ...inputs) {
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: await tempDir(t) });
  for (const input of inputs) {
    const preview = await documents.preview(input);
    await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true });
  }
  return documents;
}

test("the cash book keeps each movement, refuses the same news twice, and computes the day's balance", async () => {
  const cash = createMemoryCashBook({ clock });
  await cash.record({ kind: "entree", amount: 5000, category: "solde_depart", method: "especes", day: "08/11/2026" });
  await cash.record({ kind: "sortie", amount: 300, category: "transport", label: "Taxi livraison", method: "especes", day: "08/11/2026" });
  const deposit = await cash.record({ kind: "entree", amount: 2700, category: "acompte_client", party: "Client Exemple", quoteNumber: "170", method: "virement" });
  await cash.record({ kind: "sortie", amount: 1200.5, category: "achat_matiere", label: "Laque blanche", party: "Fournisseur Exemple", method: "cheque" });

  await assert.rejects(cash.record({ kind: "entree", amount: 2700, party: "client exemple", category: "acompte_client" }), { code: "CASH_DUPLICATE" });
  await assert.rejects(cash.record({ kind: "entree", amount: 0 }), { code: "CASH_AMOUNT_INVALID" });
  await assert.rejects(cash.record({ kind: "rien", amount: 10 }), { code: "CASH_KIND_UNKNOWN" });
  await assert.rejects(cash.record({ kind: "sortie", amount: 10, day: "10/11/2026" }), { code: "CASH_DATE_FUTURE" });
  await assert.rejects(cash.record({ kind: "sortie", amount: 10, category: "solde_depart" }), { code: "CASH_CATEGORY_UNKNOWN" });
  const second = await cash.record({ kind: "entree", amount: 2700, party: "Client Exemple", quoteNumber: "170", category: "acompte_client", confirmDuplicate: true });

  await assert.rejects(cash.cancel(second.number, {}), { code: "CASH_CANCEL_REASON_MISSING" });
  await cash.cancel(second.number, { reason: "Saisi deux fois" });
  await assert.rejects(cash.cancel(second.number, { reason: "encore" }), { code: "CASH_ENTRY_CANCELLED" });

  const yesterday = await cash.day("08/11/2026");
  assert.deepEqual([yesterday.opening, yesterday.carriedIn, yesterday.totalIn, yesterday.totalOut, yesterday.closing], [0, 5000, 0, 300, 4700], "the opening balance is carried, not counted as takings");

  const today = await cash.day();
  assert.equal(today.day, "2026-11-09");
  assert.deepEqual([today.opening, today.totalIn, today.totalOut, today.net, today.closing], [4700, 2700, 1200.5, 1499.5, 6199.5]);
  assert.deepEqual([today.closingCash, today.closingBank], [4700, 1499.5], "cash in hand and bank told apart");
  assert.equal(today.entries.length, 3, "the cancelled line stays in the day, struck out");
  assert.equal(today.entries.find((entry) => entry.number === second.number).cancelled.reason, "Saisi deux fois");
  assert.deepEqual(today.byCategory.map((entry) => [entry.category, entry.amount]), [["acompte_client", 2700], ["achat_matiere", 1200.5]]);

  const month = await cash.month("2026-11");
  assert.deepEqual([month.opening, month.totalIn, month.totalOut, month.closing, month.days.length], [0, 2700, 1500.5, 6199.5, 2]);
  assert.equal((await cash.collectedFor({ quoteNumber: "170" })).total, 2700, "only the line still counting");
  assert.equal(deposit.number, 3);
});

test("the cash book survives a restart", async (t) => {
  const path = join(await tempDir(t), "caisse.json");
  await createFileCashBook({ path, clock }).record({ kind: "entree", amount: 900, category: "vente_comptant", method: "especes" });
  assert.equal((await createFileCashBook({ path, clock }).day()).closing, 900);
});

test("a blocked or late step becomes one anomaly, analysed into a rule that applies only once validated", async () => {
  const book = createMemoryImprovementBook({ clock });
  const orders = [{
    number: "171",
    client: "Client Exemple",
    steps: [
      { id: "approvisionnement", label: "Approvisionnement", status: "bloquee", note: "Laque en rupture", late: false },
      { id: "assemblage", label: "Assemblage", status: "en_cours", plannedDate: "2026-11-05", late: true }
    ]
  }];

  const found = await book.sync(orders);
  assert.deepEqual(found.map((anomaly) => [anomaly.number, anomaly.kind, anomaly.owner]), [[1, "blocage", "purchasing"], [2, "retard", "production"]]);
  assert.equal((await book.sync(orders)).length, 0, "read again, the same facts are the same anomalies");

  await assert.rejects(book.analyse(1, { cause: "", by: "purchasing" }), { code: "IMPROVEMENT_CAUSE_MISSING" });
  await assert.rejects(book.analyse(1, { cause: "Laque commandée trop tard", by: "purchasing" }), { code: "IMPROVEMENT_RULE_MISSING" });
  const { rule } = await book.analyse(1, { cause: "Laque commandée trop tard", rule: { title: "Commander la laque à l'étude", trigger: "BC avec finition laquée", action: "Commander la laque dès l'étude technique", owner: "purchasing" }, by: "purchasing" });
  assert.equal(rule.status, "proposee");
  assert.deepEqual(await book.activeRules("purchasing"), [], "a proposal is not a rule in force");

  await assert.rejects(book.decide(rule.number, "retirer"), { code: "IMPROVEMENT_DECISION_INVALID" });
  await book.decide(rule.number, "valider", { by: "hiba" });
  assert.deepEqual((await book.activeRules("purchasing")).map((entry) => entry.title), ["Commander la laque à l'étude"]);
  assert.deepEqual(await book.activeRules("production"), [], "an agent gets its own rules");
  assert.equal((await book.activeRules("director")).length, 1, "the Director gets them all");

  // The step moves on: the anomaly is lifted; it comes back later as a new one.
  const fixed = [{ ...orders[0], steps: [{ ...orders[0].steps[0], status: "terminee" }, orders[0].steps[1]] }];
  await book.sync(fixed);
  const state = await book.state();
  assert.deepEqual(state.anomalies.map((anomaly) => anomaly.status), ["levee", "a_analyser"]);
  const again = await book.sync(orders);
  assert.deepEqual(again.map((anomaly) => anomaly.number), [3]);
  await book.analyse(3, { cause: "Même cause", existingRule: String(rule.number), by: "purchasing" });
  const [held] = (await book.state()).rules;
  assert.equal(held.recurrences.length, 1, "the rule did not hold, and it is counted");
  assert.deepEqual(held.anomalies, [1, 3]);
});

test("an agent is tied to a person, and its news is what the others did", async () => {
  const team = createMemoryTeamBook({ clock, agents: SPECIALIST_IDS });
  await assert.rejects(team.link("inconnu", { name: "X" }), { code: "TEAM_AGENT_UNKNOWN" });
  await assert.rejects(team.link("production", { name: "Youssef", phone: "12" }), { code: "TEAM_PHONE_INVALID" });
  const member = await team.link("production", { name: "Youssef", role: "chef d'atelier", phone: "06 12 34 56 78" });
  assert.equal(member.phone, "212612345678");
  await team.log({ agent: "finance", kind: "caisse", text: "Entrée n° 1 : 2 700 DH" });
  await team.log({ agent: "production", kind: "atelier", text: "BC 171 en découpe" });

  assert.deepEqual((await team.newsFor("production")).map((entry) => entry.agent), ["finance"]);
  assert.deepEqual((await team.activity({ agent: "production" })).map((entry) => entry.kind), ["atelier", "equipe"]);
  assert.equal(await team.link("production", { name: "" }), null);
  assert.equal(await team.member("production"), null);
});

// The agents, with the model's answers written in advance.
function agentWith(documents, books, scripts, extra = {}) {
  const calls = [];
  const agent = createDirectorAgent({
    client: { responses: { create: async (payload) => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      const who = Object.keys(scripts).find((key) => payload.instructions.includes(key));
      return scripts[who].shift();
    } } },
    documentService: documents,
    toolRegistry: { list: () => [] },
    executeTool: async () => ({ ok: true, donnees: null }),
    clock,
    ...books,
    ...extra
  });
  return { agent, calls };
}
const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
const say = (text) => ({ output_text: text, output: [] });
const outputOf = (payload) => JSON.parse(payload.input.at(-1).output);
const DEPOSIT = { sens: "entree", montant: 2700, categorie: "acompte_client", libelle: "Acompte 60 % lit cabane", moyen: "especes", tiers: "Client Exemple", reference_devis: "170", reference_bc: "", date: "", annonce_par: "Hiba", confirme_doublon: false };

test("money announced to the Director is recorded by Finance, with the day's balance and what the sale still owes", async (t) => {
  const documents = await documentsWith(t, quote, order);
  const books = { cashBook: createMemoryCashBook({ clock }), improvementBook: createMemoryImprovementBook({ clock }), teamBook: createMemoryTeamBook({ clock, agents: SPECIALIST_IDS }) };
  await books.teamBook.link("finance", { name: "Samira", role: "comptable", phone: "0661000000" });
  const { agent, calls } = agentWith(documents, books, {
    "Tu es le Director IA": [
      call("deleguer_a_un_agent", { agent: "finance", mission: "Hiba annonce : acompte de 2 700 DH reçu en espèces de Client Exemple pour le devis 170." }, "d1"),
      call("bilan_caisse", { date: "", mois: "" }, "b1"),
      say("Acompte enregistré : 2 700 DH. Solde du jour : 2 700 DH.")
    ],
    "Tu es l'agent Administration / Finance": [
      call("enregistrer_mouvement_caisse", DEPOSIT, "f1"),
      call("enregistrer_mouvement_caisse", DEPOSIT, "f2"),
      say("Mouvement n° 1 enregistré.")
    ]
  });

  await agent.chat({ message: "J'ai reçu 2 700 DH d'acompte de Client Exemple en espèces pour le devis 170" });

  const finance = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Administration / Finance"));
  const tools = finance[0].tools.map((tool) => tool.name);
  assert.ok(tools.includes("enregistrer_mouvement_caisse") && tools.includes("annuler_mouvement_caisse") && tools.includes("bilan_caisse"));
  assert.match(finance[0].instructions, /Ton responsable humain dans l'équipe H KIDS : Samira \(comptable\), WhatsApp 212661000000/);

  const recorded = outputOf(finance[1]);
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.equal(recorded.enregistre.numero, 1);
  assert.deepEqual(recorded.vente, { reference: "devis n° 170", encaisse_sur_cette_vente: 2700, montant_de_la_vente: 4500, reste_a_encaisser: 1800 });
  assert.deepEqual([recorded.bilan_du_jour.entrees, recorded.bilan_du_jour.solde_cloture, recorded.bilan_du_jour.dont_especes], [2700, 2700, 2700]);
  assert.match(outputOf(finance[2]).erreur, /identique/, "told twice, recorded once");

  const director = calls.filter((payload) => payload.instructions.startsWith("Tu es le Director IA"));
  assert.ok(!director[0].tools.some((tool) => tool.name === "enregistrer_mouvement_caisse"), "the Director has Finance record it");
  assert.equal(outputOf(director[2]).jour.solde_cloture, 2700);

  const feed = await books.teamBook.activity();
  assert.deepEqual(feed.slice(0, 2).map((entry) => entry.kind), ["mission", "caisse"]);
  assert.match(feed[1].text, /Entrée n° 1 : 2[  ]700 DH — Acompte 60 % lit cabane \(Client Exemple\), annoncée par Hiba/);
});

test("a late step is analysed by Production on its own; validated, the rule goes with Production's next missions", async (t) => {
  const documents = await documentsWith(t, quote, order);
  const workshopStore = createMemoryWorkshopStore({ clock });
  await createWorkshop({ store: workshopStore, documentService: documents, clock }).advance("171", "assemblage", { status: "en_cours", plannedDate: "05/11/2026" });
  const books = { cashBook: createMemoryCashBook({ clock }), improvementBook: createMemoryImprovementBook({ clock }), teamBook: createMemoryTeamBook({ clock, agents: SPECIALIST_IDS }) };
  await books.teamBook.log({ agent: "finance", kind: "caisse", text: "Entrée n° 1 : 2 700 DH — acompte BC 171" });
  const { agent, calls } = agentWith(documents, books, {
    "Tu es l'agent Production": [
      call("analyser_anomalie", { anomalie: 1, cause: "Assemblage commencé sans date de fin tenue : un seul monteur", regle_existante: 0, titre: "Deux monteurs sur les lits cabane", quand: "BC de lit cabane", action: "Planifier deux monteurs dès l'étude", responsable: "production" }, "p1"),
      call("analyser_anomalie", { anomalie: 1, cause: "Encore", regle_existante: 0, titre: "x", quand: "", action: "y", responsable: "production" }, "p2"),
      say("Cause trouvée, règle proposée."),
      say("Rien à signaler.")
    ],
    "Tu es le Director IA": [
      call("deleguer_a_un_agent", { agent: "production", mission: "Planning de la semaine." }, "d1"),
      say("Planning prêt.")
    ]
  }, { workshopStore, autoAnalyse: true });

  const found = await agent.syncAnomalies(await createWorkshop({ store: workshopStore, documentService: documents, clock }).book());
  assert.deepEqual(found.map((anomaly) => anomaly.fact), ["BC 171 (Client Exemple) : Assemblage prévue le 05/11/2026, pas terminée"]);
  await agent.idle();

  const first = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Production"));
  assert.match(first[0].input[0].content, /Analyse l'anomalie n° 1 : BC 171/);
  assert.match(first[0].input[0].content, /Dossier du BC 171 au carnet d'atelier/);
  assert.match(first[0].instructions, /Ce que le reste de l'équipe a fait ces derniers jours[\s\S]*Finance : Entrée n° 1/);
  assert.equal(outputOf(first[1]).ok, true);
  assert.match(outputOf(first[1]).statut, /attend la validation de la direction/);
  assert.match(outputOf(first[2]).erreur, /déjà analysée/, "one anomaly, one analysis");

  const { rules } = await books.improvementBook.state();
  await books.improvementBook.decide(rules[0].number, "valider", { by: "hiba" });
  await agent.chat({ message: "Fais le planning de l'atelier" });
  const next = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Production")).at(-1);
  assert.match(next.instructions, /Règle n° 1 « Deux monteurs sur les lits cabane » — quand : BC de lit cabane — action : Planifier deux monteurs dès l'étude/);
  const director = calls.find((payload) => payload.instructions.startsWith("Tu es le Director IA"));
  assert.match(director.instructions, /Règle n° 1 « Deux monteurs sur les lits cabane »/);
});

test("the cockpit keeps the cash book, decides the rules and ties each agent to a person", async (t) => {
  const documents = await documentsWith(t, quote, order);
  const workshopStore = createMemoryWorkshopStore({ clock });
  await createWorkshop({ store: workshopStore, documentService: documents, clock }).advance("171", "decoupe_cnc", { status: "bloquee", note: "CNC en panne" });
  const improvementBook = createMemoryImprovementBook({ clock });
  const { app, inject } = await buildAuthenticatedApi({
    repository: new InMemoryRepository(),
    documentService: documents,
    workshopStore,
    cashBook: createMemoryCashBook({ clock }),
    improvementBook,
    teamBook: createMemoryTeamBook({ clock, agents: SPECIALIST_IDS }),
    clock
  });
  t.after(() => app.close());
  const json = (response) => JSON.parse(response.body);

  assert.equal((await app.inject({ method: "GET", url: "/api/cash" })).statusCode, 401);
  const posted = await inject({ method: "POST", url: "/api/cash", payload: { kind: "sortie", amount: 450, category: "transport", method: "especes", label: "Livraison" } });
  assert.equal(posted.statusCode, 201, posted.body);
  assert.equal((await inject({ method: "POST", url: "/api/cash", payload: { kind: "sortie", amount: 450, category: "transport", label: "Livraison" } })).statusCode, 409);
  assert.equal((await inject({ method: "POST", url: "/api/cash", payload: { kind: "sortie", amount: "beaucoup" } })).statusCode, 400);
  const balance = json(await inject({ method: "GET", url: "/api/cash" }));
  assert.deepEqual([balance.today, balance.day.totalOut, balance.day.closing], ["2026-11-09", 450, -450]);
  assert.ok(balance.categories.sortie.transport);
  assert.equal((await inject({ method: "POST", url: `/api/cash/${json(posted).entry.number}/cancel`, payload: { reason: "Erreur" } })).statusCode, 200);
  assert.equal((await inject({ method: "POST", url: "/api/cash/99/cancel", payload: { reason: "Erreur" } })).statusCode, 404);

  const improvement = json(await inject({ method: "GET", url: "/api/improvement" }));
  assert.deepEqual(improvement.anomalies.map((anomaly) => [anomaly.kind, anomaly.owner]), [["blocage", "production"]], "the book read is where the anomaly is found");
  await improvementBook.analyse(1, { cause: "CNC sans entretien", rule: { title: "Entretien CNC hebdomadaire", action: "Graisser et vérifier la CNC chaque lundi", owner: "production" }, by: "production" });
  assert.equal((await inject({ method: "POST", url: "/api/improvement/rules/1/decision", payload: { decision: "valider" } })).statusCode, 200);
  assert.equal((await inject({ method: "POST", url: "/api/improvement/rules/1/decision", payload: { decision: "valider" } })).statusCode, 400);
  assert.equal((await inject({ method: "POST", url: "/api/improvement/rules/9/decision", payload: { decision: "valider" } })).statusCode, 404);

  assert.equal((await inject({ method: "PUT", url: "/api/team/production/member", payload: { name: "Youssef", role: "chef d'atelier", phone: "0612345678" } })).statusCode, 200);
  assert.equal((await inject({ method: "PUT", url: "/api/team/rien/member", payload: { name: "X" } })).statusCode, 404);
  const team = json(await inject({ method: "GET", url: "/api/team" }));
  const production = team.agents.find((entry) => entry.id === "production");
  assert.equal(production.member.name, "Youssef");
  assert.deepEqual(production.rules.map((rule) => rule.title), ["Entretien CNC hebdomadaire"]);
  assert.deepEqual(team.activity.map((entry) => entry.kind), ["equipe", "amelioration", "caisse", "caisse"]);
});
