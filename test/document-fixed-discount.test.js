import assert from "node:assert/strict";
import test from "node:test";
import { calculateDocumentTotals, createDocumentBundle, validateAndPrepareDocument } from "../src/index.js";

/**
 * A fixed document rebate: an amount taken off the whole document, not a
 * percentage and not a share of any line.
 *
 * File 7 of the official H-KIDS test is the case it exists for. Its lines and its
 * published figures are written here, independently of the batch module, so the
 * engine is held to the figures the test publishes and not to a fixture that
 * agrees with itself. The unit, the dates and the payment method used to reach the
 * validator are stand-ins written in this file only.
 */
const SEVEN_LINES = Object.freeze([
  ["Meuble TV et espace créatif", 19500],
  ["Banquette de lecture", 14500],
  ["Tableau noir mural", 5500],
  ["Éclairage LED", 2500],
  ["Livraison/install", 2000]
]);
const SEVEN = Object.freeze({ brutHt: 44000, rebate: 2333.33, netHt: 41666.67, tva: 8333.33, ttc: 50000, deposit: 30000 });
const FIXED = Object.freeze({ fixedAmount: 2333.33, label: "Remise exceptionnelle" });

function sevenItems(extra = {}) {
  return SEVEN_LINES.map(([designation, unitPriceHt]) => ({ designation, quantity: 1, unitPriceHt, ...extra }));
}

function codeOf(run) {
  try {
    run();
    return "accepted";
  } catch (error) {
    return error.code;
  }
}

const withDiscount = (discount, items = sevenItems()) => () => calculateDocumentTotals(items, 0.2, { discount });

// --- the engine -------------------------------------------------------------------

test("file 7: 44 000,00 less a fixed 2 333,33 is 41 666,67 HT, 8 333,33 of VAT and 50 000,00 TTC", () => {
  const { totals } = calculateDocumentTotals(sevenItems(), 0.2, { discount: FIXED });

  assert.equal(totals.totalBrutHt, SEVEN.brutHt);
  assert.equal(totals.totalDiscount, SEVEN.rebate);
  assert.equal(totals.totalNetHt, SEVEN.netHt);
  assert.equal(totals.totalHt, SEVEN.netHt, "totalHt is the net, as for any rebate");
  assert.equal(totals.tva, SEVEN.tva);
  assert.equal(totals.totalTtc, SEVEN.ttc);
});

test("a fixed rebate leaves every line exactly as it is without one", () => {
  const without = calculateDocumentTotals(sevenItems(), 0.2);
  const withFixed = calculateDocumentTotals(sevenItems(), 0.2, { discount: FIXED });

  assert.deepEqual(withFixed.items, without.items);
  for (const item of withFixed.items) {
    assert.equal(item.discountAmount, 0, item.designation);
    assert.equal(item.netAmountHt, item.amountHt, item.designation);
  }
  // Only the total moves.
  assert.equal(without.totals.totalHt, SEVEN.brutHt);
  assert.equal(withFixed.totals.totalHt, SEVEN.netHt);
});

test("the rebate is reported as an amount on the document, with no percentage and no line", () => {
  const { discount } = calculateDocumentTotals(sevenItems(), 0.2, { discount: FIXED });
  assert.deepEqual({ ...discount }, {
    fixedAmount: 2333.33,
    label: "Remise exceptionnelle",
    baseHt: 44000,
    amount: 2333.33
  });
});

test("a fixed rebate and a percentage are never taken together", () => {
  for (const percent of [5, 0, "5"]) {
    assert.equal(codeOf(withDiscount({ ...FIXED, percent })), "DISCOUNT_FIXED_WITH_PERCENT", String(percent));
  }
  // Written the way a percentage is, with its lines: still two rebates, still refused.
  assert.equal(codeOf(withDiscount({ ...FIXED, percent: 5, appliesToIndexes: [0] })), "DISCOUNT_FIXED_WITH_PERCENT");
});

test("a fixed rebate names no line: it is taken on the document as a whole", () => {
  for (const appliesToIndexes of [[0], [0, 1, 2, 3, 4], []]) {
    assert.equal(
      codeOf(withDiscount({ ...FIXED, appliesToIndexes })),
      "DISCOUNT_FIXED_WITH_TARGETS",
      JSON.stringify(appliesToIndexes)
    );
  }
});

test("a negative, or unreadable, fixed rebate is refused", () => {
  for (const fixedAmount of [-1, -0.01, -2333.33, Number.NaN, Number.POSITIVE_INFINITY, "abc", true, [2333.33], {}]) {
    assert.equal(codeOf(withDiscount({ ...FIXED, fixedAmount })), "DISCOUNT_FIXED_INVALID", String(fixedAmount));
  }
});

test("a fixed rebate with more than two decimals is refused, not rounded", () => {
  for (const fixedAmount of [2333.333, 2333.335, 0.001, "2333.331"]) {
    assert.equal(codeOf(withDiscount({ ...FIXED, fixedAmount })), "DISCOUNT_FIXED_PRECISION", String(fixedAmount));
  }
});

test("a fixed rebate above the amount it is taken on is refused", () => {
  assert.equal(codeOf(withDiscount({ ...FIXED, fixedAmount: 44000.01 })), "DISCOUNT_FIXED_EXCEEDS_AMOUNT");
  assert.equal(codeOf(withDiscount({ ...FIXED, fixedAmount: 50000 })), "DISCOUNT_FIXED_EXCEEDS_AMOUNT");

  // Up to the amount itself is not above it.
  const whole = calculateDocumentTotals(sevenItems(), 0.2, { discount: { ...FIXED, fixedAmount: 44000 } });
  assert.equal(whole.totals.totalNetHt, 0);
  assert.equal(whole.totals.totalTtc, 0);
});

test("a fixed rebate is taken on what the lines come to after their own rebates, and adds to them", () => {
  const lines = [
    { designation: "Lit", quantity: 1, unitPriceHt: 1000, discountAmount: 100 },
    { designation: "Bureau", quantity: 1, unitPriceHt: 500 }
  ];

  // 1 500 gross, 100 off the bed: 1 400 is what a fixed rebate can be taken on.
  assert.equal(codeOf(withDiscount({ fixedAmount: 1400.01 }, lines)), "DISCOUNT_FIXED_EXCEEDS_AMOUNT");

  const { items, totals, discount } = calculateDocumentTotals(lines, 0.2, { discount: { fixedAmount: 400 } });
  assert.deepEqual(items.map((item) => item.discountAmount), [100, 0], "each line keeps its own rebate, and only it");
  assert.equal(totals.totalBrutHt, 1500);
  assert.equal(totals.totalDiscount, 500);
  assert.equal(totals.totalNetHt, 1000);
  assert.equal(totals.tva, 200);
  assert.equal(totals.totalTtc, 1200);
  assert.equal(discount.baseHt, 1400);
  assert.equal(discount.label, "", "no label is invented");
});

test("a percentage rebate is computed exactly as before", () => {
  // File 3: 5 % on the mezzanine alone.
  const lines = [
    { designation: "Lit mezzanine", quantity: 1, unitPriceHt: 24000 },
    { designation: "Escalier", quantity: 1, unitPriceHt: 4800 },
    { designation: "Éclairage", quantity: 1, unitPriceHt: 4500 },
    { designation: "Livraison", quantity: 1, unitPriceHt: 2000 }
  ];
  const { items, totals, discount } = calculateDocumentTotals(lines, 0.2, {
    discount: { percent: 5, appliesToIndexes: [0], label: "Remise" }
  });

  assert.deepEqual(items.map((item) => item.discountAmount), [1200, 0, 0, 0]);
  assert.deepEqual(
    [totals.totalBrutHt, totals.totalDiscount, totals.totalNetHt, totals.tva, totals.totalTtc],
    [35300, 1200, 34100, 6820, 40920]
  );
  assert.deepEqual({ ...discount, appliesToIndexes: [...discount.appliesToIndexes] }, {
    percent: 5,
    appliesToIndexes: [0],
    label: "Remise",
    baseHt: 24000,
    amount: 1200
  });

  // A discount that states neither a percentage's lines nor a fixed amount is
  // refused as it always was; an empty fixed amount is no fixed amount.
  assert.equal(codeOf(withDiscount({ label: "Remise" }, lines)), "DISCOUNT_TARGET_REQUIRED");
  assert.equal(codeOf(withDiscount({ percent: 5, fixedAmount: null, label: "Remise" }, lines)), "DISCOUNT_TARGET_REQUIRED");
  assert.equal(codeOf(withDiscount({ percent: 5, appliesToIndexes: [0], fixedAmount: "" }, lines)), "accepted");
});

// --- through the validator ---------------------------------------------------------

const STAND_IN = Object.freeze({
  dates: Object.freeze({ quoteDate: "06/09/2026", invoiceDate: "06/09/2026", deliveryNoteDate: "06/09/2026" }),
  paymentMethod: "virement bancaire",
  unit: "U"
});

function sevenBundle(discount = FIXED) {
  return createDocumentBundle({
    client: { name: "École Les Petits Explorateurs", address: "Marrakech" },
    items: sevenItems({ unit: STAND_IN.unit }),
    tvaRate: 0.2,
    discount,
    paymentScheduleRuleId: "hkids-60-20-20-2026",
    paymentMethod: STAND_IN.paymentMethod,
    dates: STAND_IN.dates,
    numbers: { quote: "67", invoice: "41", deliveryNote: "41" }
  });
}

function validationCode(document) {
  return codeOf(() => validateAndPrepareDocument(document));
}

test("the documents the engine computes pass the validator, with the rebate taken once", () => {
  const bundle = sevenBundle();
  assert.deepEqual(bundle.schedule.installments.map((entry) => entry.amountTtc).slice(0, 1), [SEVEN.deposit]);

  for (const key of ["quote", "invoice"]) {
    const prepared = validateAndPrepareDocument(bundle.documents[key]);
    assert.deepEqual(
      [prepared.totals.totalBrutHt, prepared.totals.totalDiscount, prepared.totals.totalNetHt, prepared.totals.tva, prepared.totals.totalTtc],
      [SEVEN.brutHt, SEVEN.rebate, SEVEN.netHt, SEVEN.tva, SEVEN.ttc],
      key
    );
    assert.equal(prepared.items.every((item) => item.discountAmount === 0), true, `${key}: no line received the rebate`);
  }

  // The delivery note carries no rebate at all, like every price.
  assert.equal("discount" in bundle.documents.deliveryNote, false);
  assert.equal(validationCode(bundle.documents.deliveryNote), "accepted");
});

test("a fixed rebate is never taken a second time", () => {
  const { quote } = sevenBundle().documents;

  // What the validator prepares, validated again, comes to the same figures.
  const once = validateAndPrepareDocument(quote);
  const twice = validateAndPrepareDocument(once);
  assert.deepEqual(twice.totals, once.totals);
  assert.equal(twice.totals.totalDiscount, SEVEN.rebate);

  // The rebate written on a line as well as on the document is two rebates.
  const onALineToo = {
    ...quote,
    items: quote.items.map((item, index) => (index === 0 ? { ...item, discountAmount: SEVEN.rebate } : item))
  };
  assert.equal(validationCode(onALineToo), "DOCUMENT_VALIDATION_FAILED");
});

test("a document whose figures were falsified is refused", () => {
  const { quote, invoice } = sevenBundle().documents;
  const withTotals = (document, totals) => ({ ...document, totals: { ...document.totals, ...totals } });

  for (const document of [quote, invoice]) {
    for (const [what, forged] of [
      ["a forced TTC", withTotals(document, { totalTtc: 49999.99 })],
      ["the rebate dropped", withTotals(document, { totalDiscount: 0, totalNetHt: 44000, totalHt: 44000, tva: 8800, totalTtc: 52800 })],
      ["the rebate taken twice", withTotals(document, { totalDiscount: 4666.66, totalNetHt: 39333.34, totalHt: 39333.34, tva: 7866.67, totalTtc: 47200.01 })],
      ["a smaller rebate stated", { ...document, discount: { ...document.discount, fixedAmount: 2000 } }]
    ]) {
      assert.equal(validationCode(forged), "DOCUMENT_VALIDATION_FAILED", `${document.documentType}: ${what}`);
    }
  }
});

test("an invalid fixed rebate on a document is refused by the validator", () => {
  const { quote } = sevenBundle().documents;
  assert.equal(validationCode({ ...quote, discount: { ...quote.discount, fixedAmount: 2333.333 } }), "DISCOUNT_FIXED_PRECISION");
  assert.equal(validationCode({ ...quote, discount: { ...quote.discount, percent: 5 } }), "DISCOUNT_FIXED_WITH_PERCENT");
  assert.equal(validationCode({ ...quote, discount: { ...quote.discount, fixedAmount: -1 } }), "DISCOUNT_FIXED_INVALID");
  assert.equal(validationCode({ ...quote, discount: { ...quote.discount, fixedAmount: 44000.01 } }), "DISCOUNT_FIXED_EXCEEDS_AMOUNT");
});
