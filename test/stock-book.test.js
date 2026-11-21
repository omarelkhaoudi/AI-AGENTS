import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { createMemoryStockBook, stockFacts } from "../src/agent/stock-book.js";
import { runStockTool, stockTools } from "../src/agent/stock-tools.js";
import { createMemoryImprovementBook } from "../src/agent/improvement-book.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

// The register of stock (CDC V1 section 1, V2 section 9). Invented materials,
// suppliers and prices only.
const today = new Date("2026-11-20T10:00:00Z");
const clock = () => today;

test("what is on hand is the sum of the movements; an exit never makes it negative", async () => {
  const stock = createMemoryStockBook({ clock });
  await assert.rejects(stock.addItem({ name: "MDF 18 mm", unit: "" }), { code: "STOCK_UNIT_MISSING" });
  const mdf = await stock.addItem({ name: "MDF 18 mm", unit: "panneau", minimum: "10", supplier: "Bois Exemple", leadTimeDays: "5" });
  assert.equal(mdf.minimum, 10);
  await assert.rejects(stock.addItem({ name: "mdf  18 MM", unit: "panneau" }), { code: "STOCK_ITEM_EXISTS" });
  await stock.addItem({ name: "Charnières invisibles", unit: "pièce" });

  const counted = await stock.record({ item: "MDF 18", kind: "inventaire", quantity: 14, date: "10/11/2026" });
  assert.deepEqual([counted.quantity, counted.counted, counted.before, counted.onHand], [14, 14, 0, 14]);
  await stock.record({ item: "MDF 18 mm", kind: "entree", quantity: "20", unitCost: "300", date: "12/11/2026", note: "BL 55" });
  await stock.record({ item: "MDF 18 mm", kind: "entree", quantity: 10, unitCost: "330,5" });
  const taken = await stock.record({ item: "mdf 18 mm", kind: "sortie", quantity: 6, orderNumber: "n° 164" });
  assert.deepEqual([taken.quantity, taken.orderNumber, taken.onHand], [-6, "164", 38]);
  await assert.rejects(stock.record({ item: "MDF 18 mm", kind: "sortie", quantity: 39 }), { code: "STOCK_NOT_ENOUGH" });
  await assert.rejects(stock.record({ item: "Charnières", kind: "sortie", quantity: 1 }), { code: "STOCK_NOT_ENOUGH" }, "nothing was ever counted");
  await assert.rejects(stock.record({ item: "MDF 18 mm", kind: "entree", quantity: 1, date: "21/11/2026" }), { code: "STOCK_DATE_FUTURE" });
  await assert.rejects(stock.record({ item: "contreplaqué", kind: "entree", quantity: 1 }), { code: "STOCK_ITEM_NOT_FOUND" });
  await assert.rejects(stock.updateItem("MDF 18 mm", { unit: "m²" }), { code: "STOCK_UNIT_LOCKED" });

  // An inventory records the difference it found.
  const recount = await stock.record({ item: "MDF 18 mm", kind: "inventaire", quantity: 36 });
  assert.deepEqual([recount.quantity, recount.onHand], [-2, 36]);

  const overview = await stock.overview();
  const line = overview.items.find((item) => item.name === "MDF 18 mm");
  assert.equal(line.onHand, 36);
  assert.equal(line.averageCost, 310.17, "weighted on the priced entries: (20 × 300 + 10 × 330,5) / 30");
  assert.equal(line.value, 11166.12);
  assert.equal(line.status, "ok");
  assert.deepEqual(overview.consumption, [{ orderNumber: "164", lines: [{ name: "MDF 18 mm", unit: "panneau", quantity: 6 }] }]);
  assert.equal(overview.unpriced, 0, "the hinges have none on hand: nothing to price");

  // A mistake is cancelled, not erased; it cannot leave the stock negative.
  await assert.rejects(stock.cancel(2, { reason: "" }), { code: "STOCK_REASON_MISSING" });
  const cancelled = await stock.cancel(4, { reason: "c'était pour le BC 165" });
  assert.equal(cancelled.onHand, 42);
  assert.deepEqual((await stock.overview()).consumption, []);
  await stock.record({ item: "MDF 18 mm", kind: "sortie", quantity: 40, orderNumber: "165" });
  await assert.rejects(stock.cancel(2, { reason: "erreur" }), { code: "STOCK_NOT_ENOUGH" });
});

test("a material under the minimum the direction set is an alert for Achats, lifted once it is back", async () => {
  let now = new Date("2026-11-20T08:00:00Z");
  const stock = createMemoryStockBook({ clock: () => now });
  const improvement = createMemoryImprovementBook({ clock: () => now });
  await stock.addItem({ name: "MDF 18 mm", unit: "panneau", minimum: 10, supplier: "Bois Exemple", leadTimeDays: 5 });
  await stock.addItem({ name: "Vernis", unit: "litre" });
  await stock.record({ item: "MDF 18 mm", kind: "inventaire", quantity: 8 });
  await stock.record({ item: "Vernis", kind: "inventaire", quantity: 0 });

  const facts = stockFacts(await stock.overview());
  assert.equal(facts.length, 1, "a material without a minimum is never judged");
  assert.deepEqual([facts[0].kind, facts[0].severity, facts[0].owner], ["stock_sous_minimum", "moyenne", "purchasing"]);
  assert.match(facts[0].fact, /MDF 18 mm : 8 panneaux en stock, au niveau ou sous le minimum de 10 panneaux. Délai du fournisseur Bois Exemple : 5 jour\(s\), commandé aujourd'hui il arrive vers le 25\/11\/2026\./);
  const found = await improvement.sync([], { stock: facts });
  assert.equal(found.length, 1);
  await improvement.sync([]);
  assert.equal((await improvement.state()).anomalies.filter((entry) => entry.status !== "levee").length, 1, "a read of the workshop alone lifts no stock alert");

  await stock.record({ item: "MDF 18 mm", kind: "sortie", quantity: 8, orderNumber: "164" });
  const empty = stockFacts(await stock.overview());
  assert.deepEqual([empty[0].kind, empty[0].severity], ["rupture_stock", "haute"]);
  now = new Date("2026-11-21T08:00:00Z");
  await improvement.sync([], { stock: empty });
  const anomalies = (await improvement.state()).anomalies;
  assert.equal(anomalies.find((entry) => entry.kind === "stock_sous_minimum").status, "levee", "the minimum alert gives way to the rupture");
  const rupture = anomalies.find((entry) => entry.kind === "rupture_stock");

  // Ordered: marked dealt with, it stays so until the delivery is noted.
  await improvement.lift(rupture.number, { by: "sara" });
  assert.deepEqual(await improvement.sync([], { stock: empty }), []);
  await stock.record({ item: "MDF 18 mm", kind: "entree", quantity: 20 });
  assert.deepEqual(stockFacts(await stock.overview()), []);
  await improvement.sync([], { stock: [] });
  assert.match((await improvement.state()).anomalies.find((entry) => entry.kind === "rupture_stock").journal.at(-1).text, /Anomalie levée|ne la montre plus/);
});

test("Achats keeps the register; Production only reads it and notes what it takes", async () => {
  const stock = createMemoryStockBook({ clock });
  const logged = [];
  const books = { stock, team: { log: async (entry) => logged.push(entry) } };
  assert.deepEqual(stockTools({ books }, "purchasing").map((entry) => entry.tool.name), ["registre_stock", "matiere_stock", "mouvement_stock", "annuler_mouvement_stock"]);
  assert.deepEqual(stockTools({ books }, "production").map((entry) => entry.tool.name), ["registre_stock", "mouvement_stock"]);
  assert.deepEqual(stockTools({ books }, "commercial"), []);

  assert.match((await runStockTool("registre_stock", {}, { books }, "purchasing")).info, /registre de stock est vide/);
  const added = await runStockTool("matiere_stock", { action: "ajouter", matiere: "MDF 18 mm", unite: "panneau", minimum: "", fournisseur: "", delai_jours: "" }, { books }, "purchasing");
  assert.equal(added.ok, true);
  assert.match(added.suite, /Pas de minimum/);
  const refused = await runStockTool("mouvement_stock", { matiere: "MDF 18 mm", type: "sortie", quantite: 3, date: "", bon_commande: "164", fournisseur: "", prix_unitaire_ht: "", note: "" }, { books }, "production");
  assert.equal(refused.ok, false);
  assert.match(refused.erreur, /ne connaît que 0 panneau/);
  await runStockTool("mouvement_stock", { matiere: "MDF 18 mm", type: "entree", quantite: 12, date: "", bon_commande: "", fournisseur: "Bois Exemple", prix_unitaire_ht: "305", note: "" }, { books }, "purchasing");
  const out = await runStockTool("mouvement_stock", { matiere: "MDF 18 mm", type: "sortie", quantite: 3, date: "", bon_commande: "164", fournisseur: "", prix_unitaire_ht: "", note: "" }, { books }, "production");
  assert.equal(out.en_stock, "9 panneaux");
  assert.match(out.ligne, /Sortie de 3 panneaux de MDF 18 mm pour le BC n° 164/);
  assert.deepEqual(logged.map((entry) => entry.agent), ["purchasing", "production"]);
  const changed = await runStockTool("matiere_stock", { action: "modifier", matiere: "MDF 18 mm", unite: "", minimum: "10", fournisseur: "", delai_jours: "5" }, { books }, "purchasing");
  assert.match(changed.modifiee, /minimum 10 panneaux, fournisseur Bois Exemple, délai 5 j/);
  const register = await runStockTool("registre_stock", {}, { books }, "purchasing");
  assert.deepEqual(register.a_commander, ["MDF 18 mm : 9 panneaux pour un minimum de 10 panneaux ; commandé aujourd'hui, arrive vers le 25/11/2026"]);
  assert.equal(register.valeur_du_stock_ht, "2745 DH");
});

test("the cockpit reads the register, and a material to order is followed in Amélioration", async (t) => {
  const repository = new InMemoryRepository();
  const stockBook = createMemoryStockBook({ clock });
  await stockBook.addItem({ name: "MDF 18 mm", unit: "panneau", minimum: 10 });
  await stockBook.record({ item: "MDF 18 mm", kind: "inventaire", quantity: 4 });
  const { app } = await buildAuthenticatedApi({ repository, clock, stockBook });
  t.after(() => app.close());
  const operator = await createAuthenticatedUser(repository, { id: "karim", role: "operator" });

  assert.equal((await app.inject({ method: "GET", url: "/api/stock" })).statusCode, 401);
  const read = await app.inject({ method: "GET", url: "/api/stock", headers: operator.headers });
  assert.equal(read.statusCode, 200, read.body);
  const { overview } = JSON.parse(read.body);
  assert.deepEqual(overview.alerts.map((item) => [item.name, item.onHand, item.status]), [["MDF 18 mm", 4, "sous_minimum"]]);

  const improvement = JSON.parse((await app.inject({ method: "GET", url: "/api/improvement", headers: operator.headers })).body);
  const alert = improvement.anomalies.find((entry) => entry.source === "stock");
  assert.ok(alert, "followed in Amélioration like any anomaly");
  assert.equal(alert.owner, "purchasing");
});
