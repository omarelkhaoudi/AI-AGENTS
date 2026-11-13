import { calculateDocumentTotals, assertProvidedTotalsMatch, roundMoney } from "./document-calculations.js";
import { assertNoPricing } from "./document-consistency.js";
import {
  CREDIT_NOTE_SETTLEMENTS,
  DEFAULT_DELIVERY_NOTE_PROFILE,
  HKIDS_DOCUMENT_TYPES,
  PAYMENT_RECEIPT_METHODS,
  PAYMENT_RECEIPT_TVA_RATE,
  REQUIRED_PURCHASE_ORDER_FIELDS,
  HKIDS_REFERENCE_FIELDS,
  UPSTREAM_REFERENCE_FIELDS,
  carriesPricing,
  isControlledDocumentType,
  isDeliveryNoteProfile,
  requiredFieldsFor
} from "./document-schema.js";
import { computeInstalments, parseReferenceImage, purchaseOrderPaymentPlan } from "./purchase-order.js";
import {
  SUPPORTED_PAYMENT_PLANS,
  isKnownPaymentScheduleRule,
  isSupportedPaymentTerms,
  paymentScheduleRule
} from "./payment-schedule.js";

const FORBIDDEN_PLACEHOLDERS = Object.freeze(["?", "À compléter", "A compléter"]);

export class DocumentValidationError extends Error {
  constructor(errors) {
    super("Document validation failed.");
    this.name = "DocumentValidationError";
    this.code = "DOCUMENT_VALIDATION_FAILED";
    this.errors = Object.freeze(errors.map((error) => Object.freeze({ ...error })));
  }
}

// A priced line, normalized as it has always been: unitPriceHt is converted
// whether or not it was given, so a missing price surfaces as a validation
// error rather than as a silent zero.
function normalizePricedLine(item) {
  return Object.freeze({
    designation: text(item.designation),
    unit: text(item.unit),
    quantity: Number(item.quantity),
    unitPriceHt: Number(item.unitPriceHt),
    amountHt: item.amountHt === undefined ? undefined : Number(item.amountHt),
    tva: item.tva === undefined ? undefined : Number(item.tva),
    unitPriceTtc: item.unitPriceTtc === undefined ? undefined : Number(item.unitPriceTtc),
    totalTtc: item.totalTtc === undefined ? undefined : Number(item.totalTtc),
    // A discount stated on the line itself. Left undefined when absent, so a
    // line without a discount is not a line discounted by zero.
    discountPercent: item.discountPercent === undefined ? undefined : Number(item.discountPercent),
    discountAmount: item.discountAmount === undefined ? undefined : Number(item.discountAmount)
  });
}

// A goods-only line keeps what was delivered and nothing else. Converting the
// absent price here would produce `unitPriceHt: NaN`, which is a pricing field
// as far as assertNoPricing is concerned: the document would be refused for
// carrying a price it never had.
function normalizeDeliveredLine(item) {
  const line = { designation: text(item.designation), quantity: Number(item.quantity) };
  if (text(item.unit) !== "") {
    line.unit = text(item.unit);
  }
  return Object.freeze(line);
}

export function normalizeDocumentInput(input = {}) {
  const documentType = text(input.documentType);
  const deliveryNoteProfile = isDeliveryNoteProfile(input.deliveryNoteProfile)
    ? input.deliveryNoteProfile
    : DEFAULT_DELIVERY_NOTE_PROFILE;
  // A receipt states money received and carries no VAT of its own, whatever it
  // is handed.
  const tvaRate = documentType === HKIDS_DOCUMENT_TYPES.PAYMENT_RECEIPT
    ? PAYMENT_RECEIPT_TVA_RATE
    : input.tvaRate === undefined ? 0.2 : Number(input.tvaRate);
  const normalizeLine = carriesPricing(documentType, deliveryNoteProfile)
    ? normalizePricedLine
    : normalizeDeliveredLine;
  const items = Array.isArray(input.items) ? input.items.map(normalizeLine) : [];

  const purchaseOrder = documentType === HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER;
  const payment = purchaseOrder ? normalizePurchaseOrderPayment(input.payment) : normalizePayment(input.payment);

  return Object.freeze({
    documentType,
    documentNumber: text(input.documentNumber),
    date: text(input.date),
    object: text(input.object),
    reference: text(input.reference),
    // The three references that tie the documents of one file together. They
    // are read as given and never derived: an absent reference stays absent.
    quoteReference: text(input.quoteReference),
    invoiceReference: text(input.invoiceReference),
    deliveryNoteReference: text(input.deliveryNoteReference),
    deliveryDate: text(input.deliveryDate),
    // Stated, never inferred. An unknown value falls back to the historical
    // priced document rather than silently stripping money off a real one.
    deliveryNoteProfile,
    client: Object.freeze({
      name: text(input.client?.name),
      address: text(input.client?.address)
    }),
    ...(purchaseOrder ? {
      specifications: Object.freeze(Array.isArray(input.specifications)
        ? input.specifications.map((line) => text(line)).filter((line) => line !== "")
        : []),
      referenceImage: text(input.referenceImage)
    } : {}),
    items: Object.freeze(items),
    totals: Object.freeze({
      totalHt: input.totals?.totalHt === undefined ? undefined : Number(input.totals.totalHt),
      tva: input.totals?.tva === undefined ? undefined : Number(input.totals.tva),
      totalTtc: input.totals?.totalTtc === undefined ? undefined : Number(input.totals.totalTtc),
      // Checked only when the caller states them, so a document without a
      // discount is validated exactly as it was before.
      totalBrutHt: input.totals?.totalBrutHt === undefined ? undefined : Number(input.totals.totalBrutHt),
      totalDiscount: input.totals?.totalDiscount === undefined ? undefined : Number(input.totals.totalDiscount),
      totalNetHt: input.totals?.totalNetHt === undefined ? undefined : Number(input.totals.totalNetHt)
    }),
    discount: input.discount ?? null,
    tvaRate,
    payment,
    note: text(input.note),
    userConfirmation: input.userConfirmation === true,
    previewToken: text(input.previewToken)
  });
}

export function validateAndPrepareDocument(input = {}, { requireConfirmation = false, relatedDocuments = {} } = {}) {
  const document = normalizeDocumentInput(input);
  const errors = [];

  if (!isControlledDocumentType(document.documentType)) {
    errors.push(error("documentType", "INVALID_DOCUMENT_TYPE", "documentType must be quote, delivery_note, invoice, purchase_order, credit_note or payment_receipt."));
  }

  // The types are validated differently, and the delivery note has two shapes
  // of its own. What follows branches on that once, so the rest reads as "this
  // document carries money" or "it does not". A purchase order always does.
  const purchaseOrder = document.documentType === HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER;
  const priced = purchaseOrder || carriesPricing(document.documentType, document.deliveryNoteProfile);

  const required = purchaseOrder
    ? REQUIRED_PURCHASE_ORDER_FIELDS
    : requiredFieldsFor(document.documentType, { deliveryNoteProfile: document.deliveryNoteProfile });
  for (const field of required) {
    if (isMissing(getField(document, field))) {
      errors.push(error(field, "REQUIRED_FIELD_MISSING", `${field} is required.`));
    }
  }

  validateUpstreamReferences(document, errors, relatedDocuments);

  if (requireConfirmation && !document.userConfirmation) {
    errors.push(error("userConfirmation", "CONFIRMATION_REQUIRED", "Explicit user confirmation is required before generation."));
  }

  if (!isValidDate(document.date)) {
    errors.push(error("date", "INVALID_DATE", "date must use YYYY-MM-DD or DD/MM/YYYY format."));
  }

  validateTextRecursively(document, "", errors);
  validateDocumentObject(document, errors);
  validateItems(document, errors);

  if (!priced) {
    // A goods-only delivery note is finished here: it states what was handed
    // over, so there is no total to recompute and no payment to check.
    //
    // The checks run against the raw input rather than the normalized document.
    // Normalization drops what such a document must not have, and anything the
    // caller did send would otherwise be discarded in silence instead of
    // refused — which is the difference between a document that cannot carry a
    // price and one that quietly forgets the price it was given.
    errors.push(...assertNoPricing({
      documentType: document.documentType,
      deliveryNoteProfile: document.deliveryNoteProfile,
      items: Array.isArray(input.items) ? input.items : [],
      totals: input.totals ?? {}
    }));
    errors.push(...assertNoCommercialTerms(input));

    if (errors.length > 0) {
      throw new DocumentValidationError(errors);
    }

    // totals and payment are left out of the result entirely: a key holding
    // undefined is still a column a renderer would try to print.
    const { totals, payment, tvaRate, discount, ...delivered } = document;
    return Object.freeze(delivered);
  }

  if (purchaseOrder) {
    validatePurchaseOrderPayment(document.payment, errors);
    const { error: imageError } = parseReferenceImage(document.referenceImage);
    if (imageError) {
      errors.push(error("referenceImage", imageError, "referenceImage must be a JPEG or PNG data URL of at most 3 MB."));
    }
  } else if (SETTLEMENT_CHOICES[document.documentType]) {
    validateSettlement(document, errors);
  } else {
    validatePayment(document.payment, errors);
  }

  const calculated = recalculate(document);
  errors.push(...assertLineAmounts(document.items, calculated.items));
  errors.push(...assertProvidedTotalsMatch(calculated, document.totals));

  if (roundMoney(Number(document.totals.totalHt) + Number(document.totals.tva)) !== roundMoney(Number(document.totals.totalTtc))) {
    errors.push(error("totals.totalTtc", "HT_TVA_TTC_MISMATCH", "Total HT + TVA must equal Total TTC."));
  }

  if (errors.length > 0) {
    throw new DocumentValidationError(errors);
  }

  const plan = purchaseOrder ? purchaseOrderPaymentPlan(document.payment.termsRule) : null;
  return Object.freeze({
    ...document,
    items: calculated.items,
    totals: calculated.totals,
    ...(plan ? { payment: Object.freeze({ ...document.payment, instalments: computeInstalments(plan, calculated.totals.totalTtc) }) } : {})
  });
}

// Purchase order terms come only from a named plan, never from free text: the
// instalment amounts printed on the order are computed from the plan, and a
// typed sentence could contradict them.
function normalizePurchaseOrderPayment(payment = {}) {
  const termsRule = text(payment?.termsRule);
  const plan = purchaseOrderPaymentPlan(termsRule);
  return Object.freeze({
    method: normalizePaymentMethod(payment?.method),
    terms: plan ? plan.label : "",
    termsRule
  });
}

function validatePurchaseOrderPayment(payment, errors) {
  if (!purchaseOrderPaymentPlan(payment.termsRule)) {
    errors.push(error("payment.termsRule", "UNKNOWN_PAYMENT_TERMS_RULE", "payment.termsRule must name a purchase order payment plan."));
  }
}

// The document recomputed by the engine: the one reference its figures are held
// against.
//
// discountAmount means two things. Given to calculateDocumentTotals, it is a
// rebate a line carries on its own. Returned by it, on a line the document's
// rebate targets, it is everything that line received: its own rebate and its
// share of the document's. createDocumentBundle hands its lines out as returned,
// so reading one of its documents back took the document's share a second time:
// file 3's mezzanine received 1 200 and was recomputed at 2 340, and every file
// discounted by a percentage was refused.
//
// A document is therefore first read as the engine's own result. On the lines
// the document's rebate targets, the stated amount is set aside and the engine
// recomputes; that reading is kept only if every figure the document states — the
// amounts set aside, the line amounts, the totals — is exactly what the engine
// produced. Anything else is read, and checked, as it always was. No rebate is
// computed here: both readings are the engine's.
function recalculate(document) {
  const options = document.discount ? { discount: document.discount } : {};
  return calculateAsApplied(document, options)
    ?? calculateDocumentTotals(document.items, document.tvaRate, options);
}

function calculateAsApplied(document, options) {
  const targets = Array.isArray(document.discount?.appliesToIndexes)
    ? new Set(document.discount.appliesToIndexes)
    : null;
  // A line stating a percentage of its own keeps it, and is read as before.
  const carriesAppliedRebate = (item, index) => targets?.has(index) === true
    && item.discountPercent === undefined
    && item.discountAmount !== undefined;
  if (!document.items.some(carriesAppliedRebate)) {
    return null;
  }

  const calculated = calculateDocumentTotals(
    document.items.map((item, index) => (carriesAppliedRebate(item, index)
      ? Object.freeze({ ...item, discountAmount: undefined })
      : item)),
    document.tvaRate,
    options
  );

  const sameRebates = document.items.every((item, index) => !carriesAppliedRebate(item, index)
    || roundMoney(item.discountAmount) === calculated.items[index].discountAmount);
  const sameFigures = assertLineAmounts(document.items, calculated.items).length === 0
    && assertProvidedTotalsMatch(calculated, document.totals).length === 0;
  return sameRebates && sameFigures ? calculated : null;
}

// The commercial terms of a sale. A delivery note that states only the goods
// carries none of them, and being handed one is a mistake worth reporting: it
// means the caller believes this document settles money, and silently dropping
// the field would leave that belief uncorrected.
export const FORBIDDEN_GOODS_ONLY_FIELDS = Object.freeze(["payment", "discount", "tvaRate"]);

function assertNoCommercialTerms(input) {
  const errors = [];
  for (const field of FORBIDDEN_GOODS_ONLY_FIELDS) {
    const value = input?.[field];
    if (value !== undefined && value !== null) {
      errors.push(error(
        field,
        "DELIVERY_NOTE_CARRIES_COMMERCIAL_TERMS",
        `A goods-only delivery note must not carry ${field}.`,
        { actual: value }
      ));
    }
  }
  return errors;
}

// An invoice has to point at what came before it, and either reference does.
// Requiring one in particular would break one of the two flows; requiring
// neither would let an invoice reference nothing at all.
function validateUpstreamReferences(document, errors, relatedDocuments = {}) {
  // A credit note corrects one invoice, which it must name.
  if (document.documentType === HKIDS_DOCUMENT_TYPES.CREDIT_NOTE) {
    if (isMissing(document[HKIDS_REFERENCE_FIELDS.INVOICE])) {
      errors.push(error(HKIDS_REFERENCE_FIELDS.INVOICE, "UPSTREAM_REFERENCE_MISSING", "A credit note must reference the invoice it corrects: invoiceReference is required."));
    }
    return;
  }
  // A receipt is paid on a sale, named by its quote or by the invoice settled.
  if (document.documentType === HKIDS_DOCUMENT_TYPES.PAYMENT_RECEIPT) {
    if (isMissing(document[HKIDS_REFERENCE_FIELDS.QUOTE]) && isMissing(document[HKIDS_REFERENCE_FIELDS.INVOICE])) {
      errors.push(error(`${HKIDS_REFERENCE_FIELDS.QUOTE} | ${HKIDS_REFERENCE_FIELDS.INVOICE}`, "UPSTREAM_REFERENCE_MISSING", "A payment receipt must reference the quote or the invoice it is paid on."));
    }
    return;
  }
  if (document.documentType !== HKIDS_DOCUMENT_TYPES.INVOICE) {
    return;
  }

  const carried = UPSTREAM_REFERENCE_FIELDS.filter((field) => !isMissing(document[field]));
  if (carried.length === 0) {
    errors.push(error(
      UPSTREAM_REFERENCE_FIELDS.join(" | "),
      "UPSTREAM_REFERENCE_MISSING",
      `An invoice must reference its quote or its delivery note: ${UPSTREAM_REFERENCE_FIELDS.join(" or ")} is required.`
    ));
    return;
  }

  // Whatever reference is carried is checked against the document it names,
  // when the caller states what that document is.
  const expectations = [
    [HKIDS_REFERENCE_FIELDS.QUOTE, relatedDocuments.quoteNumber, "quote"],
    [HKIDS_REFERENCE_FIELDS.DELIVERY_NOTE, relatedDocuments.deliveryNoteNumber, "delivery note"]
  ];
  let verified = 0;
  for (const [field, expected, label] of expectations) {
    const declared = typeof expected === "string" ? expected.trim() : "";
    if (isMissing(document[field]) || declared === "") {
      continue;
    }
    verified += 1;
    if (document[field] !== declared) {
      errors.push(error(
        field,
        "UPSTREAM_REFERENCE_MISMATCH",
        `${field} is ${document[field]} where the ${label} of this file is numbered ${declared}.`,
        { expected: declared, actual: document[field] }
      ));
    }
  }

  // Two references means the invoice claims to follow a quote and a delivery
  // note at once. That can be legitimate, but nothing inside a single document
  // says the two belong to the same commercial file, and guessing a link from
  // the shape of the numbers would be inventing a numbering rule the company
  // has not given. So it is accepted only when the caller states what both
  // upstream documents are, and refused as unverifiable otherwise.
  if (carried.length === UPSTREAM_REFERENCE_FIELDS.length && verified < UPSTREAM_REFERENCE_FIELDS.length) {
    errors.push(error(
      UPSTREAM_REFERENCE_FIELDS.join(" + "),
      "UPSTREAM_REFERENCE_CONFLICT",
      "An invoice carrying both a quote reference and a delivery note reference must state which commercial file they belong to: pass relatedDocuments.quoteNumber and relatedDocuments.deliveryNoteNumber so the two can be checked.",
      {
        quoteReference: document[HKIDS_REFERENCE_FIELDS.QUOTE],
        deliveryNoteReference: document[HKIDS_REFERENCE_FIELDS.DELIVERY_NOTE]
      }
    ));
  }
}

// A known rule supplies its own wording, so the terms printed on the document
// are the approved ones and not a sentence somebody retyped. The standard rule
// keeps the exact label it has always had.
function normalizePayment(payment = {}) {
  const termsRule = text(payment.termsRule);
  const rule = termsRule === "" ? null : paymentScheduleRule(termsRule);
  const terms = rule ? rule.label : text(payment.terms);
  const method = normalizePaymentMethod(payment.method);

  return Object.freeze({
    method,
    terms,
    termsRule
  });
}

function normalizePaymentMethod(value) {
  const method = text(value);
  return method.toLowerCase() === "virement" ? "virement bancaire" : method;
}

// The rule has to be one the company approved. The standard 60/20/20 and the
// three exceptions are accepted; anything else is refused, exactly as a single
// hardcoded rule was before — the set grew, the strictness did not change.
//
// The wording is held to the same rule as the selection. Terms typed by hand
// are how an unapproved plan reaches a document: "70 % commande ; 30 %
// livraison" reads perfectly and was never agreed with the company, and
// checking only `termsRule` let it through whenever the rule was left out.
function validatePayment(payment, errors) {
  if (payment.termsRule && !isKnownPaymentScheduleRule(payment.termsRule)) {
    errors.push(error("payment.termsRule", "UNKNOWN_PAYMENT_TERMS_RULE", "payment.termsRule is not an active H-KIDS payment rule."));
  }
  if (payment.terms && /50\s*%.*50\s*%|50\/50/i.test(payment.terms)) {
    errors.push(error("payment.terms", "OLD_PAYMENT_TERMS_FORBIDDEN", "Old 50/50 payment terms must not be reused automatically."));
  }
  if (payment.terms && !isSupportedPaymentTerms(payment.terms)) {
    errors.push(error(
      "payment.terms",
      "UNSUPPORTED_PAYMENT_TERMS",
      `payment.terms must describe one of the approved H-KIDS plans: ${SUPPORTED_PAYMENT_PLANS.map((plan) => plan.join("/")).join(", ")}.`,
      { supportedPlans: SUPPORTED_PAYMENT_PLANS.map((plan) => [...plan]) }
    ));
  }
}

// A credit note says what becomes of the amount it gives back, a receipt how the
// money came in: each from its own short list, and neither carries a schedule.
const SETTLEMENT_CHOICES = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.CREDIT_NOTE]: CREDIT_NOTE_SETTLEMENTS,
  [HKIDS_DOCUMENT_TYPES.PAYMENT_RECEIPT]: PAYMENT_RECEIPT_METHODS
});

function validateSettlement(document, errors) {
  const choices = SETTLEMENT_CHOICES[document.documentType];
  if (!choices.includes(document.payment.method)) {
    errors.push(error("payment.method", "UNKNOWN_PAYMENT_METHOD", `payment.method must be one of: ${choices.join(", ")}.`, { allowed: [...choices] }));
  }
  if (document.payment.terms || document.payment.termsRule) {
    errors.push(error("payment.terms", "TERMS_NOT_ALLOWED", `A ${document.documentType} carries no payment schedule.`));
  }
}

function validateDocumentObject(document, errors) {
  if (document.documentType === HKIDS_DOCUMENT_TYPES.INVOICE && document.object && document.object !== "Vente de mobilier") {
    errors.push(error("object", "INVALID_DOCUMENT_OBJECT", "invoice object must be Vente de mobilier when provided."));
  }
}

// What every line must state, and what only a priced line must. A goods-only
// delivery note is checked on designation and quantity: demanding a unit price
// there would contradict the rule that it carries none.
function validateItems(document, errors) {
  const items = document.items;
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }
  const priced = carriesPricing(document.documentType, document.deliveryNoteProfile);

  items.forEach((item, index) => {
    if (isMissing(item.designation)) {
      errors.push(error(`items.${index}.designation`, "REQUIRED_FIELD_MISSING", "item designation is required."));
    }
    if ([HKIDS_DOCUMENT_TYPES.INVOICE, HKIDS_DOCUMENT_TYPES.CREDIT_NOTE].includes(document.documentType) && isMissing(item.unit)) {
      errors.push(error(`items.${index}.unit`, "REQUIRED_FIELD_MISSING", "item unit is required for invoices."));
    }
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      errors.push(error(`items.${index}.quantity`, "INVALID_QUANTITY", "quantity must be a positive number."));
    }
    if (priced && (!Number.isFinite(item.unitPriceHt) || item.unitPriceHt < 0)) {
      errors.push(error(`items.${index}.unitPriceHt`, "INVALID_UNIT_PRICE", "unitPriceHt must be a positive number or zero."));
    }
  });
}

function assertLineAmounts(providedItems, calculatedItems) {
  const errors = [];
  providedItems.forEach((item, index) => {
    for (const [field, code, message] of [
      ["amountHt", "LINE_AMOUNT_MISMATCH", "amountHt must equal quantity times unitPriceHt."],
      ["tva", "LINE_TVA_MISMATCH", "tva must equal line HT times TVA rate."],
      ["unitPriceTtc", "UNIT_TTC_MISMATCH", "unitPriceTtc must equal unitPriceHt plus TVA."],
      ["totalTtc", "LINE_TTC_MISMATCH", "totalTtc must equal quantity times unitPriceTtc."]
    ]) {
      if (item[field] === undefined) {
        continue;
      }
      if (roundMoney(item[field]) !== calculatedItems[index][field]) {
        errors.push(error(`items.${index}.${field}`, code, message, {
          expected: calculatedItems[index][field],
          actual: roundMoney(item[field])
        }));
      }
    }
  });
  return errors;
}

function validateTextRecursively(value, path, errors) {
  if (typeof value === "string") {
    for (const forbidden of FORBIDDEN_PLACEHOLDERS) {
      if (value.includes(forbidden)) {
        errors.push(error(path || "document", "FORBIDDEN_PLACEHOLDER", `${path || "document"} must not contain ${forbidden}.`));
      }
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateTextRecursively(entry, `${path}.${index}`.replace(/^\./, ""), errors));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    validateTextRecursively(entry, `${path}.${key}`.replace(/^\./, ""), errors);
  }
}

function getField(object, path) {
  return path.split(".").reduce((current, key) => current?.[key], object);
}

function isMissing(value) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

function isValidDate(value) {
  if (typeof value !== "string") {
    return false;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{2}\/\d{2}\/\d{4}$/.test(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function error(field, code, message, extra = {}) {
  return Object.freeze({ field, code, message, ...extra });
}
