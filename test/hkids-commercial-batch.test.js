import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calculateDocumentTotals, validateAndPrepareDocument } from "../src/index.js";
import {
  BATCH_MISSING_REASONS,
  HKIDS_BATCH_SCENARIOS,
  ISSUE_CODES_NOT_BLOCKING_ISSUE,
  createCommercialBatch,
  reviewBatchLines,
  reviewFileCoherence,
  reviewFileIssue
} from "../src/documents/commercial-batch.js";
import { designationStatesPrice, isBundleReadyToIssue } from "../src/documents/document-bundle-service.js";

/**
 * The twenty files of the official H-KIDS test.
 *
 * The point of these tests is that the figures below are NOT the ones the batch
 * module holds. The module holds the inputs — the lines, the rebate targets, the
 * payment rule. The table here holds what the official test publishes as the
 * result: the gross, the rebate, the VAT, the total and the instalments. The two
 * were written from opposite ends and meet in calculateDocumentTotals and
 * createPaymentSchedule, so a fixture cannot pass by agreeing with itself.
 *
 * Every client is fictional, as the lot requires.
 */
const OFFICIAL_TEST = Object.freeze([
  { file: 1, client: "Lina Berrada", city: "Marrakech", numbers: ["61", "35", "35"], brutHt: 8550, tva: 1710, ttc: 10260, instalments: [6156] },
  { file: 2, client: "Youssef Alaoui", city: "Casablanca", numbers: ["62", "36", "36"], brutHt: 23700, tva: 4740, ttc: 28440, instalments: [17064] },
  { file: 3, client: "Ghita Amrani", city: "Rabat", numbers: ["63", "37", "37"], brutHt: 35300, rebate: 1200, netHt: 34100, tva: 6820, ttc: 40920, instalments: [24552] },
  { file: 4, client: "Sara El Idrissi", city: "Agadir", numbers: ["64", "38", "38"], brutHt: 28600, tva: 5720, ttc: 34320, instalments: [20592] },
  { file: 5, client: "Mehdi Tazi", city: "Marrakech", numbers: ["65", "39", "39"], brutHt: 34300, tva: 6860, ttc: 41160, instalments: [24696] },
  { file: 6, client: "Meryem Benjelloun", city: "Casablanca", numbers: ["66", "40", "40"], brutHt: 53500, rebate: 1300, netHt: 52200, tva: 10440, ttc: 62640, instalments: [37584] },
  { file: 7, client: "École Les Petits Explorateurs", city: "Marrakech", numbers: ["67", "41", "41"], brutHt: 44000, rebate: 2333.33, netHt: 41666.67, tva: 8333.33, ttc: 50000, instalments: [30000], fixedRebate: true },
  { file: 8, client: "Crèche Happy Kids SARL", city: "Tanger", numbers: ["68", "42", "42"], brutHt: 62000, tva: 12400, ttc: 74400, instalments: [44640] },
  { file: 9, client: "Fun Garden SARL", city: "Fès", numbers: ["69", "43", "43"], brutHt: 87500, tva: 17500, ttc: 105000, instalments: [52500, 31500, 21000] },
  { file: 10, client: "Imane Chraïbi", city: "Marrakech", numbers: ["70", "44", "44"], brutHt: 14850, tva: 2970, ttc: 17820, instalments: [10692] },
  { file: 11, client: "Lamia Kadiri", city: "El Jadida", numbers: ["71", "45", "45"], brutHt: 21700, rebate: 1190, netHt: 20510, tva: 4102, ttc: 24612, instalments: [14767.2] },
  { file: 12, client: "Amine Ouazzani", city: "Rabat", numbers: ["72", "46", "46"], brutHt: 25300, tva: 5060, ttc: 30360, instalments: [18216] },
  { file: 13, client: "Sofia Lahlou", city: "Casablanca", numbers: ["73", "47", "47"], brutHt: 45000, tva: 9000, ttc: 54000, instalments: [32400] },
  { file: 14, client: "Résidence Familiale Ennakhil", city: "Marrakech", numbers: ["74", "48", "48"], brutHt: 15600, tva: 3120, ttc: 18720, instalments: [11232] },
  { file: 15, client: "Kenza Bennani", city: "Tanger", numbers: ["75", "49", "49"], brutHt: 40900, tva: 8180, ttc: 49080, instalments: [29448] },
  { file: 16, client: "Hanane El Fassi", city: "Marrakech", numbers: ["76", "50", "50"], brutHt: 17600, tva: 3520, ttc: 21120, instalments: [21120] },
  { file: 17, client: "Crèche Les Mini-Mondes SARL", city: "Agadir", numbers: ["77", "51", "51"], brutHt: 51500, rebate: 2450, netHt: 49050, tva: 9810, ttc: 58860, instalments: [35316] },
  { file: 18, client: "Nadia Filali", city: "Marrakech", numbers: ["78", "52", "52"], brutHt: 28900, tva: 5780, ttc: 34680, instalments: [20808] },
  { file: 19, client: "Karim Bennis", city: "Casablanca", numbers: ["79", "53", "53"], brutHt: 34800, tva: 6960, ttc: 41760, instalments: [16704, 16704, 8352] },
  { file: 20, client: "Asmae Naciri", city: "Safi", numbers: ["80", "54", "54"], brutHt: 14600, tva: 2920, ttc: 17520, instalments: [10512] }
]);

const batch = createCommercialBatch();
const fileOf = (index) => batch.files.find((entry) => entry.file === index);
const expectedOf = (index) => OFFICIAL_TEST.find((entry) => entry.file === index);
// Every file is built, file 7 and its fixed rebate included.
const priced = OFFICIAL_TEST;

// --- the batch itself ---------------------------------------------------------

test("the batch holds the twenty files of the official test", () => {
  assert.equal(batch.files.length, 20);
  assert.equal(HKIDS_BATCH_SCENARIOS.length, 20);
  assert.deepEqual(batch.files.map((entry) => entry.file), OFFICIAL_TEST.map((entry) => entry.file));
});

test("each file names the customer and the city the official test names", () => {
  for (const expected of OFFICIAL_TEST) {
    const scenario = fileOf(expected.file).scenario;
    assert.equal(scenario.client.name, expected.client, `file ${expected.file}`);
    assert.equal(scenario.client.city, expected.city, `file ${expected.file}`);
  }
});

// --- numbering ------------------------------------------------------------------

test("the quotes run 61 to 80, the invoices and delivery notes 35 to 54, with no hole", () => {
  for (const [key, first, last] of [["quote", 61, 80], ["invoice", 35, 54], ["deliveryNote", 35, 54]]) {
    const review = batch.numbering[key];
    assert.equal(review.first, first, key);
    assert.equal(review.last, last, key);
    assert.deepEqual(review.gaps, [], `${key} must have no gap`);
    assert.deepEqual(review.duplicates, [], `${key} must use no number twice`);
    assert.deepEqual(review.outOfRange, [], `${key} must stay inside its range`);
    assert.equal(review.continuous, true, key);
  }
});

test("every number is the one the official test assigns to that file", () => {
  for (const expected of OFFICIAL_TEST) {
    const numbers = fileOf(expected.file).numbers;
    assert.deepEqual(
      [numbers.quote, numbers.invoice, numbers.deliveryNote],
      expected.numbers,
      `file ${expected.file}`
    );
  }
});

test("a hole or a repeat in the numbering is reported rather than tolerated", () => {
  // The review has to fail on bad input, otherwise the test above proves nothing.
  const broken = createCommercialBatch({
    scenarios: HKIDS_BATCH_SCENARIOS.map((scenario, index) => (index === 5
      ? { ...scenario, numbers: { ...scenario.numbers, quote: "61" } }
      : scenario))
  });

  assert.equal(broken.numbering.quote.continuous, false);
  assert.deepEqual(broken.numbering.quote.duplicates, [61]);
  assert.deepEqual(broken.numbering.quote.gaps, [66]);
});

// --- the figures ------------------------------------------------------------------

test("the gross, the rebate, the VAT and the total are the official ones", () => {
  for (const expected of priced) {
    const totals = fileOf(expected.file).bundle.totals;
    const where = `file ${expected.file}`;

    assert.equal(totals.totalBrutHt, expected.brutHt, `${where} brut HT`);
    assert.equal(totals.totalDiscount, expected.rebate ?? 0, `${where} remise`);
    assert.equal(totals.totalNetHt, expected.netHt ?? expected.brutHt, `${where} net HT`);
    assert.equal(totals.tva, expected.tva, `${where} TVA`);
    assert.equal(totals.totalTtc, expected.ttc, `${where} TTC`);
    assert.equal(totals.tvaRate, 0.2, `${where} taux de TVA`);
  }
});

test("the rebate is taken on the lines the official test names, and on no other", () => {
  // File 17: 5 % on the play areas, delivery excluded. The delivery line is the
  // 2 500 one, so the base is 49 000 and the rebate 2 450 - not 2 575.
  const seventeen = fileOf(17).bundle;
  assert.equal(seventeen.discount.baseHt, 49000);
  assert.equal(seventeen.discount.amount, 2450);
  assert.notEqual(seventeen.discount.baseHt, 51500, "delivery must stay outside the rebate");

  // File 3: the mezzanine alone. File 6: the two wardrobes. File 11: the beds.
  assert.equal(fileOf(3).bundle.discount.baseHt, 24000);
  assert.equal(fileOf(6).bundle.discount.baseHt, 13000);
  assert.equal(fileOf(11).bundle.discount.baseHt, 17000);

  // And the files the test gives no rebate for carry none at all.
  for (const expected of priced.filter((entry) => entry.rebate === undefined)) {
    assert.equal(fileOf(expected.file).bundle.totals.totalDiscount, 0, `file ${expected.file}`);
  }
});

test("the totals are what the calculation module makes of those lines", () => {
  // The same lines through the module directly: the batch may not hold totals of
  // its own, and the official figures may not be reached by another route.
  for (const expected of priced) {
    const scenario = fileOf(expected.file).scenario;
    const { totals } = calculateDocumentTotals(
      scenario.lines.map((entry) => ({ ...entry, designation: "?", unit: "U" })),
      0.2,
      scenario.rebate ? { discount: scenario.rebate } : {}
    );
    assert.equal(totals.totalTtc, expected.ttc, `file ${expected.file}`);
    assert.equal(totals.tva, expected.tva, `file ${expected.file}`);
  }
});

// --- payment ----------------------------------------------------------------------

test("each file carries the payment plan the official test states", () => {
  for (const expected of priced) {
    const schedule = fileOf(expected.file).bundle.schedule;
    const where = `file ${expected.file}`;

    expected.instalments.forEach((amount, index) => {
      assert.equal(schedule.installments[index].amountTtc, amount, `${where} échéance ${index + 1}`);
    });
    // The instalments add up to the total: no rounding is lost on the way.
    const paid = schedule.installments.reduce((sum, entry) => sum + entry.amountTtc, 0);
    assert.equal(Math.round(paid * 100) / 100, expected.ttc, `${where} somme des échéances`);
  }
});

test("the three exceptional plans are kept, and never replaced by 60/20/20", () => {
  const nine = fileOf(9).bundle.schedule;
  assert.deepEqual(nine.installments.map((entry) => entry.percent), [50, 30, 20]);
  assert.deepEqual(nine.installments.map((entry) => entry.amountTtc), [52500, 31500, 21000]);
  assert.notEqual(nine.installments[0].amountTtc, 63000, "60 % of 105 000 must never appear");

  const sixteen = fileOf(16).bundle.schedule;
  assert.equal(sixteen.installments.length, 1);
  assert.equal(sixteen.installments[0].percent, 100);
  assert.equal(sixteen.installments[0].amountTtc, 21120);
  assert.notEqual(sixteen.installments[0].amountTtc, 12672, "60 % of 21 120 must never appear");

  const nineteen = fileOf(19).bundle.schedule;
  assert.deepEqual(nineteen.installments.map((entry) => entry.percent), [40, 40, 20]);
  assert.deepEqual(nineteen.installments.map((entry) => entry.amountTtc), [16704, 16704, 8352]);

  // Every other file is on the standard plan.
  for (const expected of priced.filter((entry) => ![9, 16, 19].includes(entry.file))) {
    assert.deepEqual(
      fileOf(expected.file).bundle.schedule.installments.map((entry) => entry.percent),
      [60, 20, 20],
      `file ${expected.file}`
    );
  }
});

// --- the three documents of one file ------------------------------------------------

test("the three documents of every file agree on customer, lines and references", () => {
  for (const expected of priced) {
    const review = reviewFileCoherence(fileOf(expected.file));
    for (const [property, value] of Object.entries(review)) {
      assert.equal(value, true, `file ${expected.file}: ${property}`);
    }
  }
});

test("the invoice repeats the quote line for line, amount for amount", () => {
  for (const expected of priced) {
    const { quote, invoice } = fileOf(expected.file).bundle.documents;
    assert.deepEqual(invoice.items, quote.items, `file ${expected.file}`);
    assert.deepEqual(invoice.totals, quote.totals, `file ${expected.file}`);
    assert.equal(invoice.quoteReference, quote.documentNumber, `file ${expected.file}`);
  }
});

test("the delivery note carries the goods and not one price", () => {
  const PRICE_KEYS = ["unitPriceHt", "amountHt", "netAmountHt", "discountAmount",
    "discountPercent", "tva", "unitPriceTtc", "totalTtc"];

  for (const expected of priced) {
    const { deliveryNote, quote } = fileOf(expected.file).bundle.documents;
    assert.equal(deliveryNote.items.length, quote.items.length, `file ${expected.file}`);
    assert.equal(deliveryNote.totals, undefined, `file ${expected.file} totals`);
    assert.equal(deliveryNote.payment, undefined, `file ${expected.file} payment`);

    for (const [index, item] of deliveryNote.items.entries()) {
      for (const key of PRICE_KEYS) {
        assert.equal(key in item, false, `file ${expected.file} line ${index} carries ${key}`);
      }
      assert.equal(item.quantity, quote.items[index].quantity, `file ${expected.file} line ${index}`);
    }

    // And nothing anywhere in the document reads as an amount of dirhams.
    const serialised = JSON.stringify(deliveryNote);
    assert.equal(
      serialised.includes(String(expected.ttc)) || serialised.includes(String(expected.brutHt)),
      false,
      `file ${expected.file}: an amount reached the delivery note`
    );
  }
});

test("every delivery note references its quote and its invoice", () => {
  for (const expected of priced) {
    const { deliveryNote } = fileOf(expected.file).bundle.documents;
    assert.equal(deliveryNote.quoteReference, expected.numbers[0], `file ${expected.file}`);
    assert.equal(deliveryNote.invoiceReference, expected.numbers[1], `file ${expected.file}`);
  }
});

// --- what is not invented ------------------------------------------------------------

test("every delivery note says the delivery date is to be defined", () => {
  for (const expected of priced) {
    const { deliveryNote } = fileOf(expected.file).bundle.documents;
    assert.equal(deliveryNote.deliveryDateText, "Date de livraison : à définir", `file ${expected.file}`);
    assert.equal(deliveryNote.deliveryDateDefined, false, `file ${expected.file}`);
    assert.equal(deliveryNote.deliveryDate, "", `file ${expected.file}`);
  }
});

test("no date is invented anywhere in the batch", () => {
  // The official test gives no date at all: not a quote date, not an invoice
  // date, not a delivery date. None may appear.
  // Slashes and ISO only: the payment rule ids read "hkids-60-20-20-2026", and a
  // hyphenated pattern would call that a date.
  const DATE = /\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2}/;
  for (const expected of priced) {
    const { documents } = fileOf(expected.file).bundle;
    for (const [key, document] of Object.entries(documents)) {
      assert.equal(document.date, "", `file ${expected.file} ${key} date`);
      assert.doesNotMatch(JSON.stringify(document), DATE, `file ${expected.file} ${key}`);
    }
  }
});

test("file 19 is urgent and still promises nothing", () => {
  const nineteen = fileOf(19);
  assert.deepEqual([...nineteen.scenario.note], [
    "Le dossier est urgent.",
    "NE PAS inventer ni promettre une date de livraison."
  ]);

  const { deliveryNote } = nineteen.bundle.documents;
  assert.equal(deliveryNote.deliveryDateText, "Date de livraison : à définir");
  assert.doesNotMatch(JSON.stringify(nineteen.bundle.documents), /délai|semaine|jours|urgent/i);
});

test("every line carries its official designation, and nothing else is invented", () => {
  // No file is short of anything the batch needs: file 7 is built too.
  assert.deepEqual(batch.missing, []);
  assert.equal(batch.readyForReview, true, "every file is ready for review");
  assert.equal(batch.readyToIssue, false, "and none is ready to issue");

  for (const expected of priced) {
    const entry = fileOf(expected.file);
    assert.deepEqual(entry.missing, [], `file ${expected.file}`);
    // Every line is named, which is all readyForReview measures. The official
    // test gives no unit, no date and no payment method, and the validator
    // refuses the documents for them: none of them is ready to issue.
    assert.equal(entry.readyForReview, true, `file ${expected.file}`);
    assert.equal(entry.readyToIssue, false, `file ${expected.file}`);

    for (const item of entry.bundle.documents.quote.items) {
      assert.equal(typeof item.designation, "string", `file ${expected.file}`);
      assert.equal(item.unit, undefined, `file ${expected.file}: no unit is given, none is invented`);
    }
    assert.equal(entry.bundle.documents.quote.date, "", `file ${expected.file}`);
    assert.equal(entry.bundle.documents.quote.payment.method, "", `file ${expected.file}`);
  }
});

test("file 7 is built: its fixed rebate of 2 333,33 is taken on the total, and on no line", () => {
  const seven = fileOf(7);
  const expected = expectedOf(7);

  assert.equal(seven.blocked, false);
  assert.deepEqual(seven.missing, []);
  assert.equal(seven.readyForReview, true);
  assert.deepEqual(
    [seven.numbers.quote, seven.numbers.invoice, seven.numbers.deliveryNote],
    ["67", "41", "41"]
  );

  // The published figures, reached by the engine from the official lines.
  const { totals, discount, schedule } = seven.bundle;
  assert.equal(totals.totalBrutHt, expected.brutHt);
  assert.equal(totals.totalDiscount, expected.rebate);
  assert.equal(totals.totalNetHt, expected.netHt);
  assert.equal(totals.totalHt, expected.netHt, "totalHt is the net");
  assert.equal(totals.tva, expected.tva);
  assert.equal(totals.totalTtc, expected.ttc);
  assert.equal(schedule.installments[0].amountTtc, expected.instalments[0], "the 60 % deposit");

  // A fixed amount on the document as a whole: no percentage, no line named.
  assert.equal(discount.fixedAmount, 2333.33);
  assert.equal(discount.label, "Remise exceptionnelle");
  assert.equal(discount.percent, undefined);
  assert.equal(discount.appliesToIndexes, undefined);

  // Every line keeps its own amount: none carries a share of the rebate.
  for (const key of ["quote", "invoice"]) {
    const items = seven.bundle.documents[key].items;
    assert.deepEqual(items.map((item) => item.amountHt), [19500, 14500, 5500, 2500, 2000], key);
    assert.equal(items.every((item) => item.discountAmount === 0 && item.netAmountHt === item.amountHt), true, key);
  }
});

// --- what each file states in its own words ---------------------------------------------

test("the exclusions the official test states are recorded, and never become a line", () => {
  const one = fileOf(1);
  assert.equal(one.scenario.excluded[0], "Un tapis est visible mais ne doit PAS être inclus dans les lignes.");
  assert.equal(one.bundle.documents.quote.items.length, 5, "the rug is not a sixth line");
  assert.equal(one.bundle.documents.quote.items.some((item) => /tapis/i.test(item.designation)), false);
  assert.equal(one.bundle.totals.totalBrutHt, 8550);

  const two = fileOf(2);
  assert.equal(two.scenario.excluded[0], "Les matelas sont exclus.");
  assert.equal(two.bundle.documents.quote.items.length, 3);
  assert.equal(two.bundle.documents.quote.items.some((item) => /matelas/i.test(item.designation)), false);

  const twenty = fileOf(20);
  assert.equal(twenty.scenario.excluded[0], "Ne pas ajouter de lit.");
  assert.equal(twenty.bundle.documents.quote.items.length, 4, "no bed is added");
  assert.equal(twenty.bundle.documents.quote.items.some((item) => /^lit\b/i.test(item.designation)), false);
  assert.equal(twenty.bundle.totals.totalBrutHt, 14600);
});

test("file 14 delivers three dressings, on all three documents", () => {
  const fourteen = fileOf(14);
  const { quote, invoice, deliveryNote } = fourteen.bundle.documents;

  assert.deepEqual(quote.items.map((item) => item.quantity), [3, 1]);
  assert.deepEqual(invoice.items.map((item) => item.quantity), [3, 1]);
  assert.deepEqual(deliveryNote.items.map((item) => item.quantity), [3, 1]);
  assert.equal(quote.items[0].unitPriceHt, 4800);
  assert.equal(quote.items[0].amountHt, 14400, "three at 4 800");
  assert.equal(fourteen.bundle.totals.totalBrutHt, 15600);
});

test("the constraints and the notes of the official test are carried, not lost", () => {
  assert.match(fileOf(5).scenario.constraint[0], /2,50 m/);
  assert.match(fileOf(13).scenario.constraint[0], /crème \/ violet \/ rose poudré/);
  assert.match(fileOf(4).scenario.note[0], /Livraison gratuite/);
  assert.match(fileOf(8).scenario.note[0], /professionnel/);

  // File 4's free delivery is a statement, not a line worth zero.
  assert.equal(fileOf(4).bundle.documents.quote.items.length, 4);
  assert.equal(
    fileOf(4).bundle.documents.quote.items.some((item) => item.unitPriceHt === 0),
    false,
    "a free delivery is not a line at zero"
  );
});

// --- the designation review still bites ---------------------------------------------
//
// The official list is in the scenarios now, so every file is named. The review
// must still report a name that goes missing, or the assertions above would hold
// for a review that never looks at the line. These tests take a file's names off,
// put some back, and check that the answer changes only for the lines concerned.
//
// The designations used here are test values, written in this file only.
function withDesignations(fileIndex, designations) {
  return HKIDS_BATCH_SCENARIOS.map((scenario) => (scenario.index !== fileIndex ? scenario : {
    ...scenario,
    // Every official name taken off, then only the ones this test supplies put back.
    lines: scenario.lines.map((line, index) => {
      const { designation, ...unnamed } = line;
      return designations[index] === undefined ? unnamed : { ...unnamed, designation: designations[index] };
    })
  }));
}

test("a designation that is supplied stops being reported as missing", () => {
  const unnamed = withDesignations(2, []).find((entry) => entry.index === 2);
  const scenarios = withDesignations(2, ["Lit superposé", "Matelas", "Étagère murale"]);
  const scenario = scenarios.find((entry) => entry.index === 2);

  // Without names: three lines, three gaps. With them: three lines, none.
  assert.equal(reviewBatchLines(unnamed).length, 3);
  assert.equal(reviewBatchLines(scenario).length, 0);

  const completed = createCommercialBatch({ scenarios });
  const two = completed.files.find((entry) => entry.file === 2);
  assert.equal(two.missing.length, 0);
  assert.equal(two.readyForReview, true, "a file with all its designations is ready for review");
  assert.equal(two.readyToIssue, false, "and not to issue: it has no date and no payment method");

  // The rest of the batch is untouched: nothing else is short, so the batch is
  // ready for review, and not to issue.
  assert.deepEqual(completed.missing, []);
  assert.equal(completed.readyForReview, true);
  assert.equal(completed.readyToIssue, false);
  assert.deepEqual(two.bundle.documents.quote.items.map((item) => item.designation),
    ["Lit superposé", "Matelas", "Étagère murale"]);

  // And with the names taken off again, the three gaps come back.
  const bare = createCommercialBatch({ scenarios: withDesignations(2, []) });
  assert.equal(bare.files.find((entry) => entry.file === 2).missing.length, 3);
});

test("a file half supplied reports exactly the lines still missing", () => {
  // Only the middle line is named, so the gaps must be lines 0 and 2 - by their
  // real index, not renumbered by the filtering.
  const scenarios = withDesignations(2, [undefined, "Matelas", undefined]);
  const scenario = scenarios.find((entry) => entry.index === 2);
  const missing = reviewBatchLines(scenario);

  assert.deepEqual(missing.map((entry) => entry.field), ["lines.0.designation", "lines.2.designation"]);
  const two = createCommercialBatch({ scenarios }).files.find((entry) => entry.file === 2);
  assert.equal(two.readyForReview, false);
  assert.equal(two.readyToIssue, false);
});

test("a blank designation is an absent one", () => {
  for (const blank of ["", "   ", null]) {
    const scenarios = withDesignations(2, [blank, "Matelas", "Étagère murale"]);
    const missing = reviewBatchLines(scenarios.find((entry) => entry.index === 2));
    assert.deepEqual(missing.map((entry) => entry.field), ["lines.0.designation"], JSON.stringify(blank));
  }
});

test("a file given no lines is blocked, and is built once they are given", () => {
  // Every file of the official test has its lines now. The mechanism stays, and is
  // checked here on file 7 with its lines taken off in this test only.
  const withoutLines = HKIDS_BATCH_SCENARIOS.map((scenario) => (scenario.index !== 7 ? scenario : {
    ...scenario,
    lines: null
  }));
  const stillBlocked = createCommercialBatch({ scenarios: withoutLines });
  const seven = stillBlocked.files.find((entry) => entry.file === 7);

  assert.equal(seven.blocked, true);
  assert.equal(seven.bundle, null);
  assert.equal(seven.readyForReview, false);
  assert.equal(seven.readyToIssue, false);
  assert.equal(seven.issueReview, null, "a file with no documents has nothing to validate");
  assert.deepEqual(stillBlocked.missing.map((entry) => entry.field), ["lines"]);
  assert.equal(seven.missing[0].message, BATCH_MISSING_REASONS.LINES_UNAVAILABLE);
  assert.equal(stillBlocked.readyForReview, false, "one blocked file keeps the batch from being ready");
  assert.equal(stillBlocked.readyToIssue, false, "one blocked file keeps the batch from being ready");
  assert.throws(() => reviewFileCoherence(seven), /has no documents/);

  // With its lines, it is a file like the others.
  const rebuilt = fileOf(7);
  assert.equal(rebuilt.blocked, false);
  assert.equal(rebuilt.readyForReview, true);
  assert.equal(batch.readyForReview, true, "the whole batch is ready for review");
  // Ready for review, not to issue: no file of the batch has a date, a payment
  // method or a unit yet.
  assert.equal(rebuilt.readyToIssue, false);
  assert.equal(batch.readyToIssue, false);
});

test("a missing unit does not keep a file from review; the invoice validator still requires one", () => {
  // The official test states no unit. The batch's own review adds no rule for
  // it, so a file whose designations are complete is ready for review without
  // one. The validator does require a unit on an invoice line, and readyToIssue
  // reads the validator: that is the only place the unit counts.
  const scenarios = withDesignations(2, ["Lit superposé", "Matelas", "Étagère murale"]);
  const two = createCommercialBatch({ scenarios }).files.find((entry) => entry.file === 2);

  assert.equal(two.scenario.lines.every((line) => line.unit === undefined), true);
  assert.equal(two.readyForReview, true);
  assert.equal(two.readyToIssue, false);
});

// --- the data the validator needs travels through the batch ------------------------
//
// The audit found bundleInputFor dropping the dates and the payment method: a file
// supplied with every field still reached the validator without them, and was
// refused for data it had been given. These tests supply both and follow them all
// the way to validateAndPrepareDocument.
//
// The values are stand-ins for the official data, written in this file only.
const STAND_IN_DATES = Object.freeze({ quoteDate: "06/09/2026", invoiceDate: "06/09/2026", deliveryNoteDate: "06/09/2026" });

function completed(fileIndex) {
  return HKIDS_BATCH_SCENARIOS.map((scenario) => (scenario.index !== fileIndex ? scenario : {
    ...scenario,
    lines: scenario.lines.map((line, index) => ({ ...line, designation: `Article ${index}`, unit: "U" })),
    dates: STAND_IN_DATES,
    paymentMethod: "virement bancaire"
  }));
}

function validationErrors(document) {
  try {
    validateAndPrepareDocument(document);
    return [];
  } catch (error) {
    return (error.errors ?? []).map((entry) => entry.field);
  }
}

test("the dates and the payment method a file carries reach its three documents", () => {
  const { quote, invoice, deliveryNote } = createCommercialBatch({ scenarios: completed(2) })
    .files.find((entry) => entry.file === 2).bundle.documents;

  assert.equal(quote.date, "06/09/2026");
  assert.equal(invoice.date, "06/09/2026");
  assert.equal(deliveryNote.date, "06/09/2026");
  assert.equal(quote.payment.method, "virement bancaire");
  assert.equal(invoice.payment.method, "virement bancaire");

  // No delivery date was given, so none is written.
  assert.equal(deliveryNote.deliveryDateText, "Date de livraison : à définir");
  assert.equal(deliveryNote.deliveryDateDefined, false);
});

function assertCompleteFilePasses(fileIndex, ttc) {
  const entry = createCommercialBatch({ scenarios: completed(fileIndex) })
    .files.find((file) => file.file === fileIndex);

  for (const [key, document] of Object.entries(entry.bundle.documents)) {
    assert.deepEqual(validationErrors(document), [], `file ${fileIndex} ${key}`);
  }
  // Supplying the data changes no amount.
  assert.equal(entry.bundle.totals.totalTtc, ttc, `file ${fileIndex}`);
  // The batch reads the validator the same way: nothing refused, nothing blocking.
  assert.deepEqual(entry.issueReview.documents, { quote: [], invoice: [], deliveryNote: [] }, `file ${fileIndex}`);
  assert.deepEqual(entry.issueReview.blocking, [], `file ${fileIndex}`);
  assert.equal(entry.readyForReview, true, `file ${fileIndex}`);
  assert.equal(entry.readyToIssue, true, `file ${fileIndex}`);
  return entry;
}

test("a complete file without a rebate passes the validator", () => {
  assertCompleteFilePasses(2, 28440);
});

// --- a rebate is applied once -------------------------------------------------------
//
// createDocumentBundle writes, on each line the document's rebate targets, the
// rebate that line received. The validator used to read it back as a rebate of the
// line's own and apply the document's on top: file 3's mezzanine, discounted 1 200,
// was recomputed at 2 340, and every file discounted by a percentage was refused.
// The expected figures are the ones the official test publishes.

const PERCENT_REBATE_FILES = OFFICIAL_TEST.filter((entry) => entry.rebate !== undefined && !entry.fixedRebate);

function preparedTotals(document) {
  return validateAndPrepareDocument(document).totals;
}

function refusalCode(document) {
  try {
    validateAndPrepareDocument(document);
    return "accepted";
  } catch (error) {
    return error.code;
  }
}

test("the official test discounts four files by a percentage: 3, 6, 11 and 17", () => {
  assert.deepEqual(PERCENT_REBATE_FILES.map((entry) => entry.file), [3, 6, 11, 17]);
});

for (const expected of PERCENT_REBATE_FILES) {
  test(`file ${expected.file}: its rebate is applied once, and the complete file passes the validator`, () => {
    const entry = assertCompleteFilePasses(expected.file, expected.ttc);

    // The validator recomputes the file's own figures, not a second rebate.
    for (const key of ["quote", "invoice"]) {
      const totals = preparedTotals(entry.bundle.documents[key]);
      assert.equal(totals.totalBrutHt, expected.brutHt, `${key} brut HT`);
      assert.equal(totals.totalDiscount, expected.rebate, `${key} remise`);
      assert.equal(totals.totalNetHt, expected.netHt, `${key} net HT`);
      assert.equal(totals.tva, expected.tva, `${key} TVA`);
      assert.equal(totals.totalTtc, expected.ttc, `${key} TTC`);
    }
  });
}

test("file 7, completed, passes the validator with its published figures and its fixed rebate taken once", () => {
  const expected = expectedOf(7);
  const entry = assertCompleteFilePasses(7, expected.ttc);

  for (const key of ["quote", "invoice"]) {
    const prepared = validateAndPrepareDocument(entry.bundle.documents[key]);
    assert.equal(prepared.totals.totalBrutHt, expected.brutHt, `${key} brut HT`);
    assert.equal(prepared.totals.totalDiscount, expected.rebate, `${key} remise`);
    assert.equal(prepared.totals.totalNetHt, expected.netHt, `${key} net HT`);
    assert.equal(prepared.totals.tva, expected.tva, `${key} TVA`);
    assert.equal(prepared.totals.totalTtc, expected.ttc, `${key} TTC`);
    // The validator hands the lines on as they were: none received the rebate.
    assert.equal(prepared.items.every((item) => item.discountAmount === 0), true, key);
  }
  assert.equal(entry.bundle.schedule.installments[0].amountTtc, expected.instalments[0]);
});

test("a discounted document whose figures were altered is still refused", () => {
  const quote = createCommercialBatch({ scenarios: completed(3) })
    .files.find((file) => file.file === 3).bundle.documents.quote;
  const withTotals = (totals) => ({ ...quote, totals: { ...quote.totals, ...totals } });
  const onFirstLine = (field, value) => ({
    ...quote,
    items: quote.items.map((item, index) => (index === 0 ? { ...item, [field]: value } : item))
  });

  for (const [what, document] of [
    ["a forced TTC", withTotals({ totalTtc: 41000 })],
    ["the rebate dropped from the totals", withTotals({ totalHt: 35300, totalNetHt: 35300, totalDiscount: 0, tva: 7060, totalTtc: 42360 })],
    // What the validator used to compute: the rebate taken twice.
    ["the rebate taken twice in the totals", withTotals({ totalHt: 32960, totalNetHt: 32960, totalDiscount: 2340, tva: 6592, totalTtc: 39552 })],
    ["a line rebate changed", onFirstLine("discountAmount", 1000)],
    ["a line price changed", onFirstLine("unitPriceHt", 23000)],
    ["a line TTC forced", onFirstLine("totalTtc", 28800)]
  ]) {
    assert.notDeepEqual(validationErrors(document), [], `${what} was accepted`);
  }
});

test("an invalid rebate is still refused", () => {
  const quote = createCommercialBatch({ scenarios: completed(3) })
    .files.find((file) => file.file === 3).bundle.documents.quote;
  const withRebate = (discount) => ({ ...quote, discount });

  assert.equal(refusalCode(withRebate({ percent: 5, label: "Remise" })), "DISCOUNT_TARGET_REQUIRED");
  assert.equal(refusalCode(withRebate({ ...quote.discount, appliesToIndexes: [] })), "DISCOUNT_TARGET_EMPTY");
  assert.equal(refusalCode(withRebate({ ...quote.discount, appliesToIndexes: [9] })), "DISCOUNT_TARGET_UNKNOWN");
  assert.equal(refusalCode(withRebate({ ...quote.discount, percent: 120 })), "DISCOUNT_PERCENT_INVALID");
  assert.equal(refusalCode({
    ...quote,
    items: quote.items.map((item, index) => (index === 0 ? { ...item, discountAmount: 30000 } : item))
  }), "LINE_DISCOUNT_EXCEEDS_AMOUNT");
});

test("a line's own rebate, on a line the document's rebate also targets, is still its own", () => {
  // Written as a caller writes it: the line states 500 of its own, the document
  // takes 5 % on top, and the engine's totals for that input are stated.
  const items = [
    { designation: "Lit mezzanine", unit: "U", quantity: 1, unitPriceHt: 24000, discountAmount: 500 },
    { designation: "Bureau", unit: "U", quantity: 1, unitPriceHt: 4800 }
  ];
  const discount = { percent: 5, appliesToIndexes: [0], label: "Remise exceptionnelle" };
  const { totals } = calculateDocumentTotals(items, 0.2, { discount });
  const input = {
    documentType: "quote",
    documentNumber: "61",
    date: "06/09/2026",
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
    items,
    discount,
    totals: { totalHt: totals.totalHt, tva: totals.tva, totalTtc: totals.totalTtc },
    payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
  };

  assert.deepEqual(validationErrors(input), []);
  // 500 of its own, then 5 % of the 23 500 left: 1 175.
  assert.equal(preparedTotals(input).totalDiscount, 1675);
});

test("every file without a rebate still passes the validator with its published figures", () => {
  const withoutRebate = OFFICIAL_TEST.filter((entry) => entry.rebate === undefined);
  assert.equal(withoutRebate.length, 15);

  for (const expected of withoutRebate) {
    const entry = assertCompleteFilePasses(expected.file, expected.ttc);
    const totals = preparedTotals(entry.bundle.documents.invoice);
    assert.equal(totals.totalHt, expected.brutHt, `file ${expected.file} HT`);
    assert.equal(totals.tva, expected.tva, `file ${expected.file} TVA`);
    assert.equal(totals.totalTtc, expected.ttc, `file ${expected.file} TTC`);
  }
});

test("a file that states no date and no payment method is given none", () => {
  // The official test gives neither yet. The batch passes the absence on, and the
  // validator is still the one that refuses it.
  const entry = createCommercialBatch({ scenarios: withDesignations(2, ["Article 0", "Article 1", "Article 2"]) })
    .files.find((file) => file.file === 2);
  const { quote } = entry.bundle.documents;

  assert.equal(quote.date, "");
  assert.equal(quote.payment.method, "");
  assert.deepEqual([...new Set(validationErrors(quote))].sort(), ["date", "payment.method"]);
});

test("reviewBatchLines reports one missing designation per line", () => {
  // File 8 with its official names taken off: six lines, six gaps.
  const scenario = withDesignations(8, []).find((entry) => entry.index === 8);
  const missing = reviewBatchLines(scenario);

  assert.equal(missing.length, 6);
  assert.deepEqual(
    missing.map((entry) => entry.field),
    ["lines.0.designation", "lines.1.designation", "lines.2.designation",
      "lines.3.designation", "lines.4.designation", "lines.5.designation"]
  );
});

// --- ready for review, ready to issue -----------------------------------------------
//
// Two states. Ready for review: the file is built and every line is named.
// Ready to issue: that, and the validator accepts its three documents and nothing
// the bundle reports holds it back. The values below are stand-ins for the
// official data, written in this file only.

// The fields a document is refused for, without their line index, so a refusal
// reads the same for a file of three lines and for one of six.
function refusedFields(errors) {
  return [...new Set(errors.map((entry) => String(entry.field).replace(/^items\.\d+\./, "items.*.")))].sort();
}

test("every file of the official test is ready for review, and none is ready to issue", () => {
  for (const expected of priced) {
    const entry = fileOf(expected.file);
    assert.equal(entry.readyForReview, true, `file ${expected.file}`);
    assert.equal(entry.readyToIssue, false, `file ${expected.file}`);

    // Refused for what the official test does not give, and for nothing else.
    const { documents, blocking } = entry.issueReview;
    assert.deepEqual(refusedFields(documents.quote), ["date", "payment.method"], `file ${expected.file} quote`);
    assert.deepEqual(refusedFields(documents.invoice), ["date", "items.*.unit", "payment.method"], `file ${expected.file} invoice`);
    assert.deepEqual(refusedFields(documents.deliveryNote), ["date"], `file ${expected.file} delivery note`);
    assert.deepEqual(blocking, [], `file ${expected.file}: the documents agree, and every number is assigned`);
  }
  assert.equal(batch.readyForReview, true, "file 7 is built too");
  assert.equal(batch.readyToIssue, false);
});

test("named lines without a date, a payment method or a unit: ready for review, not to issue", () => {
  const two = fileOf(2);
  assert.equal(two.scenario.lines.every((line) => typeof line.designation === "string"), true);
  assert.equal(two.scenario.dates, undefined);
  assert.equal(two.scenario.paymentMethod, undefined);
  assert.equal(two.readyForReview, true);
  assert.equal(two.readyToIssue, false);
});

test("each piece the validator requires, left out alone, keeps a complete file from being issued", () => {
  const withOnly = (patch) => HKIDS_BATCH_SCENARIOS.map((scenario) => (scenario.index !== 3 ? scenario : {
    ...scenario,
    lines: scenario.lines.map((line) => ({ ...line, unit: "U" })),
    dates: STAND_IN_DATES,
    paymentMethod: "virement bancaire",
    ...patch(scenario)
  }));
  const three = (patch) => createCommercialBatch({ scenarios: withOnly(patch) }).files.find((entry) => entry.file === 3);

  // Everything supplied: ready to issue.
  assert.equal(three(() => ({})).readyToIssue, true);

  // No date: the three documents are refused for it.
  const undated = three(() => ({ dates: {} }));
  assert.equal(undated.readyForReview, true);
  assert.equal(undated.readyToIssue, false);
  for (const key of ["quote", "invoice", "deliveryNote"]) {
    assert.deepEqual(refusedFields(undated.issueReview.documents[key]), ["date"], key);
  }

  // No payment method: the quote and the invoice are refused, the delivery note carries none.
  const unpaid = three(() => ({ paymentMethod: undefined }));
  assert.equal(unpaid.readyToIssue, false);
  assert.deepEqual(refusedFields(unpaid.issueReview.documents.quote), ["payment.method"]);
  assert.deepEqual(refusedFields(unpaid.issueReview.documents.invoice), ["payment.method"]);
  assert.deepEqual(unpaid.issueReview.documents.deliveryNote, []);

  // No unit: only the invoice is refused.
  const unitless = three((scenario) => ({ lines: scenario.lines.map(({ unit, ...line }) => line) }));
  assert.equal(unitless.readyForReview, true);
  assert.equal(unitless.readyToIssue, false);
  assert.deepEqual(unitless.issueReview.documents.quote, []);
  assert.deepEqual(refusedFields(unitless.issueReview.documents.invoice), ["items.*.unit"]);
  assert.deepEqual(unitless.issueReview.documents.deliveryNote, []);
});

test("a complete file is ready to issue, and the project questions stay reported without blocking it", () => {
  const entry = assertCompleteFilePasses(2, 28440);

  // Nothing in the official test answers the installation questions or the
  // annexes' audience. They are reported, and they do not hold the documents back.
  const reportedCodes = [...new Set(entry.issueReview.reported.map((issue) => issue.code))].sort();
  assert.deepEqual(reportedCodes, [...ISSUE_CODES_NOT_BLOCKING_ISSUE].sort());
  assert.ok(entry.issueReview.reported.some((issue) => issue.field === "project.desiredDeliveryDate"));
  assert.equal(entry.bundle.documents.deliveryNote.deliveryDateText, "Date de livraison : à définir");

  // isBundleReadyToIssue holds the file back for exactly those, which is why the
  // batch does not read it.
  assert.equal(isBundleReadyToIssue(entry.bundle), false);
});

test("a blocking issue of the bundle keeps a file from being issued, an unknown one included", () => {
  const { bundle } = assertCompleteFilePasses(2, 28440);
  assert.equal(reviewFileIssue(bundle).ready, true);

  for (const code of ["TOTAL_MISMATCH", "DOCUMENT_NUMBER_PENDING_REGISTRY", "PAYMENT_SCHEDULE_MISSING", "A_CODE_NOBODY_KNOWS"]) {
    const review = reviewFileIssue({ ...bundle, issues: [...bundle.issues, { field: "x", code, message: "x" }] });
    assert.equal(review.ready, false, code);
    assert.deepEqual(review.blocking.map((issue) => issue.code), [code], code);
    // The documents themselves are still accepted: the refusal is the bundle's.
    assert.deepEqual(review.documents, { quote: [], invoice: [], deliveryNote: [] }, code);
  }
});

test("an invoice pointing at another file's quote is not ready to issue", () => {
  const { bundle } = assertCompleteFilePasses(2, 28440);
  const invoice = { ...bundle.documents.invoice, quoteReference: "99" };
  const review = reviewFileIssue({ ...bundle, documents: { ...bundle.documents, invoice } });

  assert.equal(review.ready, false);
  assert.deepEqual(review.documents.invoice.map((entry) => entry.code), ["UPSTREAM_REFERENCE_MISMATCH"]);
});

test("a rebate the engine cannot compute is a refusal, reported as the engine words it", () => {
  const { bundle } = assertCompleteFilePasses(3, 40920);
  const quote = { ...bundle.documents.quote, discount: { percent: 5, label: "Remise" } };
  const review = reviewFileIssue({ ...bundle, documents: { ...bundle.documents, quote } });

  assert.equal(review.ready, false);
  assert.deepEqual(review.documents.quote.map((entry) => entry.code), ["DISCOUNT_TARGET_REQUIRED"]);
});

test("the batch is ready to issue only when every one of its files is", () => {
  // Every file completed with stand-in data, file 7 and its fixed rebate included.
  const complete = HKIDS_BATCH_SCENARIOS.map((scenario) => ({
    ...scenario,
    lines: scenario.lines.map((line) => ({ ...line, unit: "U" })),
    dates: STAND_IN_DATES,
    paymentMethod: "virement bancaire"
  }));
  const ready = createCommercialBatch({ scenarios: complete });
  assert.equal(ready.readyForReview, true);
  assert.equal(ready.readyToIssue, true);
  assert.equal(ready.files.every((entry) => entry.readyToIssue), true);

  // One file short of a date is enough to hold the batch back, and only that file.
  const oneUndated = createCommercialBatch({
    scenarios: complete.map((scenario) => (scenario.index !== 12 ? scenario : { ...scenario, dates: {} }))
  });
  assert.equal(oneUndated.readyForReview, true);
  assert.equal(oneUndated.readyToIssue, false);
  assert.deepEqual(oneUndated.files.filter((entry) => !entry.readyToIssue).map((entry) => entry.file), [12]);
});

test("reviewing the files changes none of the official data, totals or numbers", () => {
  const before = structuredClone(HKIDS_BATCH_SCENARIOS);
  const again = createCommercialBatch();
  assert.deepEqual(structuredClone(HKIDS_BATCH_SCENARIOS), before);

  for (const expected of OFFICIAL_TEST) {
    const entry = again.files.find((file) => file.file === expected.file);
    assert.deepEqual([entry.numbers.quote, entry.numbers.invoice, entry.numbers.deliveryNote], expected.numbers);
    assert.equal(entry.bundle.totals.totalBrutHt, expected.brutHt, `file ${expected.file}`);
    assert.equal(entry.bundle.totals.totalTtc, expected.ttc, `file ${expected.file}`);
    assert.equal(Object.isFrozen(entry.bundle), true, `file ${expected.file}`);
  }
});

test("preparing and reviewing the batch generates no document", () => {
  // The module reads the validator and builds bundles; it reaches no renderer,
  // no file service and no template.
  const source = readFileSync(new URL("../src/documents/commercial-batch.js", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .* from "(.+)";$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(imports, [
    "./document-bundle-service.js",
    "./document-calculations.js",
    "./document-schema.js",
    "./document-validation.js"
  ]);

  // And nothing it returns is a rendered file.
  const rendered = [];
  const visit = (value, path) => {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      rendered.push(path);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        visit(child, `${path}.${key}`);
      }
    }
  };
  visit(createCommercialBatch(), "batch");
  assert.deepEqual(rendered, []);
});

// --- the delivery note states no price, in its fields or in its words ------------------
//
// Files 11 and 16 name a line with its price: "Deux matelas à 1600 DH", "Deux packs
// lits cabanes à 6 900 DH". The quote and the invoice keep those words; the delivery
// note repeats them without the price.

const PRICED_DESIGNATIONS = Object.freeze([
  { file: 11, index: 1, official: "Deux matelas à 1600 DH", delivered: "Deux matelas" },
  { file: 16, index: 0, official: "Deux packs lits cabanes à 6 900 DH", delivered: "Deux packs lits cabanes" }
]);

test("files 11 and 16: the quote and the invoice keep the official designation, the delivery note states no price", () => {
  for (const { file, index, official, delivered } of PRICED_DESIGNATIONS) {
    const { quote, invoice, deliveryNote } = fileOf(file).bundle.documents;
    assert.equal(quote.items[index].designation, official, `file ${file} quote`);
    assert.equal(invoice.items[index].designation, official, `file ${file} invoice`);
    assert.equal(deliveryNote.items[index].designation, delivered, `file ${file} delivery note`);
    assert.equal(deliveryNote.items[index].quantity, quote.items[index].quantity, `file ${file} quantity`);

    // The field that carries it reaches no document.
    for (const document of [quote, invoice, deliveryNote]) {
      assert.equal("deliveryNoteDesignation" in document.items[index], false, `file ${file} ${document.documentType}`);
    }
  }
});

test("no delivery note of the batch states a price, in its fields or in its words", () => {
  for (const entry of batch.files) {
    for (const item of entry.bundle.documents.deliveryNote.items) {
      assert.equal(designationStatesPrice(item.designation), false, `file ${entry.file}: "${item.designation}"`);
      assert.doesNotMatch(item.designation, /\bDH\b/, `file ${entry.file}: "${item.designation}"`);
    }
    // And each delivery note still matches the order it delivers.
    const codes = entry.bundle.issues.map((issue) => issue.code);
    assert.equal(codes.includes("ITEM_FIELD_MISMATCH"), false, `file ${entry.file}`);
    assert.equal(codes.includes("DELIVERY_NOTE_DESIGNATION_PRICED"), false, `file ${entry.file}`);
    assert.deepEqual(entry.issueReview.blocking, [], `file ${entry.file}`);
  }
});

test("the eighteen other delivery notes repeat the quote's designations, line for line", () => {
  for (const entry of batch.files.filter((file) => !PRICED_DESIGNATIONS.some((priced) => priced.file === file.file))) {
    const { quote, deliveryNote } = entry.bundle.documents;
    assert.deepEqual(
      deliveryNote.items.map((item) => item.designation),
      quote.items.map((item) => item.designation),
      `file ${entry.file}`
    );
  }
  // In 11 and 16, only the line whose designation states a price differs.
  for (const { file, index } of PRICED_DESIGNATIONS) {
    const { quote, deliveryNote } = fileOf(file).bundle.documents;
    const differing = quote.items
      .map((item, position) => position)
      .filter((position) => quote.items[position].designation !== deliveryNote.items[position].designation);
    assert.deepEqual(differing, [index], `file ${file}`);
  }
});

test("files 11 and 16, completed, pass the validator: the delivery note matches the order it delivers", () => {
  assertCompleteFilePasses(11, expectedOf(11).ttc);
  assertCompleteFilePasses(16, expectedOf(16).ttc);
});
