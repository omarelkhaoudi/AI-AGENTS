import assert from "node:assert/strict";
import test from "node:test";
import {
  DELIVERABLE_AUDIENCES,
  DELIVERY_NOTE_PROFILES,
  HKIDS_ANNEX_KINDS,
  HKIDS_COMMERCIAL_DOCUMENT_KINDS,
  PAYMENT_CONDITIONS,
  PROJECT_INFORMATION_FIELDS,
  clientDeliverables,
  createDocumentBundle,
  createDocumentNumberingService,
  createInMemoryDocumentRegister,
  internalDeliverables,
  isBundleReadyToIssue,
  reviewProjectInformation,
  roundMoney,
  validateAndPrepareDocument,
  validateDeliveryNoteMatchesOrder,
  validateInvoiceMatchesQuote
} from "../src/index.js";

/**
 * The commercial file as one object: the three documents a customer sees and
 * the papers derived from the same figures.
 *
 * The case below is the one the specification states. Every amount asserted
 * here is *derived* by the modules that own the arithmetic — nothing in the
 * bundle recomputes a total, a rebate or an installment, and nothing in this
 * file hardcodes one into the business logic.
 *
 * The client is invented. A committed fixture is read by whoever clones the
 * repository, so it never carries the name or the address of a real customer.
 */

const OFFICIAL_CASE_ITEMS = Object.freeze([
  { designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1, unitPriceHt: 24000 },
  { designation: "Matelas enfant", unit: "U", quantity: 1, unitPriceHt: 1600 },
  { designation: "Bureau evolutif", unit: "U", quantity: 1, unitPriceHt: 6800 },
  { designation: "Armoire trois portes", unit: "U", quantity: 1, unitPriceHt: 8900 },
  { designation: "Papier peint personnalise", unit: "U", quantity: 1, unitPriceHt: 3400 },
  { designation: "Eclairage LED indirect", unit: "U", quantity: 1, unitPriceHt: 4500 },
  { designation: "Livraison et installation", unit: "U", quantity: 1, unitPriceHt: 2500 }
]);

// 5 % on lines 1, 3 and 4 of the specification, which are indexes 0, 2 and 3.
const OFFICIAL_DISCOUNT = Object.freeze({
  percent: 5,
  appliesToIndexes: Object.freeze([0, 2, 3]),
  label: "Remise exceptionnelle"
});

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

function commercialFile(overrides = {}) {
  return createDocumentBundle({
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
    project: COMPLETE_PROJECT,
    items: OFFICIAL_CASE_ITEMS,
    discount: OFFICIAL_DISCOUNT,
    paymentScheduleRuleId: "hkids-60-20-20-2026",
    paymentMethod: "virement bancaire",
    dates: { quoteDate: "06/09/2026", invoiceDate: "06/09/2026" },
    ...overrides
  });
}

function numberedFile(overrides = {}) {
  const register = createInMemoryDocumentRegister({
    sequences: { quote: 9001, invoice: 9001, delivery_note: 9001 }
  });
  return commercialFile({ numbering: createDocumentNumberingService({ register }), ...overrides });
}

// --- the file as a whole ----------------------------------------------------

test("a complete commercial file carries its documents, its deliverables and what it lacks", () => {
  const file = commercialFile();

  assert.deepEqual(Object.keys(file.documents).sort(), ["deliveryNote", "invoice", "quote"]);
  // Three commercial documents and five annexes.
  assert.deepEqual(
    Object.values(file.deliverables).map((entry) => entry.kind).sort(),
    [...HKIDS_COMMERCIAL_DOCUMENT_KINDS, ...HKIDS_ANNEX_KINDS].sort()
  );
  assert.equal(HKIDS_COMMERCIAL_DOCUMENT_KINDS.length, 3);
  assert.equal(HKIDS_ANNEX_KINDS.length, 5);
  assert.ok(Array.isArray(file.missingInformation));
  assert.ok(Array.isArray(file.issues));
});

// The specification's own figures, none of them written into the code.
test("the official case is derived, not hardcoded", () => {
  const { totals, discount, schedule } = commercialFile();

  assert.equal(totals.totalBrutHt, 51700);
  assert.equal(discount.baseHt, 39700, "24000 + 6800 + 8900");
  assert.equal(totals.totalDiscount, 1985);
  assert.equal(totals.totalNetHt, 49715);
  assert.equal(totals.tva, 9943);
  assert.equal(totals.totalTtc, 59658);

  assert.deepEqual(schedule.installments.map((entry) => entry.percent), [60, 20, 20]);
  assert.deepEqual(schedule.installments.map((entry) => entry.amountTtc), [35794.8, 11931.6, 11931.6]);
  assert.deepEqual(
    schedule.installments.map((entry) => entry.condition),
    [PAYMENT_CONDITIONS.ON_ORDER, PAYMENT_CONDITIONS.BEFORE_DELIVERY, PAYMENT_CONDITIONS.AFTER_INSTALLATION]
  );
});

// One calculation feeds everything. If a deliverable held figures of its own,
// the file could say two different things about the same order.
test("every deliverable reads the same figures", () => {
  const file = commercialFile();
  const { quote, invoice } = file.documents;
  const { orderSummary, calculationSheet, depositRequest } = file.deliverables;

  assert.deepEqual(quote.totals, file.totals);
  assert.deepEqual(invoice.totals, file.totals);
  assert.deepEqual(orderSummary.totals, file.totals);
  assert.deepEqual(calculationSheet.totals, file.totals);
  assert.equal(depositRequest.totalTtc, file.totals.totalTtc);

  // And the lines are the same lines.
  assert.equal(calculationSheet.lines.length, file.items.length);
  calculationSheet.lines.forEach((line, index) => {
    assert.equal(line.netAmountHt, file.items[index].netAmountHt);
    assert.equal(line.discountAmount, file.items[index].discountAmount);
  });
});

test("the invoice cannot diverge from the quote", () => {
  const file = numberedFile();
  assert.deepEqual(validateInvoiceMatchesQuote(file.documents.quote, file.documents.invoice), []);
  assert.deepEqual(file.documents.quote.items, file.documents.invoice.items);
  assert.equal(file.documents.invoice.quoteReference, file.documents.quote.documentNumber);
});

// --- the commercial delivery note ------------------------------------------

test("the commercial delivery note is goods-only and states no price", () => {
  const file = numberedFile();
  const { deliveryNote } = file.documents;

  assert.equal(deliveryNote.deliveryNoteProfile, DELIVERY_NOTE_PROFILES.GOODS_ONLY);
  assert.deepEqual(validateDeliveryNoteMatchesOrder(file.documents.quote, file.documents.invoice, deliveryNote), []);

  for (const line of deliveryNote.items) {
    for (const field of ["unitPriceHt", "unitPriceTtc", "amountHt", "netAmountHt", "discountAmount", "tva", "totalTtc"]) {
      assert.equal(field in line, false, `a delivery note line must not carry ${field}`);
    }
  }
  assert.equal("totals" in deliveryNote, false);
  assert.equal("payment" in deliveryNote, false);
  // No amount of the file leaks into it in any other shape.
  assert.equal(JSON.stringify(deliveryNote).includes("59658"), false);
  assert.equal(JSON.stringify(deliveryNote).includes("35794"), false);
});

// The historical priced delivery note is a different document and still works.
test("the historical priced delivery note is untouched by the commercial file", () => {
  const historical = validateAndPrepareDocument({
    documentType: "delivery_note",
    documentNumber: "98",
    date: "06/09/2026",
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
    items: [{ designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1, unitPriceHt: 24000 }],
    totals: { totalHt: 24000, tva: 4800, totalTtc: 28800 },
    payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
  });

  assert.equal(historical.deliveryNoteProfile, DELIVERY_NOTE_PROFILES.PRICED);
  assert.equal(historical.totals.totalTtc, 28800);
  assert.equal(historical.payment.method, "virement bancaire");
});

// --- the derived deliverables ----------------------------------------------

test("the order summary recaps the order without restating its arithmetic", () => {
  const { deliverables, items, totals } = commercialFile();
  const summary = deliverables.orderSummary;

  assert.equal(summary.lineCount, 7);
  assert.equal(summary.totalQuantity, 7);
  assert.deepEqual([...summary.designations], items.map((item) => item.designation));
  assert.equal(summary.totals.totalTtc, totals.totalTtc);
  assert.equal(summary.paymentScheduleRuleId, "hkids-60-20-20-2026");
  assert.match(summary.paymentTerms, /60 % à la commande/);
});

test("the calculation sheet shows each line gross, discounted and net", () => {
  const { deliverables } = commercialFile();
  const sheet = deliverables.calculationSheet;

  assert.equal(sheet.lines.length, 7);
  assert.deepEqual(sheet.lines.map((line) => line.grossAmountHt), [24000, 1600, 6800, 8900, 3400, 4500, 2500]);
  assert.deepEqual(sheet.lines.map((line) => line.discountAmount), [1200, 0, 340, 445, 0, 0, 0]);
  assert.deepEqual(sheet.lines.map((line) => line.netAmountHt), [22800, 1600, 6460, 8455, 3400, 4500, 2500]);

  // The rebate base is stated, so a reader can check the 5 % without guessing
  // which lines it applied to.
  assert.equal(sheet.discount.percent, 5);
  assert.deepEqual([...sheet.discount.appliesToIndexes], [0, 2, 3]);
  assert.equal(sheet.discount.baseHt, 39700);
  assert.equal(roundMoney(sheet.lines.reduce((total, line) => total + line.netAmountHt, 0)), sheet.totals.totalNetHt);
});

test("the deposit request is taken from the schedule, never from a percentage of its own", () => {
  const file = commercialFile();
  const deposit = file.deliverables.depositRequest;
  const first = file.schedule.installments[0];

  assert.equal(deposit.available, true);
  assert.equal(deposit.percent, first.percent);
  assert.equal(deposit.amountTtc, first.amountTtc);
  assert.equal(deposit.amountTtc, 35794.8);
  assert.equal(deposit.condition, PAYMENT_CONDITIONS.ON_ORDER);
  assert.equal(deposit.paymentScheduleRuleId, "hkids-60-20-20-2026");
});

// A different plan moves the deposit. Nothing assumes 60 %.
test("the deposit follows whichever approved plan the file uses", () => {
  for (const [ruleId, percent, amount] of [
    ["hkids-50-30-20-exception", 50, 29829],
    ["hkids-40-40-20-exception", 40, 23863.2],
    ["hkids-100-exception", 100, 59658]
  ]) {
    const deposit = commercialFile({ paymentScheduleRuleId: ruleId }).deliverables.depositRequest;
    assert.equal(deposit.percent, percent, ruleId);
    assert.equal(deposit.amountTtc, amount, ruleId);
  }
});

// With no plan there is nothing to ask for, and a zero would read as "nothing
// is due".
test("with no schedule chosen there is no deposit, and the file says so", () => {
  const file = commercialFile({ paymentScheduleRuleId: null });
  const deposit = file.deliverables.depositRequest;

  assert.equal(deposit.available, false);
  assert.equal(deposit.amountTtc, null);
  assert.equal(deposit.percent, null);
  assert.ok(file.issues.some((issue) => issue.code === "DEPOSIT_REQUEST_UNAVAILABLE"));
  assert.ok(file.issues.some((issue) => issue.code === "PAYMENT_SCHEDULE_MISSING"));
});

test("the internal tracking sheet reports the file's state and invents nothing", () => {
  const file = commercialFile();
  const sheet = file.deliverables.internalTrackingSheet;

  assert.equal(sheet.paymentScheduleChosen, true);
  assert.equal(sheet.paymentScheduleRuleId, "hkids-60-20-20-2026");
  assert.equal(sheet.missingInformationCount, 0);
  assert.equal(sheet.criticalMissingInformationCount, 0);

  // No number was invented to fill the sheet in.
  assert.deepEqual(
    Object.values(sheet.numbers).map((entry) => entry.status),
    ["pending_registry", "pending_registry", "pending_registry"]
  );
  assert.deepEqual(Object.values(sheet.numbers).map((entry) => entry.number), [null, null, null]);

  // No delivery date was given, and the sheet reports that rather than a date.
  assert.equal(sheet.deliveryDateDefined, false);
  assert.equal(sheet.deliveryDateText, "Date de livraison : à définir");
});

// --- audiences --------------------------------------------------------------

test("each deliverable states who it is for, and the unsettled ones are reported", () => {
  const file = commercialFile();

  assert.deepEqual(
    clientDeliverables(file).map((entry) => entry.kind).sort(),
    ["delivery_note", "deposit_request", "invoice", "quote"]
  );
  assert.deepEqual(
    internalDeliverables(file).map((entry) => entry.kind).sort(),
    ["calculation_sheet", "internal_tracking_sheet", "missing_information_list", "order_summary"]
  );
  for (const entry of Object.values(file.deliverables)) {
    assert.ok(Object.values(DELIVERABLE_AUDIENCES).includes(entry.audience), entry.kind);
  }

  // Three classifications are not decided by anything in this repository. They
  // are surfaced as a question for H-KIDS rather than settled here.
  //
  // missing_information_list is one of them: read as internal because it lists
  // questions the team still has to ask, but a company may equally send that
  // list to the customer to have it filled in. Nothing here says which H-KIDS
  // does, so it is not marked as settled.
  const unconfirmed = file.issues.filter((issue) => issue.code === "DELIVERABLE_AUDIENCE_UNCONFIRMED");
  assert.deepEqual(
    unconfirmed.map((issue) => issue.field).sort(),
    [
      "deliverables.calculation_sheet.audience",
      "deliverables.missing_information_list.audience",
      "deliverables.order_summary.audience"
    ]
  );

  // Everything the code claims as settled must be settled by the document
  // itself, not by a reading made here.
  assert.deepEqual(
    Object.values(file.deliverables).filter((entry) => entry.audienceConfirmed).map((entry) => entry.kind).sort(),
    ["delivery_note", "deposit_request", "internal_tracking_sheet", "invoice", "quote"]
  );
});

// --- what the file is missing -----------------------------------------------

test("missing project information is listed, never replaced by a value", () => {
  const file = commercialFile({ project: { fullAddress: "12 rue Exemple" } });

  assert.equal(file.missingInformation.length, 11);
  assert.equal(file.deliverables.internalTrackingSheet.missingInformationCount, 11);
  for (const entry of file.missingInformation) {
    assert.equal(entry.status, "missing");
    assert.match(entry.message, /information manquante, à demander au client/);
  }
  // The sheet carries the project as given, with nothing added to it.
  assert.deepEqual(file.deliverables.internalTrackingSheet.project, { fullAddress: "12 rue Exemple" });
});

test("an absent official number is reported, and no number is invented", () => {
  const file = commercialFile();
  const pending = file.issues.filter((issue) => issue.code === "DOCUMENT_NUMBER_PENDING_REGISTRY");

  assert.equal(pending.length, 3);
  assert.equal(
    pending.find((issue) => issue.field === "documents.quote.documentNumber").message,
    "Numéro de devis à attribuer après vérification du registre."
  );
  for (const document of Object.values(file.documents)) {
    assert.equal(document.documentNumber, null);
    assert.equal(document.numberStatus, "pending_registry");
  }
  assert.equal(isBundleReadyToIssue(file), false);
});

// A test sequence stays a test sequence: it comes from the register the caller
// supplied, and the file never promotes one to an official number.
test("a number only appears when a register supplied it", () => {
  const file = numberedFile();

  assert.equal(file.documents.quote.documentNumber, "DEV-HK-2026-9001");
  assert.equal(file.documents.quote.numberStatus, "assigned");
  assert.equal(file.issues.some((issue) => issue.code === "DOCUMENT_NUMBER_PENDING_REGISTRY"), false);
});

// --- no placeholder passed off as a fact ------------------------------------

test("nothing in the file presents a placeholder as real data", () => {
  const file = commercialFile({ project: {} });
  const serialised = JSON.stringify(file);

  // "à définir" is allowed on exactly one field, the delivery date, and it
  // travels with a flag saying the date is not defined. Counting occurrences
  // would be brittle — the same document is reachable through the deliverable
  // that wraps it — so what is asserted is which field may carry it.
  const carriers = new Set();
  (function walk(value, key) {
    if (typeof value === "string") {
      if (value.includes("à définir")) {
        carriers.add(key);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) {
        walk(child, childKey);
      }
    }
  })(file, "root");

  assert.deepEqual([...carriers], ["deliveryDateText"]);
  assert.equal(file.documents.deliveryNote.deliveryDateDefined, false);
  assert.equal(file.deliverables.internalTrackingSheet.deliveryDateDefined, false);

  for (const forbidden of ["À compléter", "A compléter", "TBD", "tbd", "XXXX", "N/A"]) {
    assert.equal(serialised.includes(forbidden), false, forbidden);
  }
});

// --- no way round the payment rules -----------------------------------------

test("paymentScheduleParts cannot smuggle an unapproved plan into the file", () => {
  const C = PAYMENT_CONDITIONS;

  for (const [label, parts] of [
    ["conditions reversed", [
      { percent: 60, condition: C.AFTER_INSTALLATION },
      { percent: 20, condition: C.ON_ORDER },
      { percent: 20, condition: C.BEFORE_DELIVERY }
    ]],
    ["conditions nobody recognises", [
      { percent: 60, condition: "foo" },
      { percent: 20, condition: "bar" },
      { percent: 20, condition: "baz" }
    ]],
    ["a split never approved", [
      { percent: 70, condition: C.ON_ORDER },
      { percent: 30, condition: C.BEFORE_DELIVERY }
    ]]
  ]) {
    assert.throws(
      () => commercialFile({ paymentScheduleRuleId: null, paymentScheduleParts: parts }),
      (error) => {
        assert.equal(error.code, "SCHEDULE_PLAN_NOT_SUPPORTED", label);
        return true;
      },
      label
    );
  }

  // The official plan, given the same way, goes through and is recognised.
  const file = commercialFile({
    paymentScheduleRuleId: null,
    paymentScheduleParts: [
      { percent: 60, condition: C.ON_ORDER },
      { percent: 20, condition: C.BEFORE_DELIVERY },
      { percent: 20, condition: C.AFTER_INSTALLATION }
    ]
  });
  assert.equal(file.schedule.ruleId, "hkids-60-20-20-2026");
  assert.equal(file.deliverables.depositRequest.amountTtc, 35794.8);
});

// --- the five annexes, one by one -------------------------------------------

test("the order summary repeats the order as the quote states it", () => {
  const file = commercialFile();
  const summary = file.deliverables.orderSummary;

  assert.equal(summary.lines.length, file.items.length);
  summary.lines.forEach((line, index) => {
    const item = file.items[index];
    assert.equal(line.designation, item.designation);
    assert.equal(line.unit, item.unit);
    assert.equal(line.quantity, item.quantity);
    assert.equal(line.netAmountHt, item.netAmountHt, "the amount is the one already computed");
  });

  // The installments are the schedule's own, not a share recomputed here.
  assert.deepEqual(
    summary.paymentInstallments.map((entry) => entry.amountTtc),
    file.schedule.installments.map((entry) => entry.amountTtc)
  );
  assert.equal(summary.audienceConfirmed, false, "still Hiba's call");
});

test("the calculation sheet cannot diverge from the quote or the invoice", () => {
  const file = numberedFile();
  const sheet = file.deliverables.calculationSheet;
  const { quote, invoice } = file.documents;

  assert.deepEqual(sheet.totals, quote.totals);
  assert.deepEqual(sheet.totals, invoice.totals);

  sheet.lines.forEach((line, index) => {
    for (const [sheetField, documentField] of [
      ["grossAmountHt", "amountHt"],
      ["discountAmount", "discountAmount"],
      ["netAmountHt", "netAmountHt"],
      ["tva", "tva"],
      ["totalTtc", "totalTtc"],
      ["unitPriceHt", "unitPriceHt"],
      ["quantity", "quantity"]
    ]) {
      assert.equal(line[sheetField], quote.items[index][documentField], `quote line ${index} ${sheetField}`);
      assert.equal(line[sheetField], invoice.items[index][documentField], `invoice line ${index} ${sheetField}`);
    }
  });

  // The chain the specification states, read off the sheet itself.
  assert.equal(roundMoney(sheet.totals.totalBrutHt - sheet.totals.totalDiscount), sheet.totals.totalNetHt);
  assert.equal(roundMoney(sheet.totals.totalNetHt + sheet.totals.tva), sheet.totals.totalTtc);
  assert.equal(sheet.audienceConfirmed, false, "still Hiba's call");
});

test("a file with no discount states no rebate base rather than a zero", () => {
  const file = commercialFile({ discount: null });
  const sheet = file.deliverables.calculationSheet;

  assert.equal(sheet.discount, null);
  assert.equal(sheet.totals.totalDiscount, 0);
  assert.equal(sheet.totals.totalBrutHt, sheet.totals.totalNetHt);
  assert.deepEqual(sheet.lines.map((line) => line.discountAmount), new Array(7).fill(0));
});

test("the deposit request is the first approved installment, on every plan", () => {
  for (const ruleId of ["hkids-60-20-20-2026", "hkids-50-30-20-exception", "hkids-40-40-20-exception", "hkids-100-exception"]) {
    const file = commercialFile({ paymentScheduleRuleId: ruleId });
    const deposit = file.deliverables.depositRequest;
    const first = file.schedule.installments[0];

    assert.equal(deposit.available, true, ruleId);
    assert.equal(deposit.percent, first.percent, ruleId);
    assert.equal(deposit.amountTtc, first.amountTtc, ruleId);
    assert.equal(deposit.condition, first.condition, ruleId);
    assert.equal(deposit.paymentScheduleRuleId, ruleId);
    // A deposit is never more than the order.
    assert.ok(deposit.amountTtc <= file.totals.totalTtc, ruleId);
  }
});

test("the internal tracking sheet answers each prerequisite with a fact", () => {
  const incomplete = commercialFile({ project: { fullAddress: "12 rue Exemple" } });
  const sheet = incomplete.deliverables.internalTrackingSheet;

  assert.deepEqual(sheet.prerequisites, {
    officialNumbersAssigned: false,
    paymentScheduleChosen: true,
    criticalInformationComplete: false,
    deliveryDateKnown: false
  });
  assert.equal(sheet.paymentScheduleRuleId, "hkids-60-20-20-2026");
  assert.match(sheet.paymentScheduleLabel, /60 % à la commande/);

  // A missing number is reported with the register's own sentence.
  assert.equal(sheet.numbers.quote.number, null);
  assert.equal(sheet.numbers.quote.message, "Numéro de devis à attribuer après vérification du registre.");

  // An absent delivery date stays absent.
  assert.equal(sheet.deliveryDate, null);
  assert.equal(sheet.deliveryDateDefined, false);
  assert.equal(sheet.deliveryDateText, "Date de livraison : à définir");

  // And a complete, numbered file reports the opposite.
  const complete = numberedFile({ dates: { quoteDate: "06/09/2026", deliveryDate: "12/10/2026" } });
  assert.deepEqual(complete.deliverables.internalTrackingSheet.prerequisites, {
    officialNumbersAssigned: true,
    paymentScheduleChosen: true,
    criticalInformationComplete: true,
    deliveryDateKnown: true
  });
  assert.equal(complete.deliverables.internalTrackingSheet.deliveryDate, "12/10/2026");
});

test("the missing information list separates what is answered from what is not", () => {
  const file = commercialFile({ project: { fullAddress: "12 rue Exemple", floor: "3", elevator: true } });
  const list = file.deliverables.missingInformationList;

  assert.equal(list.entries.length, PROJECT_INFORMATION_FIELDS.length);
  assert.equal(list.providedCount, 3);
  assert.equal(list.missingCount, PROJECT_INFORMATION_FIELDS.length - 3);
  assert.equal(list.missingCount + list.providedCount, list.entries.length);

  assert.deepEqual(list.provided.map((entry) => entry.id).sort(), ["elevator", "floor", "fullAddress"]);
  assert.equal(list.provided.find((entry) => entry.id === "fullAddress").value, "12 rue Exemple");
  for (const entry of list.missing) {
    assert.equal(entry.value, null, `${entry.id} must not be completed with a guess`);
    assert.match(entry.message, /information manquante, à demander au client/);
  }

  // It is the central mechanism's answer, not a second opinion.
  assert.deepEqual(list.entries, reviewProjectInformation({ fullAddress: "12 rue Exemple", floor: "3", elevator: true }));
  assert.deepEqual(list.missing, file.missingInformation);
  // Read as internal for now, and explicitly not settled: a company may send
  // this list to the customer to have it filled in, and nothing in the
  // specification says whether H-KIDS does.
  assert.equal(list.audience, DELIVERABLE_AUDIENCES.INTERNAL);
  assert.equal(list.audienceConfirmed, false, "still Hiba's call");
  assert.ok(
    file.issues.some((issue) =>
      issue.code === "DELIVERABLE_AUDIENCE_UNCONFIRMED"
      && issue.field === "deliverables.missing_information_list.audience"),
    "the question must reach the file's issues"
  );
});

// A placeholder typed into the project is not an answer, and the annexes must
// not treat it as one.
test("a placeholder written into the project is still counted as missing", () => {
  const file = commercialFile({ project: { ...COMPLETE_PROJECT, floor: "à définir", colours: "?" } });
  const list = file.deliverables.missingInformationList;

  assert.deepEqual(list.missing.map((entry) => entry.id).sort(), ["colours", "floor"]);
  assert.equal(list.missing.every((entry) => entry.value === null), true);
});

test("an unknown schedule rule is refused before a file exists", () => {
  assert.throws(
    () => commercialFile({ paymentScheduleRuleId: "hkids-70-30-invented" }),
    (error) => {
      assert.equal(error.code, "SCHEDULE_RULE_UNKNOWN");
      return true;
    }
  );
});
