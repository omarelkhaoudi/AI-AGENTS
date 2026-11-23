import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { SPECIALIST_IDS } from "../src/agent/agent-team.js";
import { createMemoryImprovementBook } from "../src/agent/improvement-book.js";
import { createMemoryTeamBook } from "../src/agent/team-book.js";
import { minutesPerMissionFromEnv, pilotIndicators, pilotPeriod } from "../src/agent/pilot-indicators.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

// The pilot's indicators (CDC V2 annex): counted from the books, a dash when
// there is nothing to count. Invented orders and anomalies only.
const step = (id, status, plannedDate, doneDate = null, late = false) => ({ id, status, plannedDate, doneDate, late });

test("the seven indicators are counted from the books, over the period only", () => {
  const orders = [
    // Finished on time in the period.
    { number: "201", date: "02/11/2026", finished: true, steps: [step("decoupe", "terminee", "2026-11-05", "2026-11-04"), step("livraison", "terminee", "2026-11-10", "2026-11-10")] },
    // Finished late in the period.
    { number: "202", date: "03/11/2026", finished: true, steps: [step("livraison", "terminee", "2026-11-08", "2026-11-12")] },
    // In progress, past its planned date.
    { number: "203", date: "05/11/2026", finished: false, steps: [step("assemblage", "en_cours", "2026-11-15", null, true)] },
    // Finished before the period: not counted.
    { number: "150", date: "01/09/2026", finished: true, steps: [step("livraison", "terminee", "2026-09-10", "2026-09-20")] }
  ];
  const anomalies = [
    { number: 1, kind: "retard", severity: "moyenne", status: "levee", detectedAt: "2026-11-09T08:00:00Z", liftedAt: "2026-11-12T08:00:00Z" },
    { number: 2, kind: "blocage", severity: "haute", status: "levee", detectedAt: "2026-11-10T08:00:00Z", liftedAt: "2026-11-11T08:00:00Z" },
    { number: 3, kind: "retard", severity: "moyenne", status: "a_analyser", detectedAt: "2026-11-16T08:00:00Z" },
    { number: 4, kind: "retard", severity: "moyenne", status: "levee", detectedAt: "2026-11-17T08:00:00Z", liftedAt: "2026-11-17T09:00:00Z", falseAlarm: { at: "2026-11-17T09:00:00Z", note: "étape finie, pas cochée" } },
    { number: 5, kind: "retard", severity: "moyenne", status: "levee", detectedAt: "2026-09-01T08:00:00Z", liftedAt: "2026-09-02T08:00:00Z" }
  ];
  const rules = [
    { number: 1, title: "Vérifier le stock avant lancement", status: "active", proposedAt: "2026-11-10T09:00:00Z", recurrences: [{ at: "2026-11-16T08:00:00Z", anomaly: 3 }] },
    { number: 2, title: "Appeler le client la veille", status: "refusee", proposedAt: "2026-11-11T09:00:00Z" },
    { number: 3, title: "Photo avant emballage", status: "retiree", proposedAt: "2026-11-12T09:00:00Z" },
    { number: 4, title: "Double contrôle des cotes", status: "proposee", proposedAt: "2026-11-18T09:00:00Z" }
  ];
  const missions = [{ at: "2026-11-02" }, { at: "2026-11-03" }, { at: "2026-11-03" }, { at: "2026-10-01" }];
  const result = pilotIndicators({ anomalies, rules, orders, missions, from: "2026-11-01", to: "2026-11-20", today: new Date("2026-11-20T10:00:00Z"), minutesPerMission: 20 });

  assert.deepEqual(result.period, { from: "2026-11-01", to: "2026-11-20", days: 20 });
  assert.deepEqual([result.lateOrders.late, result.lateOrders.worked, result.lateOrders.percent, result.lateOrders.numbers], [2, 3, 66.7, ["202", "203"]]);
  assert.deepEqual([result.resolution.resolved, result.resolution.averageDays, result.resolution.stillOpen], [2, 2, 1], "3 days and 1 day; the false alarm is not a resolution");
  assert.deepEqual([result.anomalies.detected, result.anomalies.byKind, result.anomalies.severe], [3, { retard: 2, blocage: 1 }, 1]);
  assert.deepEqual([result.procedures.approved, result.procedures.refused, result.procedures.pending, result.procedures.percent], [2, 1, 1, 66.7], "a rule withdrawn later had been approved");
  assert.deepEqual([result.recurrence.count, result.recurrence.percent], [1, 33.3]);
  assert.deepEqual([result.timeSaved.missions, result.timeSaved.hours], [3, 1]);
  assert.deepEqual([result.falseAlarms.count, result.falseAlarms.percent], [1, 25]);

  const empty = pilotIndicators({ from: "2026-11-01", to: "2026-11-20" });
  assert.deepEqual([empty.lateOrders.percent, empty.resolution.averageDays, empty.procedures.percent, empty.falseAlarms.percent, empty.timeSaved.hours], [null, null, null, null, null], "nothing to count is a dash, not a zero");
});

test("the period defaults to the last 30 days, or from the pilot's start; the minutes are the direction's", () => {
  const today = new Date("2026-11-20T10:00:00Z");
  assert.deepEqual(pilotPeriod({ today }), { from: "2026-10-22", to: "2026-11-20" });
  assert.deepEqual(pilotPeriod({ today, start: "2026-11-05" }), { from: "2026-11-05", to: "2026-11-20" });
  assert.deepEqual(pilotPeriod({ today, from: "20/11/2026", to: "2026-11-01" }), { from: "2026-11-01", to: "2026-11-20" });
  assert.equal(minutesPerMissionFromEnv({}), null);
  assert.equal(minutesPerMissionFromEnv({ HKIDS_PILOT_MINUTES_PER_MISSION: "12,5" }), 12.5);
  assert.equal(minutesPerMissionFromEnv({ HKIDS_PILOT_MINUTES_PER_MISSION: "-3" }), null);
});

test("a false alarm leaves the anomalies, stays dismissed while the book shows it, and a new fact is a new anomaly", async () => {
  let now = new Date("2026-11-18T08:00:00Z");
  const book = createMemoryImprovementBook({ clock: () => now });
  const late = [{ number: "204", client: "Client Exemple", steps: [{ id: "assemblage", label: "Assemblage", status: "en_cours", plannedDate: "2026-11-15", late: true }] }];
  const [found] = await book.sync(late);
  await assert.rejects(book.dismiss(found.number, { note: " " }), { code: "IMPROVEMENT_FALSE_ALARM_NOTE_MISSING" });
  const dismissed = await book.dismiss(found.number, { note: "assemblage fini, pas coché", by: "sara" });
  assert.equal(dismissed.status, "levee");
  assert.equal(dismissed.falseAlarm.note, "assemblage fini, pas coché");
  await assert.rejects(book.dismiss(found.number, { note: "encore" }), { code: "IMPROVEMENT_FALSE_ALARM_ALREADY" });

  assert.deepEqual(await book.sync(late), [], "not found again while the book still shows it");
  now = new Date("2026-11-19T08:00:00Z");
  await book.sync([]);
  now = new Date("2026-11-25T08:00:00Z");
  const [again] = await book.sync(late);
  assert.ok(again, "the fact came back after it was gone: a new anomaly");
  assert.notEqual(again.number, found.number);
});

test("the cockpit shows the indicators to the team; only the direction marks a false alarm", async (t) => {
  const repository = new InMemoryRepository();
  const clock = () => new Date("2026-11-20T10:00:00Z");
  const improvementBook = createMemoryImprovementBook({ clock });
  const teamBook = createMemoryTeamBook({ clock, agents: SPECIALIST_IDS });
  // An empty folder of documents: none of this machine's documents counts.
  const dir = await mkdtemp(join(tmpdir(), "pilote-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { app, inject } = await buildAuthenticatedApi({ repository, clock, improvementBook, teamBook, pilotStart: "2026-11-01", minutesPerMission: 15, documentService: new HkidsDocumentService({ repository, outputDir: dir }) });
  t.after(() => app.close());
  const reported = await improvementBook.report({ fact: "Livraison du BC 205 oubliée au planning", area: "retard", agent: "production" });
  await improvementBook.report({ fact: "Rayure signalée par le client du BC 206", area: "qualite", agent: "production" });
  for (let index = 0; index < 4; index += 1) {
    await teamBook.log({ agent: "commercial", kind: "mission", text: `Mission ${index}`, by: "director" });
  }

  const operator = await createAuthenticatedUser(repository, { id: "karim", role: "operator" });
  const refused = await app.inject({ method: "POST", url: `/api/improvement/anomalies/${reported.number}/false-alarm`, payload: { note: "doublon" }, headers: operator.headers });
  assert.equal(refused.statusCode, 403);
  assert.equal((await inject({ method: "POST", url: `/api/improvement/anomalies/${reported.number}/false-alarm`, payload: {} })).statusCode, 400);
  const marked = await inject({ method: "POST", url: `/api/improvement/anomalies/${reported.number}/false-alarm`, payload: { note: "livraison bien planifiée, saisie en double" } });
  assert.equal(marked.statusCode, 200, marked.body);
  assert.equal((await inject({ method: "POST", url: "/api/improvement/anomalies/99/false-alarm", payload: { note: "x" } })).statusCode, 404);

  const read = await app.inject({ method: "GET", url: "/api/improvement/pilot", headers: operator.headers });
  assert.equal(read.statusCode, 200, read.body);
  const { indicators, pilotStart } = JSON.parse(read.body);
  assert.equal(pilotStart, "2026-11-01");
  assert.deepEqual(indicators.period, { from: "2026-11-01", to: "2026-11-20", days: 20 });
  assert.deepEqual([indicators.anomalies.detected, indicators.falseAlarms.count, indicators.falseAlarms.percent], [1, 1, 50]);
  assert.deepEqual([indicators.timeSaved.missions, indicators.timeSaved.minutesPerMission, indicators.timeSaved.hours], [4, 15, 1]);
  const narrowed = JSON.parse((await inject({ method: "GET", url: "/api/improvement/pilot?from=2026-11-01&to=2026-11-10" })).body).indicators;
  assert.equal(narrowed.anomalies.detected, 0, "the period narrows what is counted");

  const feed = JSON.parse((await inject({ method: "GET", url: "/api/team" })).body).activity.map((entry) => entry.text);
  assert.ok(feed.some((line) => /fausse alerte/.test(line)));
});

test("the missions are counted per day, beyond the feed's last lines", async () => {
  let now = new Date("2026-11-01T08:00:00Z");
  const team = createMemoryTeamBook({ clock: () => now, agents: SPECIALIST_IDS });
  for (let index = 0; index < 650; index += 1) {
    now = new Date(Date.parse("2026-11-01T08:00:00Z") + index * 60_000);
    await team.log({ agent: "finance", kind: index % 2 === 0 ? "mission" : "caisse", text: `ligne ${index}`, by: "director" });
  }
  assert.deepEqual(await team.missionsByDay(), { "2026-11-01": 325 });
  assert.equal((await team.activity({ limit: 10_000 })).length, 600, "the feed keeps its last lines only");
});
