import { calculateDocumentTotals, assertProvidedTotalsMatch, roundMoney } from "./document-calculations.js";
import {
  HKIDS_DOCUMENT_TYPES,
  REQUIRED_DOCUMENT_FIELDS,
  REQUIRED_INVOICE_FIELDS,
  isControlledDocumentType
} from "./document-schema.js";
import { HKIDS_ACTIVE_PAYMENT_TERMS } from "./hkids-template.js";

const FORBIDDEN_PLACEHOLDERS = Object.freeze(["?", "À compléter", "A compléter"]);

export class DocumentValidationError extends Error {
  constructor(errors) {
    super("Document validation failed.");
    this.name = "DocumentValidationError";
    this.code = "DOCUMENT_VALIDATION_FAILED";
    this.errors = Object.freeze(errors.map((error) => Object.freeze({ ...error })));
  }
}

export function normalizeDocumentInput(input = {}) {
  const documentType = text(input.documentType);
  const tvaRate = input.tvaRate === undefined ? 0.2 : Number(input.tvaRate);
  const items = Array.isArray(input.items)
    ? input.items.map((item) => Object.freeze({
      designation: text(item.designation),
      unit: text(item.unit),
      quantity: Number(item.quantity),
      unitPriceHt: Number(item.unitPriceHt),
      amountHt: item.amountHt === undefined ? undefined : Number(item.amountHt),
      tva: item.tva === undefined ? undefined : Number(item.tva),
      unitPriceTtc: item.unitPriceTtc === undefined ? undefined : Number(item.unitPriceTtc),
      totalTtc: item.totalTtc === undefined ? undefined : Number(item.totalTtc)
    }))
    : [];

  const payment = normalizePayment(input.payment);

  return Object.freeze({
    documentType,
    documentNumber: text(input.documentNumber),
    date: text(input.date),
    object: text(input.object),
    reference: text(input.reference),
    deliveryNoteReference: text(input.deliveryNoteReference),
    client: Object.freeze({
      name: text(input.client?.name),
      address: text(input.client?.address)
    }),
    items: Object.freeze(items),
    totals: Object.freeze({
      totalHt: input.totals?.totalHt === undefined ? undefined : Number(input.totals.totalHt),
      tva: input.totals?.tva === undefined ? undefined : Number(input.totals.tva),
      totalTtc: input.totals?.totalTtc === undefined ? undefined : Number(input.totals.totalTtc)
    }),
    tvaRate,
    payment,
    note: text(input.note),
    userConfirmation: input.userConfirmation === true,
    previewToken: text(input.previewToken)
  });
}

export function validateAndPrepareDocument(input = {}, { requireConfirmation = false } = {}) {
  const document = normalizeDocumentInput(input);
  const errors = [];

  if (!isControlledDocumentType(document.documentType)) {
    errors.push(error("documentType", "INVALID_DOCUMENT_TYPE", "documentType must be delivery_note or invoice."));
  }

  const required = document.documentType === HKIDS_DOCUMENT_TYPES.INVOICE
    ? REQUIRED_INVOICE_FIELDS
    : REQUIRED_DOCUMENT_FIELDS;
  for (const field of required) {
    if (isMissing(getField(document, field))) {
      errors.push(error(field, "REQUIRED_FIELD_MISSING", `${field} is required.`));
    }
  }

  if (requireConfirmation && !document.userConfirmation) {
    errors.push(error("userConfirmation", "CONFIRMATION_REQUIRED", "Explicit user confirmation is required before generation."));
  }

  if (!isValidDate(document.date)) {
    errors.push(error("date", "INVALID_DATE", "date must use YYYY-MM-DD or DD/MM/YYYY format."));
  }

  validateTextRecursively(document, "", errors);
  validateDocumentObject(document, errors);
  validateItems(document, errors);
  validatePayment(document.payment, errors);

  const calculated = calculateDocumentTotals(document.items, document.tvaRate);
  errors.push(...assertLineAmounts(document.items, calculated.items));
  errors.push(...assertProvidedTotalsMatch(calculated, document.totals));

  if (roundMoney(Number(document.totals.totalHt) + Number(document.totals.tva)) !== roundMoney(Number(document.totals.totalTtc))) {
    errors.push(error("totals.totalTtc", "HT_TVA_TTC_MISMATCH", "Total HT + TVA must equal Total TTC."));
  }

  if (errors.length > 0) {
    throw new DocumentValidationError(errors);
  }

  return Object.freeze({
    ...document,
    items: calculated.items,
    totals: calculated.totals
  });
}

function normalizePayment(payment = {}) {
  const termsRule = text(payment.termsRule);
  const terms = termsRule === HKIDS_ACTIVE_PAYMENT_TERMS.id
    ? HKIDS_ACTIVE_PAYMENT_TERMS.label
    : text(payment.terms);
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

function validatePayment(payment, errors) {
  if (payment.termsRule && payment.termsRule !== HKIDS_ACTIVE_PAYMENT_TERMS.id) {
    errors.push(error("payment.termsRule", "UNKNOWN_PAYMENT_TERMS_RULE", "payment.termsRule is not an active H-KIDS payment rule."));
  }
  if (payment.terms && /50\s*%.*50\s*%|50\/50/i.test(payment.terms)) {
    errors.push(error("payment.terms", "OLD_PAYMENT_TERMS_FORBIDDEN", "Old 50/50 payment terms must not be reused automatically."));
  }
}

function validateDocumentObject(document, errors) {
  if (document.documentType === HKIDS_DOCUMENT_TYPES.INVOICE && document.object && document.object !== "Vente de mobilier") {
    errors.push(error("object", "INVALID_DOCUMENT_OBJECT", "invoice object must be Vente de mobilier when provided."));
  }
}

function validateItems(document, errors) {
  const items = document.items;
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }
  items.forEach((item, index) => {
    if (isMissing(item.designation)) {
      errors.push(error(`items.${index}.designation`, "REQUIRED_FIELD_MISSING", "item designation is required."));
    }
    if (document.documentType === HKIDS_DOCUMENT_TYPES.INVOICE && isMissing(item.unit)) {
      errors.push(error(`items.${index}.unit`, "REQUIRED_FIELD_MISSING", "item unit is required for invoices."));
    }
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      errors.push(error(`items.${index}.quantity`, "INVALID_QUANTITY", "quantity must be a positive number."));
    }
    if (!Number.isFinite(item.unitPriceHt) || item.unitPriceHt < 0) {
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
