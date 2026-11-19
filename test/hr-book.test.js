import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { createMemoryHrBook, workingDays } from "../src/agent/hr-book.js";
import { hrTools, runHrTool } from "../src/agent/hr-tools.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

const clock = () => new Date("2026-11-19T09:00:00Z");

test("working days run Monday to Saturday, without Sundays or public holidays", () => {
  // 16 to 21 November 2026: Monday to Saturday, the 18th is Independence Day.
  assert.equal(workingDays("2026-11-16", "2026-11-22"), 5);
  assert.equal(workingDays("2026-03-20", "2026-03-20", [{ day: "2026-03-20", label: "Aïd al-Fitr" }]), 0);
});

test("paid leave follows the Code du travail: 1,5 day a month, more with seniority, nothing due before six months", async () => {
  const hr = createMemoryHrBook({ clock });
  await hr.addEmployee({ name: "Samir Alaoui", role: "menuisier", startDate: "03/03/2025" });
  await hr.addEmployee({ name: "Youssef Idrissi", role: "chef d'atelier", startDate: "01/09/2015" });
  await hr.addEmployee({ name: "Karim", role: "peintre", startDate: "01/09/2026" });
  await assert.rejects(hr.addEmployee({ name: "Nadia" }), { code: "HR_START_MISSING" });

  const { employees } = await hr.overview();
  const samir = employees.find((employee) => employee.name === "Samir Alaoui").leave;
  assert.deepEqual([samir.perYear, samir.earned, samir.taken, samir.eligible], [18, 12, 0, true], "8 full months since 03/03/2026 → 12 days");
  const youssef = employees.find((employee) => employee.name === "Youssef Idrissi").leave;
  assert.equal(youssef.perYear, 21, "two periods of five years: 18 + 3");
  assert.equal(employees.find((employee) => employee.name === "Karim").leave.eligible, false);

  const leave = await hr.requestLeave({ who: "Samir", from: "23/11/2026", to: "28/11/2026" });
  assert.deepEqual([leave.status, leave.days], ["demande", 6]);
  await assert.rejects(hr.requestLeave({ who: "samir alaoui", from: "25/11/2026", to: "26/11/2026" }), { code: "HR_LEAVE_OVERLAP" });
  const approved = await hr.decideLeave(leave.number, { decision: "approuve" });
  assert.equal(approved.balance.remaining, 6);
  await assert.rejects(hr.decideLeave(leave.number, { decision: "refuse" }), { code: "HR_LEAVE_DECIDED" });
});

test("absences, lateness and overtime make the month's payroll variables, with no amount", async () => {
  const hr = createMemoryHrBook({ clock });
  await hr.addEmployee({ name: "Samir", startDate: "03/03/2025" });
  await hr.record({ who: "Samir", kind: "absence", date: "10/11/2026", justified: true, reason: "maladie" });
  await hr.record({ who: "Samir", kind: "absence", date: "12/11/2026" });
  await assert.rejects(hr.record({ who: "Samir", kind: "absence", date: "12/11/2026" }), { code: "HR_DUPLICATE" });
  await assert.rejects(hr.record({ who: "Samir", kind: "absence", date: "25/11/2026" }), { code: "HR_DATE_FUTURE" });
  await hr.record({ who: "Samir", kind: "retard", date: "13/11/2026", hours: 0.5 });
  const overtime = await hr.record({ who: "Samir", kind: "heures_sup", date: "14/11/2026", hours: 3 });
  await hr.record({ who: "Samir", kind: "heures_sup", date: "17/11/2026", hours: 2 });
  await hr.cancelRecord(overtime.number, { reason: "noté deux fois" });
  const leave = await hr.requestLeave({ who: "Samir", from: "23/11/2026", to: "24/11/2026" });
  await hr.decideLeave(leave.number, { decision: "approuve" });

  const { rows, workingDays: open } = await hr.payroll("2026-11");
  assert.equal(open, 23, "30 days, 5 Sundays, the 6th and 18th");
  assert.deepEqual(rows[0], { name: "Samir", role: "", workingDays: 23, daysWorked: 19, absencesJustified: 1, absencesUnjustified: 1, leave: { annuel: 2 }, hoursLate: 0.5, overtimeHours: 2 });

  const masked = await hr.overview({ confidential: false });
  assert.equal(masked.recent.find((entry) => entry.kind === "absence" && entry.justified).reason, "", "the reason of an absence is for the direction");
});

test("the RH agent prepares but never decides a leave; the direction decides in the cockpit", async (t) => {
  const hr = createMemoryHrBook({ clock });
  const context = { books: { hr }, confidential: true };
  assert.equal(hrTools(context, "hr").some(({ tool }) => tool.name === "decider_conge"), false);
  assert.match((await runHrTool("equipe_rh", {}, context, "hr")).info, /carnet RH est vide/);
  assert.match((await runHrTool("ajouter_salarie", { nom: "Samir", poste: "menuisier", date_entree: "03/03/2025", telephone: "" }, context, "director")).ajoute, /Samir, menuisier, entré\(e\) le 03\/03\/2025/);
  const asked = await runHrTool("demander_conge", { salarie: "Samir", type: "annuel", du: "01/12/2026", au: "20/12/2026", note: "" }, context, "hr");
  assert.match(asked.alerte, /dépasse le solde acquis \(12 jours\)/);
  assert.match((await runHrTool("noter_presence", { salarie: "Inconnu", type: "absence", date: "", heures: 0, justifiee: false, motif: "" }, context, "hr")).erreur, /Aucun salarié « Inconnu »/);

  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), hrBook: hr, clock });
  t.after(() => app.close());
  const read = await inject({ method: "GET", url: "/api/hr" });
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().overview.pendingLeaves.length, 1);
  assert.equal(read.json().canDecide, true);
  const decided = await inject({ method: "POST", url: "/api/hr/leaves/1/decision", payload: { decision: "refuse" } });
  assert.equal(decided.statusCode, 200, decided.body);
  assert.equal(decided.json().leave.status, "refuse");
  assert.equal((await inject({ method: "POST", url: "/api/hr/leaves/9/decision", payload: { decision: "approuve" } })).statusCode, 404);

  const operator = await buildAuthenticatedApi({ repository: new InMemoryRepository(), hrBook: hr, clock, role: "operator" });
  t.after(() => operator.app.close());
  assert.equal((await operator.inject({ method: "POST", url: "/api/hr/leaves/1/decision", payload: { decision: "approuve" } })).statusCode, 403);
});
