import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { createMemoryFollowUpBook } from "../src/agent/sales-book.js";
import { createMemoryHrBook, hrFacts, trialEndFor } from "../src/agent/hr-book.js";
import { runHrTool } from "../src/agent/hr-tools.js";
import { createMemoryImprovementBook } from "../src/agent/improvement-book.js";
import { HkidsDocumentService } from "../src/documents/document-service.js";

// Thursday 19 November 2026.
const clock = () => new Date("2026-11-19T09:00:00Z");

async function team() {
  const hr = createMemoryHrBook({ clock });
  await hr.addEmployee({ name: "Samir Alaoui", role: "menuisier", startDate: "02/11/2026" });
  await hr.addEmployee({ name: "Karim Bennani", role: "peintre", startDate: "01/09/2024" });
  return hr;
}

test("the trial period follows art. 14 of the Code du travail", () => {
  assert.equal(trialEndFor("cdi", "cadre", "2026-11-02"), "2027-02-01", "three months");
  assert.equal(trialEndFor("cdi", "employe", "2026-11-02"), "2026-12-16", "a month and a half");
  assert.equal(trialEndFor("cdi", "ouvrier", "2026-11-02"), "2026-11-16", "fifteen days");
  assert.equal(trialEndFor("cdi", "", "2026-11-02"), null, "no category, no trial assumed");
  assert.equal(trialEndFor("cdd", "", "2026-11-02", "2027-01-31"), "2026-11-14", "a day per week of a CDD under six months");
  assert.equal(trialEndFor("cdd", "", "2026-11-02", "2027-12-31"), "2026-12-01", "a month for a CDD over six months");
  assert.equal(trialEndFor("stage", "", "2026-11-02", "2027-01-31"), null);
});

test("a contract replaces the one in force, a CDD needs its end, a CDI has none, and a departure ends it", async () => {
  const hr = await team();
  await assert.rejects(hr.setContract({ who: "Samir", kind: "cdd", start: "02/11/2026" }), { code: "HR_CONTRACT_END_MISSING" });
  await assert.rejects(hr.setContract({ who: "Samir", kind: "cdi", start: "02/11/2026", end: "01/05/2027" }), { code: "HR_CONTRACT_END_CDI" });
  await assert.rejects(hr.setContract({ who: "Samir", kind: "interim", start: "02/11/2026" }), { code: "HR_CONTRACT_KIND_UNKNOWN" });

  const first = await hr.setContract({ who: "Samir", kind: "cdd", start: "02/11/2026", end: "30/04/2027" });
  assert.equal(first.trialEnd, "2026-11-15", "25 weeks: two weeks of trial at most");
  const cdi = await hr.setContract({ who: "Samir", kind: "cdi", start: "01/05/2027", category: "ouvrier" });
  assert.deepEqual(cdi.replaced, [first.number]);
  assert.equal(cdi.trialEnd, "2027-05-15");
  const state = await hr.state();
  assert.deepEqual(state.contracts.map((contract) => contract.status), ["remplace", "actif"]);

  await hr.leaveCompany("Samir", { endDate: "31/05/2027" });
  assert.equal((await hr.state()).contracts[1].status, "termine");
});

test("contracts ending, trials ending, trainings to renew and old candidates become RH alerts", async () => {
  const hr = await team();
  await hr.setContract({ who: "Samir", kind: "cdd", start: "02/11/2026", end: "25/11/2026" });
  await hr.setContract({ who: "Karim", kind: "cdi", start: "01/09/2024", trial: "23/11/2026" });
  const training = await hr.planTraining({ title: "Sécurité machines", who: "Samir, Karim", from: "10/11/2026", validUntil: "10/12/2026" });
  await hr.updateTraining(training.number, { status: "realisee" });

  const facts = hrFacts(await hr.state(), "2026-11-19");
  assert.deepEqual(facts.map((fact) => [fact.kind, fact.severity]), [["fin_contrat", "haute"], ["fin_essai", "moyenne"], ["formation_a_renouveler", "moyenne"]]);
  assert.match(facts[0].fact, /CDD de Samir Alaoui : fin le 25\/11\/2026 \(dans 6 jours\)/);
  assert.match(facts[1].fact, /renouveler l'essai une seule fois \(art\. 14/);
  assert.match(facts[2].fact, /Samir Alaoui, Karim Bennani : valable jusqu'au 10\/12\/2026/);
  assert.ok(facts.every((fact) => fact.source === "rh" && fact.owner === "hr"));

  // A new session of the same training clears the renewal; a renewed CDD
  // clears the end of contract.
  await hr.planTraining({ title: "sécurité machines", who: ["Samir Alaoui", "Karim"], from: "05/12/2026" });
  await hr.setContract({ who: "Samir", kind: "cdd", start: "26/11/2026", end: "25/05/2027" });
  assert.deepEqual(hrFacts(await hr.state(), "2026-11-19").map((fact) => fact.kind), ["fin_essai"]);

  // A CDD over and the employee still there is urgent.
  const later = hrFacts(await hr.state(), "2027-06-02").find((fact) => fact.kind === "fin_contrat");
  assert.equal(later.severity, "haute");
  assert.match(later.fact, /terminé le 25\/05\/2027, et Samir Alaoui est toujours dans l'équipe/);
});

test("recruitment keeps little about candidates, hires into the team, and erases on request or after a year", async () => {
  const hr = await team();
  const position = await hr.openPosition({ title: "Menuisier", kind: "cdi", category: "ouvrier", need: "Pour la charge de décembre" });
  await assert.rejects(hr.openPosition({ title: "menuisier" }), { code: "HR_POSITION_EXISTS" });
  const nadia = await hr.addCandidate({ position: position.number, name: "Nadia Exemple", phone: "06 00 00 00 01", source: "ANAPEC" });
  const rachid = await hr.addCandidate({ position: position.number, name: "Rachid Exemple", source: "bouche-à-oreille" });
  assert.equal(nadia.phone, "0600000001");
  await assert.rejects(hr.addCandidate({ position: position.number, name: "nadia exemple" }), { code: "HR_CANDIDATE_EXISTS" });
  await assert.rejects(hr.updateCandidate(nadia.number, { status: "entretien" }), { code: "HR_INTERVIEW_DATE_MISSING" });
  const interview = await hr.updateCandidate(nadia.number, { status: "entretien", interview: "24/11/2026", note: "5 ans en atelier" });
  assert.equal(interview.interview, "2026-11-24");

  // The direction sees the candidates; the others, the position alone.
  const seen = (await hr.overview()).positions[0];
  assert.deepEqual([seen.applications, seen.candidates.length, seen.candidates[0].label], [2, 2, "entretien prévu"]);
  const masked = await hr.overview({ confidential: false });
  assert.deepEqual([masked.positions[0].applications, masked.positions[0].candidates.length, masked.contracts.length], [2, 0, 0]);

  await assert.rejects(hr.updateCandidate(nadia.number, { status: "embauche" }), { code: "HR_START_MISSING" });
  const hired = await hr.updateCandidate(nadia.number, { status: "embauche", startDate: "01/12/2026" });
  assert.deepEqual([hired.employee.name, hired.employee.role, hired.employee.startDate], ["Nadia Exemple", "Menuisier", "2026-12-01"]);
  const state = await hr.state();
  assert.equal(state.positions[0].status, "pourvu");
  assert.equal(state.employees.filter((employee) => employee.active).length, 3);

  await hr.eraseCandidates(rachid.number);
  assert.deepEqual((await hr.state()).candidates.map((candidate) => candidate.name), ["Nadia Exemple"]);

  // A year after the position closed, its candidates' data is to be erased.
  const year = hrFacts(await hr.state(), "2027-11-20");
  assert.equal(year.find((fact) => fact.kind === "donnees_candidats").severity, "faible");
  assert.equal(hrFacts(await hr.state(), "2027-11-18").some((fact) => fact.kind === "donnees_candidats"), false);
});

test("the agents record contracts, recruitment and trainings in words, and only the direction touches contracts and candidates", async () => {
  const hr = await team();
  const books = { hr };
  const contract = await runHrTool("contrat_salarie", { salarie: "Samir", type: "cdd", debut: "02/11/2026", fin: "30/04/2027", categorie: "", fin_essai: "", note: "" }, { books, confidential: true }, "hiba");
  assert.equal(contract.ok, true);
  assert.match(contract.contrat, /CDD de Samir Alaoui, du 02\/11\/2026 au 30\/04\/2027/);
  assert.equal(contract.periode_d_essai, "jusqu'au 15/11/2026");
  const refused = await runHrTool("contrat_salarie", { salarie: "Karim", type: "cdi", debut: "01/09/2024", fin: "", categorie: "", fin_essai: "", note: "" }, { books, confidential: false }, "chef");
  assert.match(refused.erreur, /réservés à la direction/);
  const missing = await runHrTool("contrat_salarie", { salarie: "Karim", type: "cdd", debut: "01/09/2024", fin: "", categorie: "", fin_essai: "", note: "" }, { books, confidential: true }, "hiba");
  assert.match(missing.erreur, /a une date de fin/);

  const blank = { poste: "", numero: 0, nom: "", telephone: "", provenance: "", statut: "", date: "", contrat: "", categorie: "", note: "" };
  const opened = await runHrTool("recrutement", { ...blank, action: "ouvrir_poste", poste: "Commercial showroom", provenance: "Remplacer un départ" }, { books, confidential: true }, "hiba");
  assert.match(opened.poste, /n° 1 : Commercial showroom/);
  const candidate = await runHrTool("recrutement", { ...blank, action: "candidature", poste: "1", nom: "Salma Exemple", provenance: "Instagram" }, { books, confidential: true }, "hiba");
  assert.match(candidate.candidature, /n° 1 : Salma Exemple, poste Commercial showroom, via Instagram/);
  const hired = await runHrTool("recrutement", { ...blank, action: "suite_candidature", numero: 1, statut: "embauche", date: "07/12/2026" }, { books, confidential: true }, "hiba");
  assert.match(hired.equipe, /Salma Exemple ajouté\(e\) à l'équipe, Commercial showroom, entrée le 07\/12\/2026/);
  assert.match((await runHrTool("recrutement", { ...blank, action: "candidature", poste: "1", nom: "X" }, { books, confidential: false }, "chef")).erreur, /réservé à la direction/);

  const planned = await runHrTool("formation", { action: "planifier", numero: 0, intitule: "Vernis à l'eau", salaries: ["Karim"], du: "10/12/2026", au: "", organisme: "Fournisseur", valable_jusqu_au: "" }, { books, confidential: false }, "chef");
  assert.match(planned.formation, /« Vernis à l'eau » pour Karim Bennani, le 10\/12\/2026, par Fournisseur, planifiée/);
  const early = await runHrTool("formation", { action: "realisee", numero: 1, intitule: "", salaries: [], du: "", au: "", organisme: "", valable_jusqu_au: "" }, { books, confidential: false }, "chef");
  assert.match(early.erreur, /ne peut pas être déjà réalisée/);

  const overview = await runHrTool("equipe_rh", {}, { books, confidential: true }, "hiba");
  assert.ok(overview.contrats.some((line) => /Samir Alaoui : CDD n° 1/.test(line)));
  assert.ok(overview.contrats.some((line) => /Karim Bennani : aucun contrat noté/.test(line)));
  assert.match(overview.formations[0], /Vernis à l'eau/);
});

test("RH alerts reach Amélioration and are lifted when the contract is renewed", async () => {
  const hr = await team();
  await hr.setContract({ who: "Samir", kind: "cdd", start: "02/11/2026", end: "10/12/2026" });
  const improvement = createMemoryImprovementBook({ clock });
  const found = await improvement.sync([], { rh: await hr.facts() });
  assert.deepEqual(found.map((anomaly) => [anomaly.source, anomaly.kind, anomaly.owner]), [["rh", "fin_contrat", "hr"]]);
  await hr.setContract({ who: "Samir", kind: "cdi", start: "11/12/2026" });
  await improvement.sync([], { rh: await hr.facts() });
  const anomaly = (await improvement.state()).anomalies[0];
  assert.equal(anomaly.status, "levee");
  assert.match(anomaly.journal.at(-1).text, /carnet RH ne la montre plus/);
});

test("the direction-only tools refuse the others and serve the direction", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hr-director-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const followUpBook = createMemoryFollowUpBook({ clock });
  const run = async (confidential) => {
    const turns = [
      { output: [{ type: "function_call", name: "objectif_commercial", call_id: "o1", arguments: JSON.stringify({ mois: "12/2026", montant: "100000" }) }] },
      { output_text: "Fait.", output: [] }
    ];
    const calls = [];
    const agent = createDirectorAgent({ client: { responses: { create: async (payload) => (calls.push(JSON.parse(JSON.stringify(payload))), turns.shift()) } }, documentService: new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: dir }), followUpBook, clock });
    await agent.chat({ message: "Objectif de 100 000 DH en décembre.", confidential });
    return JSON.parse(calls.at(-1).input.find((item) => item.type === "function_call_output").output);
  };
  assert.match((await run(false)).erreur, /fixé par la direction seule/);
  assert.equal((await run(true)).ok, true);
  assert.equal((await followUpBook.state()).targets["2026-12"].amount, 100000);
});
