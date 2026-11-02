import assert from "node:assert/strict";
import test from "node:test";
import {
  DELIVERY_NOTE_PROFILES,
  DocumentValidationError,
  FORBIDDEN_GOODS_ONLY_FIELDS,
  HKIDS_DOCUMENT_TYPES,
  PAYMENT_CONDITIONS,
  PAYMENT_SCHEDULE_RULES,
  PaymentScheduleError,
  QUOTE_NUMBER_PENDING_MESSAGE,
  SUPPORTED_PAYMENT_PLANS,
  calculateDocumentTotals,
  createDocumentBundle,
  createDocumentNumberingService,
  createInMemoryDocumentRegister,
  createPaymentSchedule,
  detectMissingInformation,
  formatMoneyAmount,
  formatQuoteNumber,
  invoiceUpstreamReference,
  isApprovedPaymentPlan,
  isControlledDocumentType,
  isSupportedPaymentPlan,
  isSupportedPaymentTerms,
  matchingPaymentTermsRule,
  parsePaymentTermsSegments,
  referenceLabelFor,
  requiredFieldsFor,
  roundMoney,
  validateAndPrepareDocument,
  validateDeliveryNoteMatchesOrder,
  validateInvoiceMatchesQuote,
  validatePaymentSchedule
} from "../src/index.js";

// The commercial file of one order: quote, invoice and delivery note derived
// from a single set of lines.
//
// The amounts are the official test case and are asserted as given. The client
// name is fictional, and no H-KIDS document number appears anywhere: the
// register has not been consulted, so every number here is either absent or a
// sequence a test register was told to hand out.

// The seven lines of the official test case, exactly as they were given:
//
//   1. Lit mezzanine sur mesure     24 000        <- discounted
//   2. Matelas enfant                1 600
//   3. Bureau evolutif               6 800        <- discounted
//   4. Armoire trois portes          8 900        <- discounted
//   5. Papier peint personnalise     3 400
//   6. Eclairage LED indirect        4 500
//   7. Livraison et installation     2 500
//
//   Brut HT 51 700 · base remise 39 700 · remise 5 % = 1 985
//   Net HT 49 715 · TVA 20 % 9 943 · TTC 59 658
//
// The figures are the business case and are asserted, never adjusted to make a
// test pass.
const FURNITURE = Object.freeze([
  { designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1, unitPriceHt: 24000 },
  { designation: "Matelas enfant", unit: "U", quantity: 1, unitPriceHt: 1600 },
  { designation: "Bureau evolutif", unit: "U", quantity: 1, unitPriceHt: 6800 },
  { designation: "Armoire trois portes", unit: "U", quantity: 1, unitPriceHt: 8900 },
  { designation: "Papier peint personnalise", unit: "U", quantity: 1, unitPriceHt: 3400 },
  { designation: "Eclairage LED indirect", unit: "U", quantity: 1, unitPriceHt: 4500 },
  { designation: "Livraison et installation", unit: "U", quantity: 1, unitPriceHt: 2500 }
]);

// 5 % on articles 1, 3 and 4 only — indexes 0, 2 and 3.
const TARGETED_DISCOUNT = Object.freeze({
  percent: 5,
  appliesToIndexes: Object.freeze([0, 2, 3]),
  label: "Remise exceptionnelle"
});

// The four lines the discount must not touch, by index.
const UNDISCOUNTED_INDEXES = Object.freeze([1, 4, 5, 6]);

const COMPLETE_PROJECT = Object.freeze({
  desiredDeliveryDate: "12/10/2026",
  fullAddress: "12 rue Exemple, Ville Exemple",
  floor: "3",
  elevator: true,
  finalDimensions: "200 x 90 cm",
  railPosition: "droite",
  powerOutlets: "2 prises",
  colours: "blanc et bois",
  handleModel: "poignee ronde",
  wallpaperVisual: "visuel-01",
  truckAccess: "possible",
  personPresentAtInstallation: "Mme Exemple"
});

function bundle(overrides = {}) {
  return createDocumentBundle({
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
    project: COMPLETE_PROJECT,
    items: FURNITURE,
    discount: TARGETED_DISCOUNT,
    paymentScheduleRuleId: "hkids-60-20-20-2026",
    paymentMethod: "virement bancaire",
    dates: { quoteDate: "06/09/2026", invoiceDate: "06/09/2026" },
    ...overrides
  });
}

// --- A : le devis est un type documentaire reconnu --------------------------

test("A — quote is a document type of its own", () => {
  assert.equal(HKIDS_DOCUMENT_TYPES.QUOTE, "quote");
  assert.equal(isControlledDocumentType("quote"), true);
  // The other types are untouched.
  assert.equal(isControlledDocumentType("invoice"), true);
  assert.equal(isControlledDocumentType("delivery_note"), true);
  assert.equal(isControlledDocumentType("purchase_order"), true);
});

// --- B, C : la remise ne touche que les lignes visées -----------------------

test("B — a discount applies to the lines it names, and to their amount", () => {
  const result = calculateDocumentTotals(FURNITURE, 0.2, { discount: TARGETED_DISCOUNT });

  assert.equal(result.discount.baseHt, 39700, "24000 + 6800 + 8900");
  assert.equal(result.discount.amount, 1985, "5 % of 39700");
  assert.deepEqual(
    TARGETED_DISCOUNT.appliesToIndexes.map((index) => result.items[index].discountAmount),
    [1200, 340, 445]
  );
});

test("C — the lines outside the discount receive nothing at all", () => {
  const result = calculateDocumentTotals(FURNITURE, 0.2, { discount: TARGETED_DISCOUNT });

  for (const index of UNDISCOUNTED_INDEXES) {
    const untouched = result.items[index];
    assert.equal(untouched.discountAmount, 0, untouched.designation);
    assert.equal(untouched.netAmountHt, untouched.amountHt, untouched.designation);
  }
  assert.deepEqual(
    UNDISCOUNTED_INDEXES.map((index) => result.items[index].designation),
    ["Matelas enfant", "Papier peint personnalise", "Eclairage LED indirect", "Livraison et installation"]
  );
});

// A percentage with no target used to be read as "every line". It is refused.
test("C — a discount that names no line is refused rather than spread", () => {
  assert.throws(
    () => calculateDocumentTotals(FURNITURE, 0.2, { discount: { percent: 5 } }),
    (error) => {
      assert.equal(error.code, "DISCOUNT_TARGET_REQUIRED");
      return true;
    }
  );
  assert.throws(
    () => calculateDocumentTotals(FURNITURE, 0.2, { discount: { percent: 5, appliesToIndexes: [] } }),
    (error) => {
      assert.equal(error.code, "DISCOUNT_TARGET_EMPTY");
      return true;
    }
  );
});

// --- D : remise globale exceptionnelle, brut / remise / net -----------------

test("D — the exceptional discount is reported as gross, rebate and net", () => {
  const { totals } = calculateDocumentTotals(FURNITURE, 0.2, { discount: TARGETED_DISCOUNT });

  assert.equal(totals.totalBrutHt, 51700);
  assert.equal(totals.totalDiscount, 1985);
  assert.equal(totals.totalNetHt, 49715);
  assert.equal(totals.totalHt, totals.totalNetHt, "the invoiced HT is the net one");
});

// --- E, F : TVA et TTC ------------------------------------------------------

test("E — VAT is 20 % of the net, not of the gross", () => {
  const { totals } = calculateDocumentTotals(FURNITURE, 0.2, { discount: TARGETED_DISCOUNT });

  assert.equal(totals.tvaRate, 0.2);
  assert.equal(totals.tva, roundMoney(49715 * 0.2));
  assert.equal(totals.tva, 9943);
  assert.notEqual(totals.tva, roundMoney(51700 * 0.2), "the gross must not be the VAT base");
});

test("F — TTC is the net plus the VAT", () => {
  const { totals } = calculateDocumentTotals(FURNITURE, 0.2, { discount: TARGETED_DISCOUNT });
  assert.equal(totals.totalTtc, 59658);
  assert.equal(totals.totalTtc, roundMoney(totals.totalNetHt + totals.tva));
});

// The whole official case in one place, from the seven lines to the three
// installments, so a change anywhere in the chain is caught here.
test("the official test case produces exactly the stated figures", () => {
  const file = bundle();

  assert.equal(file.items.length, 7);
  assert.equal(file.totals.totalBrutHt, 51700);
  assert.equal(file.discount.baseHt, 39700);
  assert.equal(file.discount.percent, 5);
  assert.equal(file.totals.totalDiscount, 1985);
  assert.equal(file.totals.totalNetHt, 49715);
  assert.equal(file.totals.tva, 9943);
  assert.equal(file.totals.totalTtc, 59658);
  assert.deepEqual(file.schedule.installments.map((entry) => entry.amountTtc), [35794.8, 11931.6, 11931.6]);
  assert.equal(roundMoney(file.schedule.installments.reduce((total, entry) => total + entry.amountTtc, 0)), 59658);
});

// The rounding case named in the request: two decimals kept, and the three
// figures agreeing exactly.
test("F — 41 666,67 + 8 333,33 = 50 000,00, kept to two decimals", () => {
  const { totals } = calculateDocumentTotals([{ designation: "Ensemble", unit: "U", quantity: 1, unitPriceHt: 41666.67 }], 0.2);

  assert.equal(totals.totalNetHt, 41666.67);
  assert.equal(totals.tva, 8333.33);
  assert.equal(totals.totalTtc, 50000);
  assert.equal(formatMoneyAmount(totals.totalNetHt), "41 666,67");
  assert.equal(formatMoneyAmount(totals.tva), "8 333,33");
  assert.equal(formatMoneyAmount(totals.totalTtc), "50 000,00");
});

// --- G, H, I, J : les quatre echeanciers ------------------------------------

test("G — the standard schedule is 60 / 20 / 20", () => {
  const schedule = createPaymentSchedule({ ruleId: "hkids-60-20-20-2026", totalTtc: 59658 });

  assert.equal(schedule.standard, true);
  assert.deepEqual(schedule.installments.map((entry) => entry.percent), [60, 20, 20]);
  assert.deepEqual(schedule.installments.map((entry) => entry.amountTtc), [35794.8, 11931.6, 11931.6]);
  assert.deepEqual(
    schedule.installments.map((entry) => entry.condition),
    ["à la commande", "avant livraison", "après installation"]
  );
  assert.equal(schedule.roundingAdjustment, 0);
});

test("H — the 50 / 30 / 20 exception", () => {
  const schedule = createPaymentSchedule({ ruleId: "hkids-50-30-20-exception", totalTtc: 50000 });
  assert.equal(schedule.standard, false);
  assert.deepEqual(schedule.installments.map((entry) => entry.percent), [50, 30, 20]);
  assert.deepEqual(schedule.installments.map((entry) => entry.amountTtc), [25000, 15000, 10000]);
});

test("I — the 40 / 40 / 20 exception", () => {
  const schedule = createPaymentSchedule({ ruleId: "hkids-40-40-20-exception", totalTtc: 50000 });
  assert.deepEqual(schedule.installments.map((entry) => entry.percent), [40, 40, 20]);
  assert.deepEqual(schedule.installments.map((entry) => entry.amountTtc), [20000, 20000, 10000]);
});

test("J — the 100 % exception is a single installment", () => {
  const schedule = createPaymentSchedule({ ruleId: "hkids-100-exception", totalTtc: 50000 });
  assert.equal(schedule.installments.length, 1);
  assert.equal(schedule.installments[0].percent, 100);
  assert.equal(schedule.installments[0].amountTtc, 50000);
});

// --- K : la somme des echeances vaut exactement le TTC ----------------------

test("K — every schedule adds up to the TTC exactly", () => {
  // 59658 divides cleanly; 47058,33 does not, and is the interesting one.
  for (const totalTtc of [59658, 50000, 47058.33, 12345.67]) {
    for (const ruleId of Object.keys(PAYMENT_SCHEDULE_RULES)) {
      const schedule = createPaymentSchedule({ ruleId, totalTtc });
      const sum = roundMoney(schedule.installments.reduce((total, entry) => total + entry.amountTtc, 0));
      assert.equal(sum, roundMoney(totalTtc), `${ruleId} on ${totalTtc}`);
      assert.deepEqual(validatePaymentSchedule(schedule), []);
    }
  }
});

// 60 / 20 / 20 of 0,07 rounds to 0,04 + 0,01 + 0,01 = 0,06, a centime short.
// The correction is carried by the last installment and reported on the
// schedule, so a reader can see that a centime was moved rather than discover
// a total that does not add up.
test("K — a rounding difference is stated instead of being absorbed silently", () => {
  const schedule = createPaymentSchedule({ ruleId: "hkids-60-20-20-2026", totalTtc: 0.07 });
  const sum = roundMoney(schedule.installments.reduce((total, entry) => total + entry.amountTtc, 0));

  assert.equal(sum, 0.07, "the schedule still adds up to the TTC");
  assert.equal(schedule.roundingAdjustment, 0.01, "the adjustment is visible on the schedule");
  assert.deepEqual(schedule.installments.map((entry) => entry.amountTtc), [0.04, 0.01, 0.02]);
});

// --- L : refus des echeanciers invalides ------------------------------------

test("L — a schedule is refused when it does not add up to 100 %", () => {
  assert.throws(
    () => createPaymentSchedule({ parts: [{ percent: 60, condition: "à la commande" }, { percent: 30, condition: "avant livraison" }], totalTtc: 1000 }),
    (error) => {
      assert.ok(error instanceof PaymentScheduleError);
      assert.equal(error.code, "SCHEDULE_PERCENT_SUM_INVALID");
      assert.match(error.message, /90 % instead of 100 %/);
      return true;
    }
  );
});

test("L — negative and above-100 percentages are refused", () => {
  for (const [parts, code] of [
    [[{ percent: -10, condition: "a" }, { percent: 110, condition: "b" }], "INSTALLMENT_PERCENT_NEGATIVE"],
    [[{ percent: 120, condition: "a" }], "INSTALLMENT_PERCENT_ABOVE_100"]
  ]) {
    assert.throws(
      () => createPaymentSchedule({ parts, totalTtc: 1000 }),
      (error) => {
        assert.equal(error.code, code);
        return true;
      }
    );
  }
});

// Adding up to 100 % is necessary and not sufficient: only the four approved
// splits are accepted, so an arbitrary plan cannot slip in through `parts`.
test("L — a balanced but unsupported plan is refused", () => {
  for (const parts of [
    [{ percent: 70, condition: "à la commande" }, { percent: 30, condition: "avant livraison" }],
    [{ percent: 25, condition: "a" }, { percent: 25, condition: "b" }, { percent: 25, condition: "c" }, { percent: 25, condition: "d" }],
    [{ percent: 20, condition: "à la commande" }, { percent: 60, condition: "avant livraison" }, { percent: 20, condition: "après installation" }]
  ]) {
    assert.throws(
      () => createPaymentSchedule({ parts, totalTtc: 50000 }),
      (error) => {
        assert.equal(error.code, "SCHEDULE_PLAN_NOT_SUPPORTED");
        return true;
      },
      parts.map((part) => part.percent).join("/")
    );
  }
});

test("L — the four approved plans are the supported ones, and only they", () => {
  assert.deepEqual(
    SUPPORTED_PAYMENT_PLANS.map((plan) => [...plan]),
    [[60, 20, 20], [50, 30, 20], [40, 40, 20], [100]]
  );
  assert.equal(isSupportedPaymentPlan([{ percent: 60 }, { percent: 20 }, { percent: 20 }]), true);
  assert.equal(isSupportedPaymentPlan([{ percent: 70 }, { percent: 30 }]), false);
});

test("L — a schedule whose amounts miss the TTC is reported", () => {
  const broken = {
    totalTtc: 1000,
    installments: [
      { percent: 60, amountTtc: 600, condition: "à la commande" },
      { percent: 40, amountTtc: 300, condition: "avant livraison" }
    ]
  };
  const errors = validatePaymentSchedule(broken);
  assert.ok(errors.some((entry) => entry.code === "SCHEDULE_TOTAL_MISMATCH"));
});

// --- M : registre absent -> aucun numero invente ----------------------------

test("M — with no register, no number is invented and the message is exact", () => {
  const numbering = createDocumentNumberingService();
  const result = numbering.requestNumber(HKIDS_DOCUMENT_TYPES.QUOTE);

  assert.equal(result.status, "pending_registry");
  assert.equal(result.number, null);
  assert.equal(result.message, "Numéro de devis à attribuer après vérification du registre.");
  assert.equal(result.message, QUOTE_NUMBER_PENDING_MESSAGE);
  assert.equal(numbering.registerAvailable(), false);
});

test("M — the quote format is prepared without a sequence being invented", () => {
  assert.throws(
    () => formatQuoteNumber({ year: 2026 }),
    (error) => {
      assert.equal(error.code, "NUMBER_SEQUENCE_REQUIRED");
      return true;
    }
  );
  // A sequence the register supplied is formatted; none is produced here.
  assert.equal(formatQuoteNumber({ year: 2026, sequence: 9001 }), "DEV-HK-2026-9001");
});

test("M — a register that answers assigns a number and refuses a duplicate", () => {
  const register = createInMemoryDocumentRegister({ sequences: { quote: 9001 } });
  const numbering = createDocumentNumberingService({ register });

  assert.equal(numbering.requestNumber(HKIDS_DOCUMENT_TYPES.QUOTE, { year: 2026 }).number, "DEV-HK-2026-9001");
  assert.throws(
    () => numbering.claimNumber(HKIDS_DOCUMENT_TYPES.QUOTE, "DEV-HK-2026-9001"),
    (error) => {
      assert.equal(error.code, "NUMBER_ALREADY_TAKEN");
      return true;
    }
  );
});

// --- N, O : les references entre documents ----------------------------------

test("N — the invoice references its quote", () => {
  const register = createInMemoryDocumentRegister({ sequences: { quote: 9001, invoice: 9001, delivery_note: 9001 } });
  const file = bundle({ numbering: createDocumentNumberingService({ register }) });

  assert.equal(file.documents.quote.documentNumber, "DEV-HK-2026-9001");
  assert.equal(file.documents.invoice.quoteReference, file.documents.quote.documentNumber);
  assert.deepEqual(validateInvoiceMatchesQuote(file.documents.quote, file.documents.invoice), []);
});

test("O — the delivery note references the quote and the invoice", () => {
  const register = createInMemoryDocumentRegister({ sequences: { quote: 9001, invoice: 9001, delivery_note: 9001 } });
  const file = bundle({ numbering: createDocumentNumberingService({ register }) });
  const { quote, invoice, deliveryNote } = file.documents;

  assert.equal(deliveryNote.quoteReference, quote.documentNumber);
  assert.equal(deliveryNote.invoiceReference, invoice.documentNumber);
  assert.deepEqual(validateDeliveryNoteMatchesOrder(quote, invoice, deliveryNote), []);
});

// --- P : le BL ne porte aucun prix ------------------------------------------

test("P — the delivery note carries designation and quantity, and no price", () => {
  const file = bundle();
  const { deliveryNote } = file.documents;

  assert.equal(deliveryNote.items.length, FURNITURE.length);
  for (const line of deliveryNote.items) {
    assert.ok(line.designation);
    assert.ok(Number.isFinite(line.quantity));
    for (const field of ["unitPriceHt", "unitPriceTtc", "amountHt", "netAmountHt", "discountAmount", "tva", "totalTtc"]) {
      assert.equal(field in line, false, `a delivery note line must not carry ${field}`);
    }
  }
  assert.equal("totals" in deliveryNote, false);
  assert.equal("payment" in deliveryNote, false);
  // And no amount of the file leaks into it in any other shape.
  assert.equal(JSON.stringify(deliveryNote).includes("59658"), false);
});

// --- Q : date de livraison a definir ----------------------------------------

test("Q — a delivery note with no date says so instead of inventing one", () => {
  const file = bundle();
  assert.equal(file.documents.deliveryNote.deliveryDateText, "Date de livraison : à définir");
  assert.equal(file.documents.deliveryNote.deliveryDateDefined, false);
  assert.equal(file.documents.deliveryNote.deliveryDate, "");
});

test("Q — a delivery date that was given is the one shown", () => {
  const file = bundle({ dates: { quoteDate: "06/09/2026", deliveryDate: "12/10/2026" } });
  assert.equal(file.documents.deliveryNote.deliveryDateText, "Date de livraison : 12/10/2026");
  assert.equal(file.documents.deliveryNote.deliveryDateDefined, true);
});

// --- R : informations manquantes --------------------------------------------

test("R — missing project information is listed, never filled in", () => {
  const missing = detectMissingInformation({ fullAddress: "12 rue Exemple", floor: "3" });
  const ids = missing.map((entry) => entry.id);

  assert.equal(missing.length, 10, "twelve fields, two answered");
  for (const expected of [
    "desiredDeliveryDate", "elevator", "finalDimensions", "railPosition", "powerOutlets",
    "colours", "handleModel", "wallpaperVisual", "truckAccess", "personPresentAtInstallation"
  ]) {
    assert.ok(ids.includes(expected), expected);
  }
  assert.equal(ids.includes("fullAddress"), false);
  assert.match(missing[0].message, /information manquante, à demander au client/);
});

test("R — a placeholder is not an answer", () => {
  const missing = detectMissingInformation({ ...COMPLETE_PROJECT, floor: "à définir", colours: "?" });
  assert.deepEqual(missing.map((entry) => entry.id).sort(), ["colours", "floor"]);
});

test("R — the bundle reports what the file is still missing", () => {
  const file = bundle({ project: { fullAddress: "12 rue Exemple" } });
  const reported = file.issues.filter((issue) => issue.code === "PROJECT_INFORMATION_MISSING");
  assert.equal(reported.length, 11);
});

// --- S : coherence devis / facture ------------------------------------------

test("S — quote and invoice state the same lines, discounts and totals", () => {
  const file = bundle();
  const { quote, invoice } = file.documents;

  assert.deepEqual(quote.items, invoice.items);
  assert.deepEqual(quote.totals, invoice.totals);
  assert.equal(quote.totals.totalDiscount, 1985);
  assert.equal(invoice.totals.totalTtc, 59658);
});

test("S — a divergence between quote and invoice is named", () => {
  const file = bundle();
  const tampered = {
    ...file.documents.invoice,
    items: file.documents.invoice.items.map((item, index) => (index === 0 ? { ...item, quantity: 2 } : item))
  };
  const errors = validateInvoiceMatchesQuote(file.documents.quote, tampered);

  assert.ok(errors.some((entry) => entry.code === "ITEM_FIELD_MISMATCH" && entry.field === "items.0.quantity"));
});

test("S — a delivery note that carries a price is refused", () => {
  const file = bundle();
  const tampered = {
    ...file.documents.deliveryNote,
    items: file.documents.deliveryNote.items.map((item) => ({ ...item, unitPriceHt: 24000 }))
  };
  const errors = validateDeliveryNoteMatchesOrder(file.documents.quote, file.documents.invoice, tampered);

  assert.ok(errors.some((entry) => entry.code === "DELIVERY_NOTE_CARRIES_PRICING"));
});

// --- the file as a whole ----------------------------------------------------

test("the bundle is one source of truth for the three documents", () => {
  const file = bundle();

  assert.equal(file.totals.totalTtc, 59658);
  assert.equal(file.schedule.installments.length, 3);
  assert.equal(roundMoney(file.schedule.installments.reduce((total, entry) => total + entry.amountTtc, 0)), file.totals.totalTtc);
  assert.deepEqual(Object.keys(file.documents).sort(), ["deliveryNote", "invoice", "quote"]);
});

// --- a goods-only delivery note refuses commercial terms outright -----------

// Accepting a field and then dropping it leaves the caller believing the
// document settles money. Each one is refused by name instead.
test("a goods-only delivery note refuses payment, discount and tvaRate", () => {
  const base = {
    documentType: "delivery_note",
    deliveryNoteProfile: DELIVERY_NOTE_PROFILES.GOODS_ONLY,
    documentNumber: "1",
    date: "06/09/2026",
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
    items: [{ designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1 }]
  };

  assert.deepEqual([...FORBIDDEN_GOODS_ONLY_FIELDS], ["payment", "discount", "tvaRate"]);

  for (const [field, value] of [
    ["payment", { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }],
    ["discount", { percent: 5, appliesToIndexes: [0] }],
    ["tvaRate", 0.2]
  ]) {
    assert.throws(
      () => validateAndPrepareDocument({ ...base, [field]: value }),
      (error) => {
        assert.ok(
          error.errors.some((entry) => entry.field === field && entry.code === "DELIVERY_NOTE_CARRIES_COMMERCIAL_TERMS"),
          `${field} must be refused by name`
        );
        return true;
      },
      field
    );
  }

  // And the clean document still passes.
  assert.equal(validateAndPrepareDocument(base).items.length, 1);
});

// --- only the four approved payment plans -----------------------------------

// `termsRule` was the only thing checked, so a plan typed straight into
// `terms` reached the document untouched.
test("free-text payment terms are held to the four approved plans", () => {
  const invoice = {
    documentType: "invoice",
    documentNumber: "1",
    date: "06/09/2026",
    quoteReference: "DEV-HK-2026-9001",
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
    items: [{ designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1, unitPriceHt: 24000 }],
    totals: { totalHt: 24000, tva: 4800, totalTtc: 28800 }
  };
  const withTerms = (terms) => ({ ...invoice, payment: { method: "virement bancaire", terms } });

  for (const terms of [
    "60 % à la commande ; 20 % avant livraison ; 20 % après installation.",
    "50 % à la commande ; 30 % avant livraison ; 20 % après installation.",
    "40 % à la commande ; 40 % avant livraison ; 20 % après installation.",
    "100 % à la commande."
  ]) {
    assert.equal(validateAndPrepareDocument(withTerms(terms)).payment.terms, terms);
  }

  for (const terms of [
    "70 % commande ; 30 % livraison",
    "25 % a ; 25 % b ; 25 % c ; 25 % d",
    "20 % à la commande ; 60 % avant livraison ; 20 % après installation.",
    "25/75",
    "Paiement comptant à la livraison"
  ]) {
    assert.throws(
      () => validateAndPrepareDocument(withTerms(terms)),
      (error) => {
        assert.ok(
          error.errors.some((entry) => entry.field === "payment.terms" && entry.code === "UNSUPPORTED_PAYMENT_TERMS"),
          `${terms} must be refused`
        );
        return true;
      },
      terms
    );
  }
});

// Percentages alone were not enough. 60/20/20 released in the wrong order says
// something entirely different: the balance would fall due before the deposit.
test("written terms are matched on the conditions and their order, not only the shares", () => {
  const invoice = {
    documentType: "invoice",
    documentNumber: "1",
    date: "06/09/2026",
    quoteReference: "DEV-HK-2026-9001",
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
    items: [{ designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1, unitPriceHt: 24000 }],
    totals: { totalHt: 24000, tva: 4800, totalTtc: 28800 }
  };
  const withTerms = (terms) => ({ ...invoice, payment: { method: "virement bancaire", terms } });

  const refused = (terms) => {
    assert.equal(isSupportedPaymentTerms(terms), false, terms);
    assert.equal(matchingPaymentTermsRule(terms), null, terms);
    assert.throws(
      () => validateAndPrepareDocument(withTerms(terms)),
      (error) => {
        assert.ok(error.errors.some((entry) => entry.field === "payment.terms" && entry.code === "UNSUPPORTED_PAYMENT_TERMS"));
        return true;
      },
      terms
    );
  };

  // 1 — the official standard passes, and names the rule it is.
  const standard = PAYMENT_SCHEDULE_RULES["hkids-60-20-20-2026"].label;
  assert.equal(matchingPaymentTermsRule(standard).id, "hkids-60-20-20-2026");
  assert.equal(validateAndPrepareDocument(withTerms(standard)).payment.terms, standard);

  // 2 — the case Codex found: right shares, conditions shuffled.
  refused("60 % après installation ; 20 % à la commande ; 20 % avant livraison");

  // 3 — right shares, conditions nobody recognises.
  refused("60 % foo ; 20 % bar ; 20 % baz");

  // 4 — the same three conditions, carrying the wrong shares.
  refused("20 % à la commande ; 20 % avant livraison ; 60 % après installation");

  // 7 — a split that was never approved.
  refused("70 % à la commande ; 30 % avant livraison");

  // 8 — nothing to check a rule against.
  refused("Paiement comptant a la livraison");

  // A condition carrying extra terms is not that condition.
  refused("60 % à la commande et avant livraison ; 20 % avant livraison ; 20 % après installation");
});

// The explicit `parts` list is the second way into a schedule, and it was gated
// on the percentages alone. 60/20/20 with the conditions shuffled is the same
// split and a different agreement — the balance would fall due before the
// deposit — so both routes now answer to the same rule.
test("an explicit parts list is held to the conditions and their order too", () => {
  const C = PAYMENT_CONDITIONS;
  const build = (parts) => createPaymentSchedule({ parts, totalTtc: 59658 });

  // The four official plans, given as parts, are accepted and recognised as the
  // rule they are.
  for (const [ruleId, parts] of [
    ["hkids-60-20-20-2026", [
      { percent: 60, condition: C.ON_ORDER },
      { percent: 20, condition: C.BEFORE_DELIVERY },
      { percent: 20, condition: C.AFTER_INSTALLATION }
    ]],
    ["hkids-50-30-20-exception", [
      { percent: 50, condition: C.ON_ORDER },
      { percent: 30, condition: C.BEFORE_DELIVERY },
      { percent: 20, condition: C.AFTER_INSTALLATION }
    ]],
    ["hkids-40-40-20-exception", [
      { percent: 40, condition: C.ON_ORDER },
      { percent: 40, condition: C.BEFORE_DELIVERY },
      { percent: 20, condition: C.AFTER_INSTALLATION }
    ]],
    ["hkids-100-exception", [{ percent: 100, condition: C.ON_ORDER }]]
  ]) {
    const schedule = build(parts);
    assert.equal(schedule.ruleId, ruleId);
    assert.equal(schedule.label, PAYMENT_SCHEDULE_RULES[ruleId].label);
    assert.equal(isApprovedPaymentPlan(parts), true, ruleId);
  }

  // Conditions reversed: the split matches, the agreement does not.
  const reversed = [
    { percent: 60, condition: C.AFTER_INSTALLATION },
    { percent: 20, condition: C.ON_ORDER },
    { percent: 20, condition: C.BEFORE_DELIVERY }
  ];
  // The percentage-only view still says yes, which is exactly why it must not
  // be the gate.
  assert.equal(isSupportedPaymentPlan(reversed), true);
  assert.equal(isApprovedPaymentPlan(reversed), false);

  for (const [label, parts] of [
    ["conditions reversed", reversed],
    ["conditions nobody recognises", [
      { percent: 60, condition: "foo" },
      { percent: 20, condition: "bar" },
      { percent: 20, condition: "baz" }
    ]],
    ["no conditions at all", [{ percent: 60 }, { percent: 20 }, { percent: 20 }]],
    ["a split never approved", [
      { percent: 70, condition: C.ON_ORDER },
      { percent: 30, condition: C.BEFORE_DELIVERY }
    ]]
  ]) {
    assert.throws(
      () => build(parts),
      (error) => {
        assert.ok(error instanceof PaymentScheduleError, label);
        assert.equal(error.code, "SCHEDULE_PLAN_NOT_SUPPORTED", label);
        return true;
      },
      label
    );
  }
});

// paymentScheduleParts hands a parts list straight to createPaymentSchedule, so
// the bundle must not be a way round the rule.
test("the bundle cannot slip an unapproved plan through paymentScheduleParts", () => {
  const C = PAYMENT_CONDITIONS;

  assert.throws(
    () => bundle({
      paymentScheduleRuleId: null,
      paymentScheduleParts: [
        { percent: 60, condition: C.AFTER_INSTALLATION },
        { percent: 20, condition: C.ON_ORDER },
        { percent: 20, condition: C.BEFORE_DELIVERY }
      ]
    }),
    (error) => {
      assert.equal(error.code, "SCHEDULE_PLAN_NOT_SUPPORTED");
      return true;
    }
  );

  // And the official plan, given the same way, goes through.
  const file = bundle({
    paymentScheduleRuleId: null,
    paymentScheduleParts: [
      { percent: 60, condition: C.ON_ORDER },
      { percent: 20, condition: C.BEFORE_DELIVERY },
      { percent: 20, condition: C.AFTER_INSTALLATION }
    ]
  });
  assert.equal(file.schedule.ruleId, "hkids-60-20-20-2026");
  assert.deepEqual(file.schedule.installments.map((entry) => entry.amountTtc), [35794.8, 11931.6, 11931.6]);
});

// Capitals, missing accents and a trailing full stop change the typing, not the
// condition. Folding them away keeps the check about the business rule.
test("the wording is read past capitals, accents and punctuation", () => {
  assert.equal(
    matchingPaymentTermsRule("60% A LA COMMANDE ; 20% AVANT LIVRAISON ; 20% APRES INSTALLATION").id,
    "hkids-60-20-20-2026"
  );
  assert.deepEqual(
    parsePaymentTermsSegments("100 % à la commande."),
    [{ percent: 100, condition: "a la commande" }]
  );
  // Two shares in one segment is not a list of installments.
  assert.equal(parsePaymentTermsSegments("50% avance 50 % à la livraison avant le montage"), null);
  assert.equal(parsePaymentTermsSegments(""), null);
});

test("the four approved rules still select their own wording", () => {
  const invoice = {
    documentType: "invoice",
    documentNumber: "1",
    date: "06/09/2026",
    quoteReference: "DEV-HK-2026-9001",
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
    items: [{ designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1, unitPriceHt: 24000 }],
    totals: { totalHt: 24000, tva: 4800, totalTtc: 28800 }
  };

  for (const ruleId of Object.keys(PAYMENT_SCHEDULE_RULES)) {
    const prepared = validateAndPrepareDocument({
      ...invoice,
      payment: { method: "virement bancaire", termsRule: ruleId }
    });
    assert.equal(prepared.payment.terms, PAYMENT_SCHEDULE_RULES[ruleId].label, ruleId);
  }
});

// --- the two flows an invoice can belong to ---------------------------------

// The historical H-KIDS invoice follows a delivery note; the commercial file
// runs quote first. Requiring one reference in particular would break the
// other, so an invoice must carry at least one of them.
test("an invoice references its quote, or its delivery note, but not nothing", () => {
  const priced = {
    documentNumber: "1",
    date: "06/09/2026",
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
    items: [{ designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1, unitPriceHt: 24000 }],
    totals: { totalHt: 24000, tva: 4800, totalTtc: 28800 },
    payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
  };

  // The new flow.
  assert.equal(
    validateAndPrepareDocument({ ...priced, documentType: "invoice", quoteReference: "DEV-HK-2026-9001" }).quoteReference,
    "DEV-HK-2026-9001"
  );
  // The historical flow, still accepted.
  assert.equal(
    validateAndPrepareDocument({ ...priced, documentType: "invoice", deliveryNoteReference: "98" }).deliveryNoteReference,
    "98"
  );
  // Neither is refused.
  assert.throws(
    () => validateAndPrepareDocument({ ...priced, documentType: "invoice" }),
    (error) => {
      assert.ok(error instanceof DocumentValidationError);
      assert.ok(error.errors.some((entry) => entry.code === "UPSTREAM_REFERENCE_MISSING"));
      return true;
    }
  );
  // deliveryNoteReference is no longer required on its own.
  assert.equal(requiredFieldsFor("invoice").includes("deliveryNoteReference"), false);
});

// Nothing inside a single invoice says a quote number and a delivery note
// number belong to the same file, and deducing it from the shape of the
// numbers would be inventing a numbering rule. So both references together are
// accepted only when the caller states what the two upstream documents are.
test("an invoice carrying both references must say which file they belong to", () => {
  const invoice = {
    documentType: "invoice",
    documentNumber: "1",
    date: "06/09/2026",
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
    items: [{ designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1, unitPriceHt: 24000 }],
    totals: { totalHt: 24000, tva: 4800, totalTtc: 28800 },
    payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" },
    quoteReference: "DEV-HK-2026-9001",
    deliveryNoteReference: "98"
  };

  // Unverifiable: refused rather than assumed coherent.
  assert.throws(
    () => validateAndPrepareDocument(invoice),
    (error) => {
      assert.ok(error.errors.some((entry) => entry.code === "UPSTREAM_REFERENCE_CONFLICT"));
      return true;
    }
  );

  // Both stated and matching: accepted.
  const coherent = validateAndPrepareDocument(invoice, {
    relatedDocuments: { quoteNumber: "DEV-HK-2026-9001", deliveryNoteNumber: "98" }
  });
  assert.equal(coherent.quoteReference, "DEV-HK-2026-9001");
  assert.equal(coherent.deliveryNoteReference, "98");

  // Both stated and contradicting: refused, naming the field that disagrees.
  assert.throws(
    () => validateAndPrepareDocument(
      { ...invoice, deliveryNoteReference: "BL-HK-2026-9999" },
      { relatedDocuments: { quoteNumber: "DEV-HK-2026-9001", deliveryNoteNumber: "98" } }
    ),
    (error) => {
      assert.ok(error.errors.some((entry) => entry.field === "deliveryNoteReference" && entry.code === "UPSTREAM_REFERENCE_MISMATCH"));
      return true;
    }
  );
});

// --- the reference an invoice actually prints -------------------------------

test("an invoice renders the reference it carries, and never invents one", () => {
  const quoteFlow = { documentType: "invoice", quoteReference: "DEV-HK-2026-9001" };
  const historicalFlow = { documentType: "invoice", deliveryNoteReference: "98" };

  assert.deepEqual(
    { ...invoiceUpstreamReference(quoteFlow) },
    { field: "quoteReference", label: "Référence devis", value: "DEV-HK-2026-9001" }
  );
  assert.deepEqual(
    { ...invoiceUpstreamReference(historicalFlow) },
    { field: "deliveryNoteReference", label: "Référence BL", value: "98" }
  );

  // What the Word renderer prints.
  assert.equal(referenceLabelFor(quoteFlow), "Référence devis: DEV-HK-2026-9001");
  assert.equal(referenceLabelFor(historicalFlow), "Référence BL: 98");

  // An invoice referencing nothing prints nothing rather than an empty label.
  assert.equal(invoiceUpstreamReference({ documentType: "invoice" }), null);
  assert.equal(referenceLabelFor({ documentType: "invoice" }), "");
});

// The file needs real numbers for this: with no register the quote has none,
// and there is nothing for the invoice's reference to disagree with.
test("a quote reference that does not match its quote is reported", () => {
  const register = createInMemoryDocumentRegister({ sequences: { quote: 9001, invoice: 9001, delivery_note: 9001 } });
  const file = bundle({ numbering: createDocumentNumberingService({ register }) });
  const tampered = { ...file.documents.invoice, quoteReference: "DEV-HK-2026-0000" };

  assert.equal(file.documents.quote.documentNumber, "DEV-HK-2026-9001");
  const errors = validateInvoiceMatchesQuote(file.documents.quote, tampered);
  assert.ok(errors.some((entry) => entry.field === "quoteReference" && entry.code === "REFERENCE_MISMATCH"));

  // And the untouched invoice still agrees with its quote.
  assert.deepEqual(validateInvoiceMatchesQuote(file.documents.quote, file.documents.invoice), []);
});

// --- the two shapes a delivery note can take --------------------------------

test("a goods-only delivery note validates with no totals and no payment", () => {
  const delivered = validateAndPrepareDocument({
    documentType: "delivery_note",
    deliveryNoteProfile: DELIVERY_NOTE_PROFILES.GOODS_ONLY,
    documentNumber: "1",
    date: "06/09/2026",
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
    items: [{ designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1 }]
  });

  assert.deepEqual(delivered.items, [{ designation: "Lit mezzanine sur mesure", quantity: 1, unit: "U" }]);
  for (const field of ["totals", "payment", "tvaRate", "discount"]) {
    assert.equal(field in delivered, false, `a goods-only delivery note must not carry ${field}`);
  }
  assert.deepEqual(
    [...requiredFieldsFor("delivery_note", { deliveryNoteProfile: DELIVERY_NOTE_PROFILES.GOODS_ONLY })],
    ["documentType", "documentNumber", "date", "client.name", "client.address", "items"]
  );
});

test("a price sent to a goods-only delivery note is refused, not dropped", () => {
  const base = {
    documentType: "delivery_note",
    deliveryNoteProfile: DELIVERY_NOTE_PROFILES.GOODS_ONLY,
    documentNumber: "1",
    date: "06/09/2026",
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" }
  };

  for (const patch of [
    { items: [{ designation: "Lit", unit: "U", quantity: 1, unitPriceHt: 24000 }] },
    { items: [{ designation: "Lit", unit: "U", quantity: 1 }], totals: { totalHt: 24000, tva: 4800, totalTtc: 28800 } }
  ]) {
    assert.throws(
      () => validateAndPrepareDocument({ ...base, ...patch }),
      (error) => {
        assert.ok(error.errors.some((entry) => entry.code === "DELIVERY_NOTE_CARRIES_PRICING"));
        return true;
      }
    );
  }
});

// The official H-KIDS delivery note does carry prices — its columns are
// "Image, Désignation, Qté, Pu HT, Total HT". The default profile keeps it
// working exactly as before.
test("the historical priced delivery note is unaffected", () => {
  const legacy = validateAndPrepareDocument({
    documentType: "delivery_note",
    documentNumber: "98",
    date: "06/09/2026",
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
    items: [{ designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1, unitPriceHt: 24000 }],
    totals: { totalHt: 24000, tva: 4800, totalTtc: 28800 },
    payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
  });

  assert.equal(legacy.totals.totalTtc, 28800);
  assert.equal(legacy.items[0].unitPriceHt, 24000);
  assert.equal(legacy.payment.method, "virement bancaire");
});

// --- every priced field is compared -----------------------------------------

test("an invoice diverging on any priced field is caught", () => {
  const file = bundle();
  const { quote, invoice } = file.documents;

  for (const [field, value] of [
    ["quantity", 2],
    ["unitPriceHt", 25000],
    ["discountAmount", 0],
    ["amountHt", 25000],
    ["netAmountHt", 23000],
    ["tva", 1],
    ["unitPriceTtc", 1],
    ["totalTtc", 1]
  ]) {
    const tampered = {
      ...invoice,
      items: invoice.items.map((item, index) => (index === 0 ? { ...item, [field]: value } : item))
    };
    const errors = validateInvoiceMatchesQuote(quote, tampered);
    assert.ok(
      errors.some((entry) => entry.field === `items.0.${field}` && entry.code === "ITEM_FIELD_MISMATCH"),
      `a change of ${field} must be reported`
    );
  }
});

test("a file with no register number is reported as pending, not blocked silently", () => {
  const file = bundle();
  const pending = file.issues.filter((issue) => issue.code === "DOCUMENT_NUMBER_PENDING_REGISTRY");

  assert.equal(pending.length, 3, "quote, invoice and delivery note");
  assert.equal(
    pending.find((issue) => issue.field === "documents.quote.documentNumber").message,
    "Numéro de devis à attribuer après vérification du registre."
  );
});
