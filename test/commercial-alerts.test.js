import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryRepository } from "../src/index.js";
import { HkidsDocumentService } from "../src/documents/document-service.js";
import { summarizeIssuedContent } from "../src/documents/document-ledger.js";
import { clientKey, commercialFacts, readCommercialRules } from "../src/agent/commercial-alerts.js";
import { createMemoryImprovementBook } from "../src/agent/improvement-book.js";
import { createMemoryFollowUpBook } from "../src/agent/sales-book.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

// The commercial alerts of CDC V2 section 5 the follow-ups did not give.
// Invented clients and documents only.
const quote = (number, date, client, totalTtc, discountPercent = null) => ({ type: "quote", number: String(number), date, client, object: "Lit cabane", totalTtc, discountPercent, quoteReference: "" });
const order = (number, date, client, totalTtc, quoteReference, discountPercent = null) => ({ type: "purchase_order", number: String(number), date, client, object: "Lit cabane", totalTtc, discountPercent, quoteReference });
const today = new Date("2026-11-20T10:00:00Z");
const EMPTY_STATE = { quotes: {}, notified: {} };

test("each alert is a fact of the documents, and a rule not set gives none", () => {
  const issued = [
    quote(170, "01/10/2026", "Mme Salma Exemple", 12000),
    quote(171, "15/11/2026", "Karim Exemple", 9000, 18),
    quote(172, "01/09/2026", "Nadia Exemple", 15000),
    order(166, "05/09/2026", "Nadia Exemple", 14000, "172"),
    quote(173, "02/10/2026", "salma exemple", 8000)
  ];
  assert.deepEqual(commercialFacts(issued, EMPTY_STATE, { today }).map((entry) => entry.kind).sort(), ["client_en_double", "ecart_devis_commande"], "without rules: only what is always wrong");

  const margins = { orders: [
    { number: "166", client: "Nadia Exemple", finished: true, measurable: true, rate: 12.5, costLines: 3 },
    { number: "167", client: "Autre Exemple", finished: false, measurable: true, rate: 5, costLines: 1 }
  ] };
  const facts = commercialFacts(issued, EMPTY_STATE, { today, rules: { validityDays: 30, maxDiscountPercent: 10, marginFloorPercent: 20 }, margins });
  const byKind = (kind) => facts.filter((entry) => entry.kind === kind);
  assert.deepEqual(byKind("devis_expire").map((entry) => entry.key).sort(), ["commercial:devis:170:expire", "commercial:devis:173:expire"]);
  assert.match(byKind("devis_expire").find((entry) => entry.key.includes(":170:")).fact, /expiré depuis le 31\/10\/2026 \(validité 30 jours\)/);
  assert.equal(byKind("devis_expire").some((entry) => entry.key.includes(":172:")), false, "an ordered quote does not expire");
  assert.deepEqual(byKind("remise_hors_plafond").map((entry) => [entry.key, entry.severity]), [["commercial:devis:171:remise", "haute"]]);
  assert.match(byKind("remise_hors_plafond")[0].fact, /remise de 18 %, au-delà du plafond de 10 %/);
  assert.deepEqual(byKind("marge_sous_seuil").map((entry) => [entry.orderNumber, entry.owner]), [["166", "finance"]], "only a finished order is judged on its margin");
  assert.match(byKind("ecart_devis_commande")[0].fact, /14 000,00 DH TTC, alors que le devis n° 172 est de 15 000,00 DH TTC/);
  assert.match(byKind("client_en_double")[0].fact, /« Mme Salma Exemple », « salma exemple »/);

  const lost = { quotes: { 170: { followUps: [], lost: { day: "2026-10-20", reason: "prix" } } }, notified: {} };
  assert.equal(commercialFacts(issued, lost, { today, rules: { validityDays: 30 } }).some((entry) => entry.key === "commercial:devis:170:expire"), false, "a lost quote does not expire");
});

test("a client is told by its name, not by its civility, accents or word order", () => {
  assert.equal(clientKey("Mme Rotbi Mouna"), clientKey("MOUNA  rotbi"));
  assert.equal(clientKey("Hélène Exemple"), clientKey("helene exemple"));
  assert.notEqual(clientKey("Salma Exemple"), clientKey("Salma Autre"));
  assert.equal(clientKey("Mme"), "");
  assert.deepEqual(readCommercialRules({ validityDays: "30", maxDiscountPercent: "7,5", marginFloorPercent: "" }), { rules: { validityDays: 30, maxDiscountPercent: 7.5 }, errors: [] });
  assert.equal(readCommercialRules({ validityDays: "2.5", maxDiscountPercent: "140" }).errors.length, 2);
});

test("the discount of an issued document is read from its lines and its totals", () => {
  const summary = summarizeIssuedContent({ type: "quote", number: "180", stem: "devis_HKIDS_180_x" }, {
    date: "01/11/2026", client: { name: "Client Exemple", address: "Marrakech" },
    items: [{ designation: "Lit", unit: "U", quantity: 2, unitPriceHt: 5000, discountPercent: 10, amountHt: 9000 }],
    totals: { totalHt: 9000, tva: 1800, totalTtc: 10800 }
  });
  assert.equal(summary.discountPercent, 10);
});

test("the alerts become anomalies, are lifted when no longer true, and one dealt with stays so", async () => {
  let now = new Date("2026-11-20T08:00:00Z");
  const book = createMemoryImprovementBook({ clock: () => now });
  const expired = { source: "commercial", key: "commercial:devis:170:expire", kind: "devis_expire", severity: "moyenne", owner: "commercial", client: "Client Exemple", orderNumber: "", step: null, fact: "Devis n° 170 expiré" };
  const twin = { ...expired, key: "commercial:client:exemple", kind: "client_en_double", severity: "faible", fact: "Client écrit de 2 façons" };
  const found = await book.sync([], { commercial: [expired, twin] });
  assert.deepEqual(found.map((entry) => [entry.kind, entry.severity, entry.owner]), [["devis_expire", "moyenne", "commercial"], ["client_en_double", "faible", "commercial"]]);

  await book.sync([]);
  assert.equal((await book.state()).anomalies.filter((entry) => entry.status !== "levee").length, 2, "a read of the workshop alone lifts no commercial alert");

  await book.lift(found[1].number, { by: "sara" });
  now = new Date("2026-11-21T08:00:00Z");
  assert.deepEqual(await book.sync([], { commercial: [expired, twin] }), [], "dealt with: not raised again while the documents show it");

  await book.sync([], { commercial: [twin] });
  const lifted = (await book.state()).anomalies.find((entry) => entry.key === expired.key);
  assert.equal(lifted.status, "levee", "the quote no longer expired (ordered or lost): lifted by itself");
  assert.match(lifted.journal.at(-1).text, /Les documents ne la montrent plus/);
});

test("the direction sets the rules in the cockpit; the alerts follow, read by everyone", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "alertes-commerciales-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const write = (name, content) => writeFile(join(dir, name), JSON.stringify(content));
  const client = { name: "Client Exemple", address: "12 rue Exemple, Fès" };
  await write("devis_HKIDS_170_2026-10-01.json", { documentType: "quote", documentNumber: "170", date: "01/10/2026", client, object: "Lit cabane", items: [{ designation: "Lit cabane", unit: "U", quantity: 1, unitPriceHt: 10000, discountPercent: 15, amountHt: 8500 }], totals: { totalHt: 8500, tva: 1700, totalTtc: 10200 } });
  await write("bon_commande_HKIDS_166_2026-10-05.json", { documentType: "purchase_order", documentNumber: "166", date: "05/10/2026", client: { ...client, name: "client exemple" }, object: "Lit cabane", quoteReference: "170", totals: { totalHt: 8000, tva: 1600, totalTtc: 9600 } });

  const repository = new InMemoryRepository();
  const clock = () => today;
  const followUpBook = createMemoryFollowUpBook({ clock });
  const { app, inject } = await buildAuthenticatedApi({ repository, clock, followUpBook, documentService: new HkidsDocumentService({ repository, outputDir: dir }) });
  t.after(() => app.close());

  let listed = JSON.parse((await inject({ method: "GET", url: "/api/commercial" })).body);
  assert.deepEqual(listed.alerts.map((entry) => entry.kind).sort(), ["client_en_double", "ecart_devis_commande"]);

  const operator = await createAuthenticatedUser(repository, { id: "karim", role: "operator" });
  assert.equal((await app.inject({ method: "PUT", url: "/api/commercial/rules", payload: { maxDiscountPercent: "5" }, headers: operator.headers })).statusCode, 403);
  const invalid = await inject({ method: "PUT", url: "/api/commercial/rules", payload: { validityDays: "0" } });
  assert.equal(invalid.statusCode, 400);
  assert.equal(JSON.parse(invalid.body).details.code, "COMMERCIAL_RULES_INVALID");

  const saved = await inject({ method: "PUT", url: "/api/commercial/rules", payload: { maxDiscountPercent: "10", validityDays: "", marginFloorPercent: "" } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(JSON.parse((await app.inject({ method: "GET", url: "/api/commercial/rules", headers: operator.headers })).body).rules.maxDiscountPercent, 10);
  listed = JSON.parse((await inject({ method: "GET", url: "/api/commercial" })).body);
  const discount = listed.alerts.find((entry) => entry.kind === "remise_hors_plafond");
  assert.ok(discount, "the discount of 15 % is now over the ceiling");
  assert.equal(discount.severity, "haute");
  assert.match(discount.fact, /Devis n° 170 \(Client Exemple\) : remise de 15 %/);

  const improvement = JSON.parse((await app.inject({ method: "GET", url: "/api/improvement", headers: operator.headers })).body);
  assert.ok(improvement.anomalies.some((entry) => entry.source === "commercial" && entry.kind === "remise_hors_plafond"), "followed in Amélioration like any anomaly");
});
