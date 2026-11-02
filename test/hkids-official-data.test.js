import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentBundle } from "../src/index.js";
import {
  HKIDS_BATCH_SCENARIOS,
  HKIDS_SALMA_QUOTE,
  createCommercialBatch
} from "../src/documents/commercial-batch.js";

/**
 * The official H-KIDS test request, as it was handed over: every line of the
 * twenty files, the project and the children, and the separate Salma quote.
 *
 * The tables below are the request's own lines and figures. The batch module holds
 * the same data as inputs; these tests check that each designation sits on the
 * line of its amount, that every file adds up to the gross the request publishes,
 * and that nothing the request does not state was added.
 */

// [designation, quantity, unit price HT], in the request's order.
const OFFICIAL_LINES = Object.freeze({
  1: [["Lit cabane Montessori 190×90", 1, 4500], ["Matelas 190×90", 1, 1600], ["Tour de lit tressé quatre brins", 1, 1500], ["Voile de lit", 1, 750], ["Deux attaches murales papillon", 1, 200]],
  2: [["Lit superposé cabane avec toboggan", 1, 18000], ["Mur d’escalade", 1, 3200], ["Livraison/install", 1, 2500]],
  3: [["Lit mezzanine avec couchage 190×140", 1, 24000], ["Escalier rangements", 1, 4800], ["Éclairage LED", 1, 4500], ["Livraison/install", 1, 2000]],
  4: [["Armoire trois portes", 1, 14000], ["Coin bureau mural évolutif", 1, 8500], ["Table d’activité", 1, 3800], ["Papier peint floral", 1, 2300]],
  5: [["Lit inférieur 190×120 et lit supérieur 190×90", 1, 26500], ["Bibliothèque murale", 1, 2800], ["Papier peint thème espace", 1, 3500], ["Livraison/install", 1, 1500]],
  6: [["Réaménagement placard n°1", 1, 6500], ["Réaménagement placard n°2", 1, 6500], ["Habillage extérieur et nouvelles portes", 1, 38000], ["Livraison/install", 1, 2500]],
  7: [["Meuble TV et espace créatif", 1, 19500], ["Banquette de lecture", 1, 14500], ["Tableau noir mural", 1, 5500], ["Éclairage LED", 1, 2500], ["Livraison/install", 1, 2000]],
  8: [["Maison immersive", 1, 10500], ["Supermarché enfants", 1, 13000], ["Salon coiffure", 1, 14000], ["Espace vétérinaire", 1, 9500], ["Espace restaurant", 1, 12000], ["Livraison/install", 1, 3000]],
  9: [["Mezzanine centrale", 1, 28000], ["Piscine à balles", 1, 24000], ["Zone bébés", 1, 18000], ["Lanceur de balles", 1, 14000], ["Papier peint personnalisé", 1, 3500]],
  10: [["Lit tapissé 140 cm", 1, 7500], ["Matelas", 1, 1600], ["Tour de lit tressé", 1, 1500], ["Voile", 1, 750], ["Tapis tressé", 1, 2300], ["Livraison/install", 1, 1200]],
  11: [["Deux lits tapissés de 160 cm", 1, 17000], ["Deux matelas à 1600 DH", 1, 3200], ["Table de nuit commune", 1, 1500]],
  12: [["Lit cabane dinosaure", 1, 9000], ["Bureau bibliothèque", 1, 6800], ["Papier peint dinosaure", 1, 3200], ["Éclairage intégré", 1, 4500], ["Livraison/install", 1, 1800]],
  13: [["Lit château avec deux tours", 1, 16500], ["Toboggan et escalier rangement", 1, 14000], ["Bureau mural", 1, 8500], ["Papier peint château", 1, 3500], ["Livraison/install", 1, 2500]],
  14: [["Dressings", 3, 4800], ["Livraison/install", 1, 1200]],
  15: [["Mezzanine bibliothèque éclairage", 1, 32000], ["Échelle suédoise", 1, 3800], ["Mur escalade", 1, 2800], ["Papier peint", 1, 2300]],
  16: [["Deux packs lits cabanes à 6 900 DH", 1, 13800], ["Tapis tressé", 1, 2300], ["Livraison", 1, 1500]],
  17: [["Espace restaurant", 1, 12000], ["Vétérinaire", 1, 9500], ["Hôpital", 1, 9500], ["Zone bébé", 1, 18000], ["Livraison/install", 1, 2500]],
  18: [["Lit Montessori bleu pastel", 1, 8500], ["Lit Montessori rose poudré", 1, 8500], ["Armoire partagée", 1, 6500], ["Papier peint personnalisé", 1, 3400], ["Livraison/install", 1, 2000]],
  19: [["Lit mezzanine", 1, 24000], ["Éclairage LED", 1, 4500], ["Échelle suédoise", 1, 3800], ["Livraison/install", 1, 2500]],
  20: [["Dressing compact", 1, 6500], ["Bureau évolutif", 1, 4800], ["Papier peint floral", 1, 2300], ["Livraison/install", 1, 1000]]
});

// "Total HT" or "Brut HT", as the request publishes it.
const PUBLISHED_BRUT = Object.freeze({
  1: 8550, 2: 23700, 3: 35300, 4: 28600, 5: 34300, 6: 53500, 7: 44000, 8: 62000, 9: 87500, 10: 14850,
  11: 21700, 12: 25300, 13: 45000, 14: 15600, 15: 40900, 16: 17600, 17: 51500, 18: 28900, 19: 34800, 20: 14600
});

// Only where the request states them.
const BRIEFS = Object.freeze({
  1: { project: "Chambre cabane Montessori", children: "fille, 4 ans" },
  2: { project: "chambre pour deux garçons", children: "garçons, 6 ans et 9 ans" },
  3: { children: "garçon, 10 ans" },
  4: { children: "fille, 8 ans" },
  5: { project: "chambre pour deux garçons", children: "deux garçons" },
  10: { project: "chambre bébé", children: "fille" },
  11: { project: "chambre pour deux filles", children: "jumelles" },
  12: { children: "garçon, 6 ans" },
  13: { children: "fille, 7 ans" },
  15: { children: "garçon, 9 ans" },
  16: { project: "chambre pour deux enfants" },
  18: { project: "chambre fille + garçon" },
  19: { children: "garçon, 11 ans" },
  20: { children: "fille, 5 ans" }
});

const linesOf = (scenario) => scenario.lines;

// --- the twenty files ---------------------------------------------------------

test("every designation sits on the line of its amount, in the order of the request", () => {
  for (const scenario of HKIDS_BATCH_SCENARIOS) {
    assert.deepEqual(
      linesOf(scenario).map((entry) => [entry.designation, entry.quantity, entry.unitPriceHt]),
      OFFICIAL_LINES[scenario.index],
      `file ${scenario.index}`
    );
    assert.equal(
      linesOf(scenario).reduce((sum, entry) => sum + entry.quantity * entry.unitPriceHt, 0),
      PUBLISHED_BRUT[scenario.index],
      `file ${scenario.index}: the lines add up to the published gross`
    );
  }
});

test("the only quantity above one is file 14's three dressings, and no quantity is 2", () => {
  const above = HKIDS_BATCH_SCENARIOS.flatMap((scenario) => linesOf(scenario)
    .map((entry, index) => ({ file: scenario.index, index, quantity: entry.quantity }))
    .filter((entry) => entry.quantity !== 1));

  assert.deepEqual(above, [{ file: 14, index: 0, quantity: 3 }]);
});

test("the project and the children are the request's, and only where it states them", () => {
  for (const scenario of HKIDS_BATCH_SCENARIOS) {
    if (BRIEFS[scenario.index]) {
      assert.deepEqual({ ...scenario.brief }, BRIEFS[scenario.index], `file ${scenario.index}`);
    } else {
      assert.equal(scenario.brief, undefined, `file ${scenario.index} states no project`);
    }
  }
});

test("no unit, no date, no payment method and no address beyond the city is written", () => {
  for (const scenario of HKIDS_BATCH_SCENARIOS) {
    assert.equal(linesOf(scenario).every((entry) => entry.unit === undefined), true, `file ${scenario.index} unit`);
    assert.equal(scenario.dates, undefined, `file ${scenario.index} dates`);
    assert.equal(scenario.paymentMethod, undefined, `file ${scenario.index} payment method`);
    assert.deepEqual(Object.keys(scenario.client).sort(), ["city", "name"], `file ${scenario.index} client`);
  }
});

test("file 7 keeps its official lines, and its fixed rebate is taken on none of them", () => {
  const seven = HKIDS_BATCH_SCENARIOS.find((scenario) => scenario.index === 7);

  for (const entry of seven.lines) {
    assert.equal("discountAmount" in entry || "discountPercent" in entry, false, entry.designation);
  }
  // "Remise exceptionnelle fixe : 2 333,33 DH": an amount on the document, not a
  // percentage and not a line.
  assert.deepEqual({ ...seven.rebate }, { fixedAmount: 2333.33, label: "Remise exceptionnelle" });

  const { totals } = createCommercialBatch().files.find((entry) => entry.file === 7).bundle;
  assert.deepEqual(
    [totals.totalBrutHt, totals.totalDiscount, totals.totalNetHt, totals.tva, totals.totalTtc],
    [44000, 2333.33, 41666.67, 8333.33, 50000]
  );
});

test("files 11 and 16 are delivered under the request's own words, without the price", () => {
  const delivered = HKIDS_BATCH_SCENARIOS.flatMap((scenario) => scenario.lines
    .map((entry, index) => ({ file: scenario.index, index, entry }))
    .filter(({ entry }) => entry.deliveryNoteDesignation !== undefined));

  assert.deepEqual(
    delivered.map(({ file, index, entry }) => [file, index, entry.designation, entry.deliveryNoteDesignation]),
    [
      [11, 1, "Deux matelas à 1600 DH", "Deux matelas"],
      [16, 0, "Deux packs lits cabanes à 6 900 DH", "Deux packs lits cabanes"]
    ]
  );
  // Nothing added: the delivery note's words are the first words of the official
  // designation, which is kept as it is.
  for (const { entry } of delivered) {
    assert.ok(entry.designation.startsWith(`${entry.deliveryNoteDesignation} à `), entry.designation);
  }
});

test("the rebates are named as the request names them", () => {
  const named = HKIDS_BATCH_SCENARIOS.filter((scenario) => scenario.rebate)
    .map((scenario) => [scenario.index, scenario.rebate.label]);
  assert.deepEqual(named, [[3, "Remise"], [6, "Remise"], [7, "Remise exceptionnelle"], [11, "Remise"], [17, "Remise"]]);

  const three = createCommercialBatch().files.find((entry) => entry.file === 3);
  assert.equal(three.bundle.discount.label, "Remise");
});

// --- the Salma quote ------------------------------------------------------------

const SALMA = Object.freeze({
  lines: [["Lit mezzanine sur mesure", 24000], ["Matelas enfant", 1600], ["Bureau évolutif", 6800],
    ["Armoire trois portes", 8900], ["Papier peint personnalisé", 3400], ["Éclairage LED indirect", 4500],
    ["Livraison et installation", 2500]],
  brutHt: 51700,
  baseHt: 39700,
  rebate: 1985,
  netHt: 49715,
  tva: 9943,
  ttc: 59658,
  instalments: [35794.8, 11931.6, 11931.6]
});

function salmaBundle() {
  return createDocumentBundle({
    client: { name: HKIDS_SALMA_QUOTE.client.name, address: HKIDS_SALMA_QUOTE.client.address },
    items: HKIDS_SALMA_QUOTE.lines.map(({ designation, quantity, unitPriceHt }) => ({ designation, quantity, unitPriceHt })),
    tvaRate: 0.2,
    discount: { ...HKIDS_SALMA_QUOTE.rebate, appliesToIndexes: [...HKIDS_SALMA_QUOTE.rebate.appliesToIndexes] },
    paymentScheduleRuleId: HKIDS_SALMA_QUOTE.paymentScheduleRuleId
  });
}

test("the Salma quote is kept apart from the twenty files and their numbers", () => {
  assert.equal(HKIDS_BATCH_SCENARIOS.some((scenario) => scenario.client.name === "Salma El Mansouri"), false);
  assert.equal(HKIDS_SALMA_QUOTE.numbers, undefined, "no number is written for it");
  assert.equal(HKIDS_SALMA_QUOTE.index, undefined);

  const batch = createCommercialBatch();
  assert.equal(batch.files.length, 20);
  assert.equal(batch.numbering.quote.continuous, true);
  assert.deepEqual([batch.numbering.quote.first, batch.numbering.quote.last], [61, 80]);
});

test("the Salma quote holds the request's customer, project and lines", () => {
  assert.deepEqual({ ...HKIDS_SALMA_QUOTE.client }, {
    name: "Salma El Mansouri",
    address: "Résidence Les Jardins d’Anfa, immeuble B, appartement 12, Casablanca",
    phone: "06 45 32 18 70",
    email: "salma.elmansouri@example.com"
  });
  assert.equal(HKIDS_SALMA_QUOTE.brief.project, "Aménagement complet d’une chambre pour deux enfants");
  assert.equal(HKIDS_SALMA_QUOTE.deliveryCity, "Casablanca");
  assert.equal(HKIDS_SALMA_QUOTE.leadTime, "8 à 10 semaines");

  assert.deepEqual(HKIDS_SALMA_QUOTE.lines.map((entry) => [entry.designation, entry.unitPriceHt]), SALMA.lines);
  assert.equal(HKIDS_SALMA_QUOTE.lines.every((entry) => entry.quantity === 1), true);
  assert.equal(HKIDS_SALMA_QUOTE.lines.every((entry) => entry.unit === undefined), true, "no unit is given");

  // The complete designations, word for word: the first and last line of each.
  const first = HKIDS_SALMA_QUOTE.lines.map((entry) => entry.fullDesignation[0]);
  assert.equal(first[0], "Conception et fabrication d’un lit mezzanine sur mesure comprenant :");
  assert.equal(first[6], "Livraison à Casablanca, montage, installation, réglage et contrôle final de l’ensemble du mobilier.");
  assert.equal(HKIDS_SALMA_QUOTE.lines[0].fullDesignation.at(-1), "* des poignées adaptées au thème de la chambre.");
  assert.equal(HKIDS_SALMA_QUOTE.lines[4].fullDesignation[2], "Thème : Forêt douce et animaux");
  assert.deepEqual(HKIDS_SALMA_QUOTE.lines.map((entry) => entry.fullDesignation.length), [10, 5, 7, 8, 5, 8, 1]);

  assert.equal(HKIDS_SALMA_QUOTE.conditions.length, 14);
  assert.equal(HKIDS_SALMA_QUOTE.conditions[0], "mobilier sur mesure ;");
  assert.equal(HKIDS_SALMA_QUOTE.conditions.at(-1), "devis valable 15 jours à compter de sa date d’émission.");
  assert.equal(HKIDS_SALMA_QUOTE.toConfirm.length, 10);
  assert.equal(HKIDS_SALMA_QUOTE.toConfirm[0], "date exacte de livraison souhaitée ;");
  assert.equal(HKIDS_SALMA_QUOTE.toConfirm.at(-1), "identité de la personne présente lors de l’installation.");
});

test("the Salma quote comes to the request's figures", () => {
  const bundle = salmaBundle();

  assert.equal(bundle.totals.totalBrutHt, SALMA.brutHt);
  assert.equal(bundle.discount.baseHt, SALMA.baseHt, "5 % on articles 1, 3 and 4 only");
  assert.deepEqual([...bundle.discount.appliesToIndexes], [0, 2, 3]);
  assert.equal(bundle.totals.totalDiscount, SALMA.rebate);
  assert.equal(bundle.totals.totalNetHt, SALMA.netHt);
  assert.equal(bundle.totals.tva, SALMA.tva);
  assert.equal(bundle.totals.totalTtc, SALMA.ttc);
  assert.deepEqual(bundle.schedule.installments.map((entry) => entry.percent), [60, 20, 20]);
  assert.deepEqual(bundle.schedule.installments.map((entry) => entry.amountTtc), SALMA.instalments);
});

test("the Salma quote gets no number until the register gives one", () => {
  const { quote, invoice, deliveryNote } = salmaBundle().documents;

  assert.equal(quote.documentNumber, null);
  assert.equal(quote.numberStatus, "pending_registry");
  assert.equal(invoice.numberStatus, "pending_registry");

  // And its delivery note, like every other, carries no price and no date.
  assert.equal(deliveryNote.totals, undefined);
  assert.equal(deliveryNote.items.every((item) => !("unitPriceHt" in item) && !("amountHt" in item)), true);
  assert.equal(deliveryNote.deliveryDateText, "Date de livraison : à définir");
});
