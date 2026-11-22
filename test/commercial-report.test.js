import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { commercialReport, previousPeriod } from "../src/agent/commercial-report.js";
import { attributeQuote, commercialAnalysisFor, salesTools, setSalesTarget } from "../src/agent/company-tools.js";
import { createMemoryFollowUpBook } from "../src/agent/sales-book.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

// The complete commercial report (CDC V2 section 5, « Bilans interactifs »).
// Invented clients, sellers, campaigns and amounts only.

const TODAY = new Date("2026-11-25T10:00:00Z");
const ISSUED = [
  { type: "quote", number: "170", date: "03/11/2026", client: "Client A", object: "Lit cabane", totalTtc: 12000 },
  { type: "quote", number: "171", date: "05/11/2026", client: "Client B", object: "lit  CABANE", totalTtc: 9000 },
  { type: "quote", number: "172", date: "10/11/2026", client: "Client C", object: "Bureau enfant", totalTtc: 4000 },
  { type: "quote", number: "165", date: "20/10/2026", client: "Client D", object: "Bureau enfant", totalTtc: 5000 },
  { type: "purchase_order", number: "166", date: "06/11/2026", client: "Client A", totalTtc: 12000, quoteReference: "170" },
  { type: "purchase_order", number: "160", date: "25/10/2026", client: "Client D", totalTtc: 5000, quoteReference: "165" },
  { type: "invoice", number: "80", date: "07/11/2026", client: "Client A", totalTtc: 7200, quoteReference: "170" },
  { type: "invoice", number: "81", date: "12/11/2026", client: "Client E", totalTtc: 1000 },
  { type: "credit_note", number: "5", date: "14/11/2026", client: "Client A", totalTtc: 1200, invoiceReference: "80" }
];
const ENTRIES = [
  { number: 1, kind: "entree", category: "acompte_client", amount: 7200, day: "2026-11-07", orderNumber: "166" },
  { number: 2, kind: "entree", category: "solde_client", amount: 2000, day: "2026-11-15", quoteNumber: "165" },
  { number: 3, kind: "entree", category: "vente_comptant", amount: 300, day: "2026-11-16" },
  { number: 4, kind: "entree", category: "apport", amount: 5000, day: "2026-11-16" },
  { number: 5, kind: "entree", category: "acompte_client", amount: 999, day: "2026-11-16", orderNumber: "166", cancelled: true },
  { number: 6, kind: "entree", category: "acompte_client", amount: 3000, day: "2026-10-26", orderNumber: "160" }
];
const PROSPECTS = [
  { id: "P-001", reseau: "instagram", status: "devis", createdAt: "2026-11-02T09:00:00Z", produit: "Lit cabane" },
  { id: "P-002", reseau: "facebook", status: "nouveau", createdAt: "2026-11-20T09:00:00Z" },
  { id: "P-003", reseau: "instagram", status: "perdu", createdAt: "2026-10-12T09:00:00Z" }
];

async function salesBook() {
  const book = createMemoryFollowUpBook({ clock: () => TODAY });
  await book.attribute("170", { channel: "Instagram", seller: "Nadia", campaign: "Rentrée" }, { by: "sara" });
  await book.attribute("171", { channel: "showroom", seller: "Nadia" });
  await book.record("172", { channel: "telephone", day: "18/11/2026", lost: true, reason: "trop cher" });
  await book.setTarget("2026-11", "40 000");
  return book;
}

test("the previous period is the same length, just before", () => {
  assert.deepEqual(previousPeriod("2026-11-01", "2026-11-30"), { from: "2026-10-02", to: "2026-10-31" });
  assert.deepEqual(previousPeriod("2026-11-16", "2026-11-22"), { from: "2026-11-09", to: "2026-11-15" });
});

test("CA commandé, facturé and encaissé apart, each axis with its documents, against the month before and the target", async () => {
  const followUps = await (await salesBook()).state();
  const report = commercialReport({ issued: ISSUED, followUps, entries: ENTRIES, prospects: PROSPECTS, from: "2026-11-01", to: "2026-11-30", today: TODAY });
  const t = report.totals;
  assert.deepEqual([t.prospects, t.issued.count, t.issued.totalTtc, t.signed.count, t.signed.totalTtc, t.conversion], [2, 3, 25000, 1, 12000, 33]);
  assert.equal(t.invoiced.totalTtc, 7000, "7 200 + 1 000 less the credit note of 1 200");
  assert.deepEqual(t.invoiced.refs, ["facture 80", "facture 81", "avoir 5"]);
  assert.equal(t.paid.total, 9500, "a contribution and a cancelled line are no sale paid");
  assert.equal(t.lost.count, 1);
  const p = report.previous.totals;
  assert.deepEqual([report.previous.from, p.prospects, p.issued.count, p.signed.totalTtc, p.paid.total], ["2026-10-02", 1, 1, 5000, 3000]);
  assert.deepEqual(report.objective, { month: "2026-11", target: 40000, achieved: 12000, percent: 30 });

  const product = Object.fromEntries(report.axes.produit.map((row) => [row.label, row]));
  assert.deepEqual(Object.keys(product), ["Lit cabane", "Bureau enfant", "non rattaché"], "« lit  CABANE » is the same product; an invoice with no quote apart");
  assert.deepEqual([product["Lit cabane"].issued.count, product["Lit cabane"].signed.totalTtc, product["Lit cabane"].conversion, product["Lit cabane"].prospects], [2, 12000, 50, 1]);
  assert.equal(product["Bureau enfant"].paid.total, 2000, "the balance of quote 165, ordered in October, paid in November");
  assert.deepEqual([product["non rattaché"].invoiced.totalTtc, product["non rattaché"].paid.total], [1000, 300]);

  const channel = Object.fromEntries(report.axes.canal.map((row) => [row.key, row]));
  assert.deepEqual([channel.instagram.label, channel.instagram.signed.totalTtc, channel.instagram.prospects, channel.facebook.prospects], ["Instagram", 12000, 1, 1]);
  assert.equal(channel.showroom.issued.count, 1);
  assert.equal(channel["non renseigné"].issued.count, 1, "quote 172: nobody said where it came from");
  assert.deepEqual(report.unattributed.quotes, ["172", "165"]);
  assert.equal(report.axes.vendeur[0].label, "Nadia");
  assert.equal(report.axes.campagne[0].label, "Rentrée");
  assert.deepEqual(report.axes.client.map((row) => row.label).slice(0, 2), ["Client A", "Client B"]);
});

test("Commercial says where a sale came from; the direction sets the target; nothing is guessed", async () => {
  const followUps = await salesBook();
  const context = { books: { followUps, cash: { entries: async () => ENTRIES } }, documentService: { listIssued: async () => ISSUED }, social: { prospects: async () => PROSPECTS }, clock: () => TODAY };
  assert.deepEqual(salesTools(context, "commercial").map((entry) => entry.tool.name), ["bilan_commercial", "analyse_commerciale", "qualifier_devis", "enregistrer_relance"]);

  assert.equal((await attributeQuote({ devis: "999", canal: "instagram", vendeur: "", campagne: "" }, context, "commercial")).ok, false);
  assert.match((await attributeQuote({ devis: "172", canal: "pigeon", vendeur: "", campagne: "" }, context, "commercial")).erreur, /Canal inconnu/);
  const saved = await attributeQuote({ devis: "172", canal: "whatsapp", vendeur: "", campagne: "" }, context, "commercial");
  assert.equal(saved.enregistre, "Devis n° 172 (Client C) : canal WhatsApp, vendeur non renseigné, campagne non renseignée.");
  await attributeQuote({ devis: "170", canal: "", vendeur: "", campagne: "-" }, context, "commercial");
  assert.deepEqual((await followUps.state()).quotes["170"].attribution.campaign, "", "« - » removes it; an empty field keeps the rest");
  assert.equal((await followUps.state()).quotes["170"].attribution.seller, "Nadia");

  assert.match((await setSalesTarget({ mois: "12/2026", montant: "100000" }, context, "sara")).enregistre, /12\/2026 : 100.000 DH/);
  assert.equal((await setSalesTarget({ mois: "13/2026", montant: "1" }, context, "sara")).ok, false);

  const answer = await commercialAnalysisFor({ du: "01/11/2026", au: "30/11/2026", axe: "canal" }, context);
  assert.match(answer.totaux.ca_commande, /^12.000 DH, 1 BC, \+140 % \(avant : 5.000 DH\) — devis 170 → BC 166$/);
  assert.match(answer.totaux.ca_facture, /^7.000 DH/);
  assert.match(answer.totaux.ca_encaisse, /^9.500 DH/);
  assert.match(answer.objectif, /40.000 DH de CA commandé pour 11\/2026 : 12.000 DH atteints, soit 30 %/);
  assert.deepEqual(Object.keys(answer.analyse), ["canal"]);
  assert.ok(answer.analyse.canal.some((line) => line.startsWith("WhatsApp : 1 devis émis")));
  assert.match(answer.canal_inconnu, /devis n° 165/);
  assert.equal((await commercialAnalysisFor({ du: "30/11/2026", au: "01/11/2026", axe: "tous" }, context)).ok, false);
});

test("the cockpit shows the report to everyone signed in; the direction alone sets the target", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "bilan-commercial-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository, clock: () => TODAY, documentService: new HkidsDocumentService({ repository, outputDir: dir }) });
  t.after(() => app.close());
  const operator = await createAuthenticatedUser(repository, { id: "karim", role: "operator" });

  const read = await app.inject({ method: "GET", url: "/api/commercial/report?from=2026-11-01&to=2026-11-30", headers: operator.headers });
  assert.equal(read.statusCode, 200, read.body);
  const payload = JSON.parse(read.body);
  assert.deepEqual([payload.report.from, payload.report.previous.from, payload.canDecide], ["2026-11-01", "2026-10-02", false]);
  assert.deepEqual(Object.keys(payload.axes), ["produit", "canal", "client", "vendeur", "campagne"]);
  assert.equal((await inject({ method: "GET", url: "/api/commercial/report?from=2026-11-30&to=2026-11-01" })).statusCode, 400);

  assert.equal((await app.inject({ method: "PUT", url: "/api/commercial/targets", payload: { month: "2026-11", amount: "50000" }, headers: operator.headers })).statusCode, 403);
  assert.equal((await inject({ method: "PUT", url: "/api/commercial/targets", payload: { month: "novembre", amount: "50000" } })).statusCode, 400);
  const saved = await inject({ method: "PUT", url: "/api/commercial/targets", payload: { month: "2026-11", amount: "50000" } });
  assert.equal(saved.statusCode, 200, saved.body);
  const after = JSON.parse((await inject({ method: "GET", url: "/api/commercial/report" })).body);
  assert.deepEqual(after.report.objective, { month: "2026-11", target: 50000, achieved: 0, percent: 0 });
  assert.equal(after.canDecide, true);
});
