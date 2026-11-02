import { calculateDocumentTotals, DEFAULT_TVA_RATE } from "./document-calculations.js";
import {
  validateDeliveryNoteMatchesOrder,
  validateInvoiceMatchesQuote
} from "./document-consistency.js";
import { createDocumentNumberingService } from "./document-numbering.js";
import {
  DELIVERABLE_AUDIENCES,
  DELIVERY_NOTE_PROFILES,
  HKIDS_DELIVERABLE_KINDS,
  HKIDS_DELIVERABLE_LABELS,
  HKIDS_DOCUMENT_TYPES,
  deliverableAudience
} from "./document-schema.js";
import {
  INFORMATION_STATUSES,
  reviewProjectInformation,
  summariseMissingInformation
} from "./missing-information.js";
import { createPaymentSchedule } from "./payment-schedule.js";

/**
 * One commercial file, held once.
 *
 * The quote, the invoice and the delivery note of the same order are three
 * views of the same facts. Building them from three separate inputs is how they
 * drift apart, so they are derived here from a single set of lines and a single
 * calculation, and the derivation is then checked rather than trusted.
 *
 * This lot builds the model and the validations. Rendering the seven documents
 * comes later and will read from this bundle.
 */

export const DELIVERY_DATE_LABEL = "Date de livraison";
export const DELIVERY_DATE_TO_BE_DEFINED = "à définir";

export class DocumentBundleError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "DocumentBundleError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The delivery date, said in full. A date nobody gave is written "à définir" —
 * never guessed from the order date, never left blank so a reader has to
 * wonder.
 */
export function deliveryDateText(deliveryDate) {
  const given = text(deliveryDate);
  return `${DELIVERY_DATE_LABEL} : ${given === "" ? DELIVERY_DATE_TO_BE_DEFINED : given}`;
}

export function isDeliveryDateDefined(deliveryDate) {
  return text(deliveryDate) !== "";
}

// A number the register has not given yet is null, and the pending message
// travels beside it. Nothing downstream may substitute a value for it.
function resolveNumber(numbering, documentType, claimed) {
  const given = text(claimed);
  if (given !== "") {
    return numbering.claimNumber(documentType, given);
  }
  return numbering.requestNumber(documentType);
}

// The priced view of a line, for the quote and the invoice.
function pricedLine(item) {
  return Object.freeze({
    designation: item.designation,
    unit: item.unit,
    quantity: item.quantity,
    unitPriceHt: item.unitPriceHt,
    // Carried so a divergence on it between quote and invoice is detectable.
    // A line with no percentage keeps none rather than gaining a zero.
    ...(item.discountPercent === undefined ? {} : { discountPercent: item.discountPercent }),
    amountHt: item.amountHt,
    discountAmount: item.discountAmount,
    netAmountHt: item.netAmountHt,
    tva: item.tva,
    unitPriceTtc: item.unitPriceTtc,
    totalTtc: item.totalTtc
  });
}

// An amount of money written into a text: digits followed by a currency — "1600
// DH", "6 900 DH", "1 600,00 MAD", "250 €". Used to detect, never to cut: the
// designation is the company's text, and nothing here rewrites it.
const PRICE_IN_TEXT = /\d[\d\s  .,]*\s*(?:DHS?|MAD|dirhams?|€|EUR)(?![A-Za-zÀ-ÿ])/i;

export function designationStatesPrice(value) {
  return typeof value === "string" && PRICE_IN_TEXT.test(value);
}

// The designation a line is delivered under, when one was written for the
// delivery note, or null.
function deliveryNoteDesignationOf(item) {
  const value = item?.deliveryNoteDesignation;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// A designation written for the delivery note, for a line whose own designation
// states a price. It is stated or absent: never blank, and never a price itself —
// a delivery note that repeats one has solved nothing.
function assertDeliveryNoteDesignation(item, index) {
  const value = item?.deliveryNoteDesignation;
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new DocumentBundleError(
      `items.${index}.deliveryNoteDesignation must be a non-empty text.`,
      "DELIVERY_NOTE_DESIGNATION_INVALID",
      { index }
    );
  }
  if (designationStatesPrice(value)) {
    throw new DocumentBundleError(
      `items.${index}.deliveryNoteDesignation states a price, and a delivery note carries none.`,
      "DELIVERY_NOTE_DESIGNATION_PRICED",
      { index }
    );
  }
}

// The delivered view. Every pricing field is left out rather than emptied: a
// key holding null is still a column waiting to be printed. A line given a
// designation for the delivery note is delivered under it; any other keeps its
// own, which the quote and the invoice keep in every case.
function deliveredLine(item) {
  const line = { designation: deliveryNoteDesignationOf(item) ?? item.designation, quantity: item.quantity };
  if (text(item.unit) !== "") {
    line.unit = item.unit;
  }
  return Object.freeze(line);
}

export function createDocumentBundle({
  client = {},
  project = {},
  items = [],
  tvaRate = DEFAULT_TVA_RATE,
  discount = null,
  paymentScheduleRuleId = null,
  paymentScheduleParts = null,
  paymentMethod = "",
  dates = {},
  numbers = {},
  numbering = createDocumentNumberingService()
} = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new DocumentBundleError("A commercial file needs at least one line.", "BUNDLE_ITEMS_REQUIRED");
  }
  items.forEach(assertDeliveryNoteDesignation);

  // One calculation, shared by the three documents.
  const calculated = calculateDocumentTotals(items, tvaRate, discount ? { discount } : {});

  const schedule = paymentScheduleRuleId || paymentScheduleParts
    ? createPaymentSchedule({
      ruleId: paymentScheduleRuleId,
      parts: paymentScheduleParts,
      totalTtc: calculated.totals.totalTtc
    })
    : null;

  const assigned = Object.freeze({
    quote: resolveNumber(numbering, HKIDS_DOCUMENT_TYPES.QUOTE, numbers.quote),
    invoice: resolveNumber(numbering, HKIDS_DOCUMENT_TYPES.INVOICE, numbers.invoice),
    deliveryNote: resolveNumber(numbering, HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE, numbers.deliveryNote)
  });

  const normalizedClient = Object.freeze({ ...client });
  const payment = Object.freeze({
    method: text(paymentMethod),
    termsRule: schedule?.ruleId ?? null,
    terms: schedule?.label ?? ""
  });

  const quote = Object.freeze({
    documentType: HKIDS_DOCUMENT_TYPES.QUOTE,
    documentNumber: assigned.quote.number,
    numberStatus: assigned.quote.status,
    numberMessage: assigned.quote.message,
    date: text(dates.quoteDate),
    client: normalizedClient,
    items: Object.freeze(calculated.items.map(pricedLine)),
    totals: calculated.totals,
    discount: calculated.discount,
    payment,
    schedule
  });

  const invoice = Object.freeze({
    documentType: HKIDS_DOCUMENT_TYPES.INVOICE,
    documentNumber: assigned.invoice.number,
    numberStatus: assigned.invoice.status,
    numberMessage: assigned.invoice.message,
    date: text(dates.invoiceDate),
    // Filled from the quote it repeats, and left empty when the quote has no
    // number yet rather than pointing at nothing.
    quoteReference: quote.documentNumber ?? "",
    client: normalizedClient,
    items: Object.freeze(calculated.items.map(pricedLine)),
    totals: calculated.totals,
    discount: calculated.discount,
    payment,
    schedule
  });

  const deliveryNote = Object.freeze({
    documentType: HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE,
    // Stated explicitly: this is the delivery note of a commercial file, not
    // the historical priced one, and assertNoPricing holds it to that.
    deliveryNoteProfile: DELIVERY_NOTE_PROFILES.GOODS_ONLY,
    documentNumber: assigned.deliveryNote.number,
    numberStatus: assigned.deliveryNote.status,
    numberMessage: assigned.deliveryNote.message,
    date: text(dates.deliveryNoteDate),
    quoteReference: quote.documentNumber ?? "",
    invoiceReference: invoice.documentNumber ?? "",
    client: normalizedClient,
    items: Object.freeze(calculated.items.map(deliveredLine)),
    deliveryDate: text(dates.deliveryDate),
    deliveryDateText: deliveryDateText(dates.deliveryDate),
    deliveryDateDefined: isDeliveryDateDefined(dates.deliveryDate)
    // No totals, no payment: a delivery note states what was handed over.
  });

  // One review of the project, read two ways: what is answered and what is
  // not. Deriving both from the same pass means a field cannot be reported as
  // answered on one annex and missing on another.
  const informationReview = reviewProjectInformation(project);
  const missingInformation = Object.freeze(
    informationReview.filter((entry) => entry.status === INFORMATION_STATUSES.MISSING)
  );
  const documents = Object.freeze({ quote, invoice, deliveryNote });

  const bundle = Object.freeze({
    client: normalizedClient,
    project: Object.freeze({ ...project }),
    items: calculated.items,
    totals: calculated.totals,
    discount: calculated.discount,
    tvaRate: calculated.totals.tvaRate,
    payment,
    schedule,
    numbers: assigned,
    documents,
    missingInformation,
    // The papers derived from the same file. They read the figures computed
    // once above; none of them recomputes anything.
    deliverables: createDeliverables({
      documents,
      calculated,
      schedule,
      client: normalizedClient,
      project,
      missingInformation,
      informationReview,
      numbers: assigned
    })
  });

  return Object.freeze({ ...bundle, issues: validateDocumentBundle(bundle) });
}

function deliverable(kind, content) {
  const classification = deliverableAudience(kind);
  return Object.freeze({
    kind,
    label: HKIDS_DELIVERABLE_LABELS[kind],
    audience: classification.audience,
    audienceConfirmed: classification.confirmed,
    ...content
  });
}

/**
 * The papers of one commercial file, each derived from the single calculation.
 *
 * Nothing here computes a total, a discount or an installment: those were
 * settled once, by the modules that own them, and are read back. A deliverable
 * that recalculated anything would be a second opinion on the same order, which
 * is exactly what this bundle exists to prevent.
 */
function createDeliverables({ documents, calculated, schedule, client, project, missingInformation, informationReview, numbers }) {
  const { quote, invoice, deliveryNote } = documents;

  const orderSummary = deliverable(HKIDS_DELIVERABLE_KINDS.ORDER_SUMMARY, {
    client,
    lineCount: calculated.items.length,
    totalQuantity: calculated.items.reduce((total, item) => total + Number(item.quantity), 0),
    designations: Object.freeze(calculated.items.map((item) => item.designation)),
    // What was ordered, line by line, with the amount already computed for the
    // quote. No summary arithmetic of its own.
    lines: Object.freeze(calculated.items.map((item, index) => Object.freeze({
      index,
      designation: item.designation,
      unit: item.unit,
      quantity: item.quantity,
      netAmountHt: item.netAmountHt
    }))),
    totals: calculated.totals,
    paymentTerms: quote.payment.terms,
    paymentScheduleRuleId: quote.payment.termsRule,
    paymentInstallments: schedule
      ? Object.freeze(schedule.installments.map((entry) => Object.freeze({
        percent: entry.percent,
        amountTtc: entry.amountTtc,
        condition: entry.condition
      })))
      : null
  });

  // Line by line, what was billed and why. This is the paper that shows the
  // rebate base, which is why it is read as an internal one until H-KIDS says
  // otherwise.
  const calculationSheet = deliverable(HKIDS_DELIVERABLE_KINDS.CALCULATION_SHEET, {
    lines: Object.freeze(calculated.items.map((item, index) => Object.freeze({
      index,
      designation: item.designation,
      unit: item.unit,
      quantity: item.quantity,
      unitPriceHt: item.unitPriceHt,
      grossAmountHt: item.amountHt,
      discountAmount: item.discountAmount,
      netAmountHt: item.netAmountHt,
      tva: item.tva,
      totalTtc: item.totalTtc
    }))),
    discount: calculated.discount,
    totals: calculated.totals
  });

  // The money due at order time, taken from the schedule rather than from a
  // percentage written here: the plan decides, and the plan may be one of four.
  // With no schedule chosen there is no deposit to ask for, and saying so is
  // more useful than a zero.
  const firstInstallment = schedule?.installments?.[0] ?? null;
  const depositRequest = deliverable(HKIDS_DELIVERABLE_KINDS.DEPOSIT_REQUEST, {
    available: firstInstallment !== null,
    client,
    percent: firstInstallment?.percent ?? null,
    amountTtc: firstInstallment?.amountTtc ?? null,
    condition: firstInstallment?.condition ?? null,
    totalTtc: calculated.totals.totalTtc,
    paymentScheduleRuleId: schedule?.ruleId ?? null
  });

  const criticalMissing = missingInformation.filter((entry) => entry.critical).length;

  // Where the file stands. Every field is a fact already established elsewhere;
  // nothing is filled in to make the sheet look complete.
  const internalTrackingSheet = deliverable(HKIDS_DELIVERABLE_KINDS.INTERNAL_TRACKING_SHEET, {
    client,
    project: Object.freeze({ ...project }),
    numbers: Object.freeze(Object.fromEntries(
      Object.entries(numbers).map(([key, entry]) => [key, Object.freeze({
        status: entry.status,
        number: entry.number,
        // The register's own words when it has not answered, so the sheet says
        // why a number is absent instead of leaving a blank.
        message: entry.message ?? null
      })])
    )),
    paymentScheduleChosen: schedule !== null,
    paymentScheduleRuleId: schedule?.ruleId ?? null,
    paymentScheduleLabel: schedule?.label ?? null,
    deliveryDateDefined: deliveryNote.deliveryDateDefined,
    // Absent stays absent: the raw date is empty and the sentence says so.
    deliveryDate: deliveryNote.deliveryDate === "" ? null : deliveryNote.deliveryDate,
    deliveryDateText: deliveryNote.deliveryDateText,
    missingInformationCount: missingInformation.length,
    criticalMissingInformationCount: criticalMissing,
    quoteReference: invoice.quoteReference,
    invoiceReference: deliveryNote.invoiceReference,
    // What has to be settled before this file can be issued, each answered by a
    // fact rather than by a judgement made here.
    prerequisites: Object.freeze({
      officialNumbersAssigned: Object.values(numbers).every((entry) => entry.status === "assigned"),
      paymentScheduleChosen: schedule !== null,
      criticalInformationComplete: criticalMissing === 0,
      deliveryDateKnown: deliveryNote.deliveryDateDefined
    })
  });

  // The questions still to put to the customer, and the answers already given.
  // Both sides come from the same review, so a field cannot be counted as
  // answered here and missing elsewhere.
  const missingInformationList = deliverable(HKIDS_DELIVERABLE_KINDS.MISSING_INFORMATION_LIST, {
    entries: informationReview,
    missing: missingInformation,
    provided: Object.freeze(informationReview.filter((entry) => entry.status === INFORMATION_STATUSES.PROVIDED)),
    missingCount: missingInformation.length,
    criticalMissingCount: criticalMissing,
    providedCount: informationReview.length - missingInformation.length,
    summary: summariseMissingInformation(project)
  });

  return Object.freeze({
    quote: deliverable(HKIDS_DELIVERABLE_KINDS.QUOTE, { document: quote }),
    invoice: deliverable(HKIDS_DELIVERABLE_KINDS.INVOICE, { document: invoice }),
    deliveryNote: deliverable(HKIDS_DELIVERABLE_KINDS.DELIVERY_NOTE, { document: deliveryNote }),
    orderSummary,
    calculationSheet,
    depositRequest,
    internalTrackingSheet,
    missingInformationList
  });
}

/**
 * The deliverables meant for the customer, and the ones that stay inside.
 * Reading the audience from the deliverable itself keeps the split in one
 * place, so a caller cannot decide differently.
 */
export function clientDeliverables(bundle) {
  return Object.freeze(
    Object.values(bundle.deliverables).filter((entry) => entry.audience === DELIVERABLE_AUDIENCES.CLIENT)
  );
}

export function internalDeliverables(bundle) {
  return Object.freeze(
    Object.values(bundle.deliverables).filter((entry) => entry.audience === DELIVERABLE_AUDIENCES.INTERNAL)
  );
}

// The order as it is delivered: the quote's lines, each under the designation it
// is delivered under. The delivery note is held to it, so its quantities and units
// are still the quote's, and a line given a delivery-note designation is expected
// to carry that one and no other.
function orderAsDelivered(quote, items = []) {
  return Object.freeze({
    ...quote,
    items: Object.freeze(quote.items.map((line, index) => {
      const delivered = deliveryNoteDesignationOf(items?.[index]);
      return delivered === null ? line : Object.freeze({ ...line, designation: delivered });
    }))
  });
}

/**
 * Everything that would stop this file being issued as it stands. The result is
 * a list rather than an exception, because a file waiting for a register number
 * or for a customer answer is a normal state that still has to be worked on.
 */
export function validateDocumentBundle(bundle) {
  const issues = [];
  const { quote, invoice, deliveryNote } = bundle.documents;

  issues.push(...validateInvoiceMatchesQuote(quote, invoice));
  issues.push(...validateDeliveryNoteMatchesOrder(orderAsDelivered(quote, bundle.items), invoice, deliveryNote));

  // A delivery note carries no price, in its fields or in its words. A line whose
  // designation states one, and was given no designation for the delivery note,
  // is reported: the text is the company's, and it is never cut here.
  deliveryNote.items.forEach((item, index) => {
    if (designationStatesPrice(item.designation)) {
      issues.push(Object.freeze({
        field: `documents.deliveryNote.items.${index}.designation`,
        code: "DELIVERY_NOTE_DESIGNATION_PRICED",
        message: "La désignation de cette ligne du bon de livraison indique un prix : "
          + "une désignation propre au bon de livraison est à fournir."
      }));
    }
  });

  for (const [key, document] of Object.entries(bundle.documents)) {
    if (document.numberStatus === "pending_registry") {
      issues.push(Object.freeze({
        field: `documents.${key}.documentNumber`,
        code: "DOCUMENT_NUMBER_PENDING_REGISTRY",
        message: document.numberMessage
      }));
    }
  }

  if (bundle.schedule === null) {
    issues.push(Object.freeze({
      field: "schedule",
      code: "PAYMENT_SCHEDULE_MISSING",
      message: "Aucun échéancier n'a été choisi pour ce dossier."
    }));
  }

  for (const missing of bundle.missingInformation) {
    issues.push(Object.freeze({
      field: `project.${missing.id}`,
      code: "PROJECT_INFORMATION_MISSING",
      message: missing.message,
      critical: missing.critical
    }));
  }

  // A deposit cannot be asked for before a plan is chosen. Reported rather than
  // answered with a zero, which would read as "nothing is due".
  if (bundle.deliverables?.depositRequest && bundle.deliverables.depositRequest.available !== true) {
    issues.push(Object.freeze({
      field: "deliverables.depositRequest",
      code: "DEPOSIT_REQUEST_UNAVAILABLE",
      message: "Aucun acompte ne peut être demandé tant qu'aucun échéancier n'est choisi."
    }));
  }

  // Two deliverables are not settled as customer-facing or internal by anything
  // in this repository. Surfacing it on the file is how the question reaches
  // the person who can answer it, instead of a guess hardening into a rule.
  for (const entry of Object.values(bundle.deliverables ?? {})) {
    if (entry.audienceConfirmed === false) {
      issues.push(Object.freeze({
        field: `deliverables.${entry.kind}.audience`,
        code: "DELIVERABLE_AUDIENCE_UNCONFIRMED",
        message: `${entry.label} : destinataire à confirmer par H-KIDS (traité comme ${entry.audience} en attendant).`
      }));
    }
  }

  return Object.freeze(issues);
}

/**
 * True when nothing blocks the file: the documents agree, every number is
 * assigned, a schedule is chosen, and no critical customer information is
 * outstanding.
 */
export function isBundleReadyToIssue(bundle) {
  return bundle.issues.every((issue) => issue.code === "PROJECT_INFORMATION_MISSING" && issue.critical !== true);
}
