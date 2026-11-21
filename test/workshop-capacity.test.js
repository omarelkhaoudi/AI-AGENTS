import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryRepository } from "../src/index.js";
import { HkidsDocumentService } from "../src/documents/document-service.js";
import { capacityFacts, createMemoryCapacityBook, workshopSchedule } from "../src/agent/workshop-capacity.js";
import { capacityTools, runCapacityTool } from "../src/agent/capacity-tools.js";
import { createMemoryImprovementBook } from "../src/agent/improvement-book.js";
import { createMemoryWorkshopStore } from "../src/agent/workshop-book.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

// Is a promised delivery compatible with the workshop's load (CDC V2 sections
// 5 and 9)? Invented orders and durations only. 21/11/2026 is a Saturday,
// a working day; Sundays and public holidays are not.
const IDS = ["etude_technique", "dessin_cnc", "approvisionnement", "decoupe_cnc", "assemblage", "finition", "controle_qualite", "livraison_installation"];
const steps = (overrides = {}) => IDS.map((id) => ({ id, label: id, status: "a_faire", plannedDate: null, startedDate: null, ...overrides[id] }));
const everyStep = (days, parallel = 1) => ({ steps: Object.fromEntries(IDS.map((id) => [id, { days, parallel }])) });
const today = "2026-11-21";

test("the durations are the direction's: a wrong one is refused, one left out stays, an empty one is removed", async () => {
  const book = createMemoryCapacityBook({ clock: () => new Date(`${today}T10:00:00Z`) });
  await assert.rejects(book.set({ sechage: { days: 2 } }), { code: "CAPACITY_STEP_UNKNOWN" });
  await assert.rejects(book.set({ assemblage: { days: "2,5" } }), { code: "CAPACITY_VALUE_INVALID" });
  await assert.rejects(book.set({ assemblage: { days: 3, parallel: 0 } }), { code: "CAPACITY_VALUE_INVALID" });
  let state = await book.set({ assemblage: { days: "3", parallel: "2" }, finition: { days: 2, parallel: "" } }, { by: "sara" });
  assert.deepEqual(state.steps, { assemblage: { days: 3, parallel: 2 }, finition: { days: 2, parallel: 1 } }, "one order at a time when not said");
  state = await book.set({ finition: { days: "" } });
  assert.deepEqual(state.steps, { assemblage: { days: 3, parallel: 2 } });
});

test("the orders are scheduled the earliest promise first; a step already started keeps its place", () => {
  const orders = [
    { number: "164", client: "Client A", finished: false, steps: steps({ etude_technique: { status: "terminee" }, dessin_cnc: { status: "en_cours", startedDate: "2026-11-18" }, livraison_installation: { plannedDate: "2026-12-05" } }) },
    { number: "165", client: "Client B", finished: false, steps: steps({ livraison_installation: { plannedDate: "2026-11-30" } }) },
    { number: "160", client: "Client C", finished: true, steps: steps() }
  ];
  const schedule = workshopSchedule(orders, everyStep(2), { today });
  assert.deepEqual(schedule.orders.map((entry) => [entry.number, entry.end, entry.verdict, entry.lateBy]), [
    ["165", "2026-12-09", "intenable", 8],
    ["164", "2026-12-11", "intenable", 5]
  ], "16 working days for 165 from Saturday 21/11, Sundays left out; 164's drawing ends today, then waits for 165 in each step");

  const two = workshopSchedule(orders, everyStep(2, 2), { today });
  assert.deepEqual(two.orders.map((entry) => [entry.number, entry.end, entry.verdict]), [["165", "2026-12-09", "intenable"], ["164", "2026-12-05", "tenable"]], "two at a time: no waiting, 164 ends on its promise");

  // 1er décembre is no holiday; add one and the end moves a day.
  const holiday = workshopSchedule(orders, everyStep(2, 2), { today, holidays: [{ day: "2026-11-30", label: "Exemple" }] });
  assert.equal(holiday.orders[0].end, "2026-12-10");

  const unknown = workshopSchedule(orders, { steps: { assemblage: { days: 2, parallel: 1 } } }, { today });
  assert.equal(unknown.orders[0].verdict, "inconnu");
  assert.ok(unknown.orders[0].missing.includes("etude_technique"), "a step without a duration is named, never guessed");
  assert.deepEqual(capacityFacts(unknown), []);

  const facts = capacityFacts(schedule);
  assert.deepEqual(facts.map((fact) => [fact.key, fact.kind, fact.owner, fact.severity]), [
    ["planning:bc:165:2026-11-30", "date_promise_intenable", "production", "haute"],
    ["planning:bc:164:2026-12-05", "date_promise_intenable", "production", "haute"]
  ]);
  assert.match(facts[0].fact, /BC n° 165 \(Client B\) : livraison promise le 30\/11\/2026, mais la charge de l'atelier mène à une fin estimée le 09\/12\/2026 \(8 jour\(s\) ouvrable\(s\) de plus\)/);
});

test("the promise held again lifts the alert; a new promise is a new alert", async () => {
  const improvement = createMemoryImprovementBook({ clock: () => new Date(`${today}T10:00:00Z`) });
  const late = [{ number: "165", client: "Client B", finished: false, steps: steps({ livraison_installation: { plannedDate: "2026-11-30" } }) }];
  const found = await improvement.sync([], { planning: capacityFacts(workshopSchedule(late, everyStep(2), { today })) });
  assert.equal(found.length, 1);
  const slower = { steps: { ...everyStep(2).steps, assemblage: { days: 4, parallel: 1 } } };
  assert.deepEqual(await improvement.sync([], { planning: capacityFacts(workshopSchedule(late, slower, { today })) }), [], "the same promise: no new alert");
  const anomalies = (await improvement.state()).anomalies;
  assert.equal(anomalies.length, 1);
  assert.match(anomalies[0].fact, /fin estimée le 11\/12\/2026 \(10 jour/, "the open alert says today's estimate");
  const moved = [{ ...late[0], steps: steps({ livraison_installation: { plannedDate: "2026-12-15" } }) }];
  assert.deepEqual(capacityFacts(workshopSchedule(moved, everyStep(2), { today })), [], "promised later: held");
  await improvement.sync([], { planning: [] });
  assert.equal((await improvement.state()).anomalies[0].status, "levee");
});

test("Commercial tries a date for a new sale and is told which orders it would delay", async () => {
  const orders = [{ number: "165", client: "Client B", finished: false, steps: steps({ livraison_installation: { plannedDate: "2026-12-10" } }) }];
  const capacity = createMemoryCapacityBook();
  await capacity.set(everyStep(2).steps);
  const context = { books: { capacity, hr: { state: async () => ({ holidays: [] }) } }, workshop: { book: async () => orders }, clock: () => new Date(`${today}T10:00:00Z`) };
  assert.deepEqual(capacityTools(context, "commercial").map((entry) => entry.tool.name), ["capacite_atelier"]);
  assert.deepEqual(capacityTools(context, "finance"), []);

  const early = await runCapacityTool("capacite_atelier", { date_souhaitee: "05/12/2026" }, context, "commercial");
  assert.match(early.nouvelle_commande, /fin estimée le 09\/12\/2026/, "promised first, the new order is scheduled first");
  assert.match(early.nouvelle_commande, /la date du 05\/12\/2026 n'est PAS tenable/);
  assert.match(early.nouvelle_commande, /elle ferait manquer leur date promise à : BC n° 165 \(Client B\), promis le 10\/12\/2026, fin estimée le 11\/12\/2026/);
  const later = await runCapacityTool("capacite_atelier", { date_souhaitee: "18/12/2026" }, context, "commercial");
  assert.match(later.nouvelle_commande, /fin estimée le 11\/12\/2026/, "promised later, it waits for BC 165 in each step");
  assert.match(later.nouvelle_commande, /la date du 18\/12\/2026 est tenable ; elle ne retarde aucune commande/);
  assert.match(later.rappel, /confirmer par l'atelier/);
  assert.equal((await runCapacityTool("capacite_atelier", { date_souhaitee: "demain" }, context, "commercial")).ok, false);
});

test("the direction sets the durations in the cockpit; a promise the workshop cannot hold is followed in Amélioration", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "capacite-atelier-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "bon_commande_HKIDS_166_2026-11-10.json"), JSON.stringify({ documentType: "purchase_order", documentNumber: "166", date: "10/11/2026", client: { name: "Client Exemple", address: "Fès" }, object: "Lit cabane", totals: { totalHt: 8000, tva: 1600, totalTtc: 9600 } }));
  const clock = () => new Date(`${today}T10:00:00Z`);
  const repository = new InMemoryRepository();
  const workshopStore = createMemoryWorkshopStore({ clock });
  await workshopStore.updateStep("166", "livraison_installation", { plannedDate: "24/11/2026", by: "sara" });
  const { app, inject } = await buildAuthenticatedApi({ repository, clock, workshopStore, documentService: new HkidsDocumentService({ repository, outputDir: dir }) });
  t.after(() => app.close());
  const operator = await createAuthenticatedUser(repository, { id: "karim", role: "operator" });

  assert.equal((await app.inject({ method: "PUT", url: "/api/workshop-capacity", payload: { steps: { assemblage: { days: 2 } } }, headers: operator.headers })).statusCode, 403);
  assert.equal((await inject({ method: "PUT", url: "/api/workshop-capacity", payload: { steps: { assemblage: { days: 0 } } } })).statusCode, 400);
  const saved = await inject({ method: "PUT", url: "/api/workshop-capacity", payload: { steps: Object.fromEntries(IDS.map((id) => [id, { days: "1" }])) } });
  assert.equal(saved.statusCode, 200, saved.body);

  const read = JSON.parse((await app.inject({ method: "GET", url: "/api/workshop-capacity", headers: operator.headers })).body);
  assert.equal(read.canDecide, false);
  assert.deepEqual(read.schedule.orders.map((entry) => [entry.number, entry.end, entry.verdict]), [["166", "2026-11-30", "intenable"]]);
  const improvement = JSON.parse((await app.inject({ method: "GET", url: "/api/improvement", headers: operator.headers })).body);
  const alert = improvement.anomalies.find((entry) => entry.source === "planning");
  assert.ok(alert, "followed in Amélioration like any anomaly");
  assert.deepEqual([alert.kind, alert.owner, alert.orderNumber], ["date_promise_intenable", "production", "166"]);
});
