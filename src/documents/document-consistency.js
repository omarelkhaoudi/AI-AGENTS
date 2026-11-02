import { roundMoney } from "./document-calculations.js";
import { HKIDS_DOCUMENT_TYPES, HKIDS_REFERENCE_FIELDS, carriesPricing } from "./document-schema.js";

/**
 * The three documents of one file must say the same thing.
 *
 * An invoice that quietly differs from its quote, or a delivery note listing
 * quantities nobody agreed to, is the kind of error that surfaces at the worst
 * moment. Convention is not enough to prevent it, so the agreement is checked
 * here, field by field, and stated as errors a person can read.
 */

// The line fields that must be identical between a quote and its invoice.
//
// The list is deliberately complete rather than representative: an invoice is
// coherent with its quote only if every figure a customer can read on it says
// the same thing. A field left out here is a divergence nobody would catch, so
// unit price, both discount forms, VAT, unit TTC and the line totals are all
// compared. The delivery note is compared on a shorter list, because it
// carries no price at all.
export const PRICED_LINE_FIELDS = Object.freeze([
  "designation",
  "unit",
  "quantity",
  "unitPriceHt",
  "discountPercent",
  "discountAmount",
  "amountHt",
  "netAmountHt",
  "tva",
  "unitPriceTtc",
  "totalTtc"
]);

export const DELIVERED_LINE_FIELDS = Object.freeze(["designation", "unit", "quantity"]);

// Everything that would put a price on a delivery note. The list is explicit so
// a field added later to the line model is a deliberate decision here rather
// than an accidental leak onto the document.
export const PRICING_LINE_FIELDS = Object.freeze([
  "unitPriceHt",
  "unitPriceTtc",
  "amountHt",
  "netAmountHt",
  "discountAmount",
  "discountPercent",
  "tva",
  "totalTtc"
]);

export const PRICING_TOTAL_FIELDS = Object.freeze([
  "totalHt",
  "totalBrutHt",
  "totalNetHt",
  "totalDiscount",
  "tva",
  "totalTtc"
]);

function error(field, code, message, extra = {}) {
  return Object.freeze({ field, code, message, ...extra });
}

function compareValue(left, right) {
  if (typeof left === "number" || typeof right === "number") {
    const a = Number(left);
    const b = Number(right);
    if (!Number.isFinite(a) && !Number.isFinite(b)) {
      return true;
    }
    return roundMoney(a) === roundMoney(b);
  }
  return (left ?? "") === (right ?? "");
}

function compareLines(source, target, fields, label, errors) {
  const sourceItems = Array.isArray(source.items) ? source.items : [];
  const targetItems = Array.isArray(target.items) ? target.items : [];

  if (sourceItems.length !== targetItems.length) {
    errors.push(error(
      "items",
      "ITEM_COUNT_MISMATCH",
      `${label} lists ${targetItems.length} line(s) where the quote lists ${sourceItems.length}.`,
      { expected: sourceItems.length, actual: targetItems.length }
    ));
    return;
  }

  sourceItems.forEach((sourceItem, index) => {
    const targetItem = targetItems[index];
    for (const field of fields) {
      if (sourceItem[field] === undefined && targetItem[field] === undefined) {
        continue;
      }
      if (!compareValue(sourceItem[field], targetItem[field])) {
        errors.push(error(
          `items.${index}.${field}`,
          "ITEM_FIELD_MISMATCH",
          `${label} line ${index + 1}: ${field} is ${targetItem[field]} where the quote says ${sourceItem[field]}.`,
          { expected: sourceItem[field], actual: targetItem[field] }
        ));
      }
    }
  });
}

/**
 * An invoice must repeat its quote exactly: same lines, same quantities, same
 * prices, same discounts, same totals.
 */
export function validateInvoiceMatchesQuote(quote, invoice) {
  const errors = [];

  if (quote?.documentType !== HKIDS_DOCUMENT_TYPES.QUOTE) {
    errors.push(error("quote.documentType", "SOURCE_NOT_A_QUOTE", "The source document is not a quote."));
  }
  if (invoice?.documentType !== HKIDS_DOCUMENT_TYPES.INVOICE) {
    errors.push(error("invoice.documentType", "TARGET_NOT_AN_INVOICE", "The target document is not an invoice."));
  }
  if (errors.length > 0) {
    return Object.freeze(errors);
  }

  compareLines(quote, invoice, PRICED_LINE_FIELDS, "The invoice", errors);

  for (const field of PRICING_TOTAL_FIELDS) {
    const expected = quote.totals?.[field];
    const actual = invoice.totals?.[field];
    if (expected === undefined && actual === undefined) {
      continue;
    }
    if (!compareValue(expected, actual)) {
      errors.push(error(
        `totals.${field}`,
        "TOTAL_MISMATCH",
        `The invoice states ${field} = ${actual} where the quote says ${expected}.`,
        { expected, actual }
      ));
    }
  }

  errors.push(...validateReferences(invoice, { quote }));
  return Object.freeze(errors);
}

/**
 * A delivery note repeats the goods and nothing about their price. It also has
 * to point back at both documents that came before it.
 */
export function validateDeliveryNoteMatchesOrder(quote, invoice, deliveryNote) {
  const errors = [];

  if (deliveryNote?.documentType !== HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE) {
    return Object.freeze([
      error("deliveryNote.documentType", "TARGET_NOT_A_DELIVERY_NOTE", "The target document is not a delivery note.")
    ]);
  }

  compareLines(quote, deliveryNote, DELIVERED_LINE_FIELDS, "The delivery note", errors);
  errors.push(...assertNoPricing(deliveryNote));
  errors.push(...validateReferences(deliveryNote, { quote, invoice }));
  return Object.freeze(errors);
}

/**
 * Refuses any price on a delivery note, on the lines and on the totals alike.
 */
export function assertNoPricing(document) {
  const errors = [];
  // The profile decides, not the type alone: the historical H-KIDS delivery
  // note does carry prices, and only the goods-only one must not.
  if (carriesPricing(document?.documentType, document?.deliveryNoteProfile)) {
    return Object.freeze(errors);
  }

  (document.items ?? []).forEach((item, index) => {
    for (const field of PRICING_LINE_FIELDS) {
      const value = item[field];
      if (value !== undefined && value !== null && value !== "") {
        errors.push(error(
          `items.${index}.${field}`,
          "DELIVERY_NOTE_CARRIES_PRICING",
          `A delivery note must not carry ${field}.`,
          { actual: value }
        ));
      }
    }
  });

  for (const field of PRICING_TOTAL_FIELDS) {
    const value = document.totals?.[field];
    if (value !== undefined && value !== null && value !== "") {
      errors.push(error(
        `totals.${field}`,
        "DELIVERY_NOTE_CARRIES_PRICING",
        `A delivery note must not carry totals.${field}.`,
        { actual: value }
      ));
    }
  }

  return Object.freeze(errors);
}

/**
 * Checks that a document points back at the ones it should, and that each
 * reference names the right document. A missing reference is reported; it is
 * never filled in.
 */
export function validateReferences(document, { quote = null, invoice = null } = {}) {
  const errors = [];
  const expectations = [];

  if (document?.documentType === HKIDS_DOCUMENT_TYPES.INVOICE) {
    expectations.push([HKIDS_REFERENCE_FIELDS.QUOTE, quote, "quote"]);
  }
  if (document?.documentType === HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE) {
    expectations.push([HKIDS_REFERENCE_FIELDS.QUOTE, quote, "quote"]);
    expectations.push([HKIDS_REFERENCE_FIELDS.INVOICE, invoice, "invoice"]);
  }

  for (const [field, source, label] of expectations) {
    const reference = typeof document[field] === "string" ? document[field].trim() : "";
    if (reference === "") {
      errors.push(error(field, "REFERENCE_MISSING", `A ${document.documentType} must reference its ${label}.`));
      continue;
    }
    const expected = typeof source?.documentNumber === "string" ? source.documentNumber.trim() : "";
    if (expected !== "" && reference !== expected) {
      errors.push(error(
        field,
        "REFERENCE_MISMATCH",
        `${field} is ${reference} where the ${label} is numbered ${expected}.`,
        { expected, actual: reference }
      ));
    }
  }

  return Object.freeze(errors);
}
