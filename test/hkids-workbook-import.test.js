import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { InMemoryRepository } from "../src/index.js";
import { createMvpToolRegistry } from "../src/tools/mvp-tools.js";
import { createBusinessMemoryRepository } from "../src/business-memory/repository-factory.js";
import { convertHkidsWorkbook } from "../src/business-memory/hkids-workbook.js";
import { ingestBusinessRecords, validateIngestionBatch } from "../src/business-memory/ingestion.js";
import { excelSerialToIsoDate, readXlsxSheets } from "../src/business-memory/xlsx-reader.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";
import { buildXlsx, isoToSerial } from "../test-support/xlsx-fixture.js";

// Every name below is invented. The workbook the company fills in is never
// committed; these fixtures stand in for it.
const TODAY = new Date();

function day(offset) {
  const date = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate() + offset));
  return isoToSerial(date.toISOString().slice(0, 10));
}

function workbook(overrides = {}) {
  return {
    Clients: [
      ["ID client", "Nom", "Ville", "Téléphone", "Email", "Dernier contact", "Remarque"],
      ["C001", "Famille Exemple A", "Marrakech", "", "", day(-3), ""],
      ["C002", "Famille Exemple B", "Rabat", "", "", "", ""]
    ],
    Fournisseurs: [
      ["ID fournisseur", "Nom", "Téléphone", "Délai habituel (jours)", "Produits", "Remarque"],
      ["F001", "Bois Exemple", "", 5, "Panneaux", ""]
    ],
    Devis: [
      ["N° devis", "ID client", "Date du devis", "Montant TTC (DH)", "Statut", "Dernière relance", "Acompte demandé", "N° BC lié", "Jours sans réponse", "Remarque"],
      ["170", "C001", day(-20), 15000, "envoyé", "", "oui", "", "", ""],
      ["171", "C002", day(-3), 9000, "envoyé", "", "oui", "", "", ""],
      ["172", "C002", day(-12), 10000, "accepté - attente acompte", "", "oui", "172", "", ""]
    ],
    Commandes: [
      ["N° BC", "ID client", "N° devis", "Date commande", "Montant TTC (DH)", "Livraison prévue", "Étape", "Responsable", "Matière manquante", "Jours avant livraison", "Remarque"],
      ["172", "C002", "172", day(-10), 10000, day(4), "fabrication", "Atelier", "", "", ""],
      ["173", "C001", "", day(-30), 16000, day(-5), "fabrication", "Atelier", "", "", ""],
      ["174", "C001", "", day(-60), 8000, day(-20), "installé", "", "", "", ""]
    ],
    Paiements: [
      ["Réf paiement", "N° BC", "ID client", "Type", "Montant (DH)", "Date prévue", "Payé", "Date de paiement", "Moyen", "En retard", "Remarque"],
      ["P001", "172", "C002", "acompte", 5000, day(-5), "non", "", "virement", "", ""],
      ["P002", "173", "C001", "solde", 8000, day(3), "non", "", "virement", "", ""],
      ["P003", "174", "C001", "solde", 4000, day(-25), "oui", day(-24), "espèces", "", ""]
    ],
    Achats: [
      ["Matière", "Quantité nécessaire", "Unité", "Stock disponible", "Manque", "Fournisseur", "Délai fournisseur (jours)", "Date nécessaire", "N° BC lié", "Statut", "Prix unitaire (DH)", "Remarque"],
      ["Panneau MDF 18 mm", 6, "plaque", 2, "", "Bois Exemple", 5, day(3), "173", "à commander", 450, ""]
    ],
    ...overrides
  };
}

async function convert(sheets) {
  return convertHkidsWorkbook(readXlsxSheets(await buildXlsx(sheets)), { referenceDate: TODAY });
}

test("excel serial numbers become ISO dates", () => {
  assert.equal(excelSerialToIsoDate(46325), "2026-10-30");
  assert.equal(excelSerialToIsoDate(isoToSerial("2026-01-01")), "2026-01-01");
});

test("the delivered template reads, and its example rows are skipped rather than imported", async () => {
  const sheets = readXlsxSheets(await readFile(new URL("../docs/modele-donnees-hkids.xlsx", import.meta.url)));
  assert.deepEqual(
    Object.keys(sheets),
    ["Mode d'emploi", "Clients", "Devis", "Commandes", "Paiements", "Achats", "Fournisseurs"]
  );
  assert.equal(sheets.Clients[0].values.Nom, "Client Exemple");

  const result = convertHkidsWorkbook(sheets);
  assert.deepEqual(result.issues, []);
  assert.equal(result.skipped.length, 6);
  assert.ok(Object.values(result.recordsByDomain).every((records) => records.length === 0));
});

test("a filled workbook becomes valid records with their signals computed", async () => {
  const { recordsByDomain, issues } = await convert(workbook());
  assert.deepEqual(issues, []);

  for (const [domain, records] of Object.entries(recordsByDomain)) {
    const batch = validateIngestionBatch({ domain, source: "future_real_data", records });
    assert.deepEqual(batch.rejected, [], domain);
  }

  const quote = (id) => recordsByDomain.quotes.find((record) => record.id === id).data;
  assert.equal(quote("170").noResponseDays, 20);
  assert.equal(quote("170").priority, "high", "twice the follow-up threshold");
  assert.equal(quote("171").priority, "low", "three days is not yet a follow-up");
  assert.equal(quote("172").status, "accepted_pending_deposit");

  const production = (orderId) => recordsByDomain.production.find((record) => record.data.orderId === orderId)?.data;
  assert.equal(production("172").classification, "AT_RISK", "delivery in four days, still in the workshop");
  assert.equal(production("173").classification, "IN_DANGER", "delivery date passed");
  assert.equal(production("174"), undefined, "an installed order has left the workshop");

  const payment = (id) => recordsByDomain.payments.find((record) => record.id === id).data;
  assert.equal(payment("P001").daysLate, 5);
  assert.equal(payment("P001").requiresDecision, true, "a late deposit is the management's call");
  assert.equal(payment("P002").priority, "medium");
  assert.equal(payment("P003").status, "received");

  const need = recordsByDomain.purchase_needs[0].data;
  assert.equal(need.missingQuantity, 4);
  assert.equal(need.supplierId, "F001");
  assert.equal(need.urgency, "high", "needed in three days, five days of lead time");
});

test("a row naming something that does not exist, or a value outside its list, is reported by sheet and row", async () => {
  const sheets = workbook();
  sheets.Devis = [...sheets.Devis, ["175", "C999", day(-1), 1000, "envoyé", "", "", "", "", ""]];
  sheets.Commandes = [...sheets.Commandes, ["176", "C001", "", day(-1), 1000, "pas une date", "en cours", "", "", "", ""]];

  const { issues } = await convert(sheets);
  const found = issues.map((entry) => `${entry.sheet}:${entry.row}:${entry.column}:${entry.code}`);
  assert.ok(found.includes("Devis:5:ID client:UNKNOWN_REFERENCE"), found.join(" | "));
  assert.ok(found.includes("Commandes:5:Étape:UNKNOWN_VALUE"), found.join(" | "));
});

test("imported as real data, the workbook is what the Director reports on, by customer name", async (t) => {
  const { recordsByDomain } = await convert(workbook());
  const businessMemory = createBusinessMemoryRepository({
    env: { BUSINESS_MEMORY_PROVIDER: "memory", BUSINESS_DATA_PROVIDER: "future_real_data", BUSINESS_PROVIDER_ADAPTER: "future_real_data" }
  });
  for (const [domain, records] of Object.entries(recordsByDomain)) {
    const report = await ingestBusinessRecords({ memory: businessMemory, domain, source: "future_real_data", records, dryRun: false });
    assert.equal(report.writtenCount, records.length, domain);
  }

  // The server builds both from the same environment; a test passes both.
  const repository = new InMemoryRepository();
  const toolRegistry = createMvpToolRegistry({ repository, businessMemory });
  const { app, inject } = await buildAuthenticatedApi({ repository, businessMemory, toolRegistry });
  t.after(() => app.close());
  const response = await inject({
    method: "POST",
    url: "/api/director/requests",
    payload: { message: "Fais-moi le point sur mon entreprise aujourd'hui." }
  });
  const body = JSON.parse(response.body);
  const text = JSON.stringify(body.summary.minimumSections);

  assert.equal(response.statusCode, 201, response.body);
  assert.match(text, /Famille Exemple B - 5000 MAD - en retard de 5 jour\(s\)/);
  assert.match(text, /Famille Exemple A - 15000 MAD - sans reponse depuis 20 jour\(s\)/);
  assert.match(text, /Famille Exemple A - en danger - Livraison prévue dépassée de 5 jour\(s\)/);
  assert.match(text, /Panneau MDF 18 mm - manque 4 plaque/);
  // The four MVP agents read the imported data and nothing else.
  const mvpAgents = ["finance", "commercial", "production", "purchasing"];
  const mvpEntries = Object.values(body.summary.minimumSections).flat().filter((entry) => mvpAgents.includes(entry.agent));
  assert.ok(mvpEntries.length > 0);
  assert.doesNotMatch(JSON.stringify(mvpEntries), /Demo|atlas|nova/i, "no demo record leaks into a real-data answer");
  assert.ok(body.summary.domainSources
    .filter((entry) => mvpAgents.includes(entry.agent))
    .every((entry) => entry.dataSource === "future_real_data"));
});
