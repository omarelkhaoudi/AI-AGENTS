export const HKIDS_DOCUMENT_TYPES = Object.freeze({
  QUOTE: "quote",
  DELIVERY_NOTE: "delivery_note",
  INVOICE: "invoice",
  PURCHASE_ORDER: "purchase_order",
  // Corrects or cancels an invoice already issued, in part or in full. It names
  // that invoice and never comes to more than it.
  CREDIT_NOTE: "credit_note",
  // States a payment received from the client on a sale: an instalment of its
  // quote, or the settlement of one of its invoices.
  PAYMENT_RECEIPT: "payment_receipt"
});

export const HKIDS_DOCUMENT_TYPE_LABELS = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.QUOTE]: "DEVIS",
  [HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE]: "BON DE LIVRAISON",
  [HKIDS_DOCUMENT_TYPES.INVOICE]: "FACTURE",
  [HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER]: "BON DE COMMANDE",
  [HKIDS_DOCUMENT_TYPES.CREDIT_NOTE]: "AVOIR",
  [HKIDS_DOCUMENT_TYPES.PAYMENT_RECEIPT]: "REÇU DE PAIEMENT"
});

// How a client may pay, as a receipt states it. A receipt records money that
// actually came in, so the way it came is one of these and nothing else.
export const PAYMENT_RECEIPT_METHODS = Object.freeze([
  "espèces",
  "virement bancaire",
  "chèque",
  "carte bancaire",
  "effet de commerce"
]);

// What becomes of the amount a credit note gives back.
export const CREDIT_NOTE_SETTLEMENTS = Object.freeze([
  "déduit du reste à payer",
  "remboursement par virement bancaire",
  "remboursement en espèces",
  "remboursement par chèque"
]);

// The three documents of one commercial file, in the order they are issued. A
// document may reference the ones before it and never the ones after.
export const HKIDS_DOCUMENT_SEQUENCE = Object.freeze([
  HKIDS_DOCUMENT_TYPES.QUOTE,
  HKIDS_DOCUMENT_TYPES.INVOICE,
  HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE
]);

// Who a deliverable is written for. A quote leaves the building under the
// company's name; a calculation sheet exposes the discount base and does not.
// Confusing the two is how an internal working paper ends up in a customer's
// inbox, so every deliverable states its audience rather than leaving a reader
// to infer it from the name.
export const DELIVERABLE_AUDIENCES = Object.freeze({
  CLIENT: "client",
  INTERNAL: "internal"
});

// The deliverables of one commercial file.
//
// The specification speaks of seven. Three of them are the commercial documents
// themselves — quote, invoice, delivery note — and the rest are papers derived
// from the same file. They are listed here as one set so nothing has to force a
// count: what matters is that each one declares what it is and who it is for.
export const HKIDS_DELIVERABLE_KINDS = Object.freeze({
  QUOTE: "quote",
  INVOICE: "invoice",
  DELIVERY_NOTE: "delivery_note",
  ORDER_SUMMARY: "order_summary",
  CALCULATION_SHEET: "calculation_sheet",
  DEPOSIT_REQUEST: "deposit_request",
  INTERNAL_TRACKING_SHEET: "internal_tracking_sheet",
  MISSING_INFORMATION_LIST: "missing_information_list"
});

// The three commercial documents, and the five annexes derived from the same
// file. Splitting them here means no caller has to decide which is which.
export const HKIDS_COMMERCIAL_DOCUMENT_KINDS = Object.freeze([
  HKIDS_DELIVERABLE_KINDS.QUOTE,
  HKIDS_DELIVERABLE_KINDS.INVOICE,
  HKIDS_DELIVERABLE_KINDS.DELIVERY_NOTE
]);

export const HKIDS_ANNEX_KINDS = Object.freeze([
  HKIDS_DELIVERABLE_KINDS.ORDER_SUMMARY,
  HKIDS_DELIVERABLE_KINDS.CALCULATION_SHEET,
  HKIDS_DELIVERABLE_KINDS.DEPOSIT_REQUEST,
  HKIDS_DELIVERABLE_KINDS.INTERNAL_TRACKING_SHEET,
  HKIDS_DELIVERABLE_KINDS.MISSING_INFORMATION_LIST
]);

export const HKIDS_DELIVERABLE_LABELS = Object.freeze({
  [HKIDS_DELIVERABLE_KINDS.QUOTE]: "Devis",
  [HKIDS_DELIVERABLE_KINDS.INVOICE]: "Facture",
  [HKIDS_DELIVERABLE_KINDS.DELIVERY_NOTE]: "Bon de livraison",
  [HKIDS_DELIVERABLE_KINDS.ORDER_SUMMARY]: "Résumé de commande",
  [HKIDS_DELIVERABLE_KINDS.CALCULATION_SHEET]: "Fiche de calcul détaillée",
  [HKIDS_DELIVERABLE_KINDS.DEPOSIT_REQUEST]: "Demande d'acompte",
  [HKIDS_DELIVERABLE_KINDS.INTERNAL_TRACKING_SHEET]: "Fiche interne de suivi",
  [HKIDS_DELIVERABLE_KINDS.MISSING_INFORMATION_LIST]: "Liste des informations manquantes"
});

// Audience per deliverable, and whether that classification is settled.
//
// Five are settled by the documents themselves: a quote, an invoice, a delivery
// note and a request for a deposit are addressed to the customer, and a sheet
// H-KIDS named "fiche interne de suivi" is not. Three are not decided by
// anything in this repository:
//
//   order_summary            — an internal recap, or an order confirmation sent
//                              to the customer? Both readings fit the name.
//   calculation_sheet        — read as an internal working paper here, because
//                              it exposes the discount base line by line, which
//                              is not something a customer is normally shown.
//   missing_information_list — read as internal, because it is a list of
//                              questions the team still has to ask. But a
//                              company may well send that list to the customer
//                              to have it filled in, and nothing here says
//                              which H-KIDS does.
//
// Rather than pick one and let it harden into a rule, the unsettled ones carry
// `confirmed: false` and are reported as an issue on the file. The provisional
// reading is stated so the model is usable today; H-KIDS decides, and this flag
// is where that decision lands.
export const HKIDS_DELIVERABLE_AUDIENCE = Object.freeze({
  [HKIDS_DELIVERABLE_KINDS.QUOTE]: Object.freeze({ audience: DELIVERABLE_AUDIENCES.CLIENT, confirmed: true }),
  [HKIDS_DELIVERABLE_KINDS.INVOICE]: Object.freeze({ audience: DELIVERABLE_AUDIENCES.CLIENT, confirmed: true }),
  [HKIDS_DELIVERABLE_KINDS.DELIVERY_NOTE]: Object.freeze({ audience: DELIVERABLE_AUDIENCES.CLIENT, confirmed: true }),
  [HKIDS_DELIVERABLE_KINDS.DEPOSIT_REQUEST]: Object.freeze({ audience: DELIVERABLE_AUDIENCES.CLIENT, confirmed: true }),
  [HKIDS_DELIVERABLE_KINDS.INTERNAL_TRACKING_SHEET]: Object.freeze({ audience: DELIVERABLE_AUDIENCES.INTERNAL, confirmed: true }),
  [HKIDS_DELIVERABLE_KINDS.MISSING_INFORMATION_LIST]: Object.freeze({ audience: DELIVERABLE_AUDIENCES.INTERNAL, confirmed: false }),
  [HKIDS_DELIVERABLE_KINDS.ORDER_SUMMARY]: Object.freeze({ audience: DELIVERABLE_AUDIENCES.INTERNAL, confirmed: false }),
  [HKIDS_DELIVERABLE_KINDS.CALCULATION_SHEET]: Object.freeze({ audience: DELIVERABLE_AUDIENCES.INTERNAL, confirmed: false })
});

export function deliverableAudience(kind) {
  return HKIDS_DELIVERABLE_AUDIENCE[kind] ?? null;
}

// The fields that carry a reference from one document to another, named once so
// no other part of the code invents a name of its own.
export const HKIDS_REFERENCE_FIELDS = Object.freeze({
  QUOTE: "quoteReference",
  INVOICE: "invoiceReference",
  DELIVERY_NOTE: "deliveryNoteReference"
});

// Which references each document may carry. An invoice points back at its
// quote; a delivery note points back at both. Nothing points forward, and no
// reference is ever filled in automatically: an absent reference stays absent.
export const HKIDS_EXPECTED_REFERENCES = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.QUOTE]: Object.freeze([]),
  [HKIDS_DOCUMENT_TYPES.INVOICE]: Object.freeze([HKIDS_REFERENCE_FIELDS.QUOTE]),
  [HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE]: Object.freeze([
    HKIDS_REFERENCE_FIELDS.QUOTE,
    HKIDS_REFERENCE_FIELDS.INVOICE
  ]),
  // A credit note names the invoice it corrects; it may name its quote too.
  [HKIDS_DOCUMENT_TYPES.CREDIT_NOTE]: Object.freeze([
    HKIDS_REFERENCE_FIELDS.INVOICE,
    HKIDS_REFERENCE_FIELDS.QUOTE
  ]),
  // A receipt names the sale it is paid on: its quote, or the invoice settled.
  [HKIDS_DOCUMENT_TYPES.PAYMENT_RECEIPT]: Object.freeze([
    HKIDS_REFERENCE_FIELDS.QUOTE,
    HKIDS_REFERENCE_FIELDS.INVOICE
  ])
});

export const REQUIRED_DOCUMENT_FIELDS = Object.freeze([
  "documentType",
  "documentNumber",
  "date",
  "client.name",
  "client.address",
  "items",
  "totals.totalHt",
  "totals.tva",
  "totals.totalTtc",
  "payment.method",
  "payment.terms"
]);

// An invoice must point at whatever came before it, and two flows exist.
//
// The historical H-KIDS invoice follows a delivery note: the renderer prints
// "Référence BL : n" and the cockpit has a field for it. The commercial file
// introduced with the quote runs the other way round — quote, then invoice,
// then delivery note — and the invoice points at its quote.
//
// Requiring one particular reference would break one of the two flows, so an
// invoice must carry at least one of them. It still cannot exist referencing
// nothing: `UPSTREAM_REFERENCE_FIELDS` is checked as a group, not skipped.
export const UPSTREAM_REFERENCE_FIELDS = Object.freeze([
  HKIDS_REFERENCE_FIELDS.QUOTE,
  HKIDS_REFERENCE_FIELDS.DELIVERY_NOTE
]);

// Kept for the callers that read it. `deliveryNoteReference` is no longer an
// unconditional requirement — see UPSTREAM_REFERENCE_FIELDS — but it remains
// the reference the historical invoice uses.
export const REQUIRED_INVOICE_FIELDS = Object.freeze([...REQUIRED_DOCUMENT_FIELDS]);

// A quote is priced like an invoice but references nothing before it.
export const REQUIRED_QUOTE_FIELDS = Object.freeze([...REQUIRED_DOCUMENT_FIELDS]);

/**
 * The two shapes a delivery note can take, named rather than guessed.
 *
 * PRICED is the official H-KIDS document as it exists today: its columns are
 * "Image, Désignation, Qté, Pu HT, Total HT" and it prints the totals and the
 * payment method. That is what the reference template, the renderers and the
 * cockpit produce, and it is not this lot's place to change it.
 *
 * GOODS_ONLY is the delivery note of the commercial file: designation,
 * quantity, unit, and nothing else. It carries no price, no total and no
 * payment, and `assertNoPricing` enforces that.
 *
 * The profile is stated on the input; it is never inferred. PRICED is the
 * default because it is what every existing caller means.
 */
export const DELIVERY_NOTE_PROFILES = Object.freeze({
  PRICED: "priced",
  GOODS_ONLY: "goods_only"
});

export const DEFAULT_DELIVERY_NOTE_PROFILE = DELIVERY_NOTE_PROFILES.PRICED;

// A delivery note that states only the goods needs none of the money fields.
export const REQUIRED_GOODS_ONLY_DELIVERY_NOTE_FIELDS = Object.freeze([
  "documentType",
  "documentNumber",
  "date",
  "client.name",
  "client.address",
  "items"
]);

// A purchase order is signed before anything is paid, so the payment method is
// not known yet and is not required. The terms are: they are what the client
// signs for.
export const REQUIRED_PURCHASE_ORDER_FIELDS = Object.freeze(
  REQUIRED_DOCUMENT_FIELDS.filter((field) => field !== "payment.method")
);

// A credit note and a receipt settle no schedule: what they say about money is
// the settlement of the credit, or the way the payment was made.
export const REQUIRED_CREDIT_NOTE_FIELDS = Object.freeze(
  REQUIRED_DOCUMENT_FIELDS.filter((field) => field !== "payment.terms")
);
export const REQUIRED_PAYMENT_RECEIPT_FIELDS = REQUIRED_CREDIT_NOTE_FIELDS;

// A receipt states money received, not a sale: it carries no VAT of its own.
export const PAYMENT_RECEIPT_TVA_RATE = 0;

export function isControlledDocumentType(value) {
  return Object.values(HKIDS_DOCUMENT_TYPES).includes(value);
}

export function isDeliveryNoteProfile(value) {
  return Object.values(DELIVERY_NOTE_PROFILES).includes(value);
}

/**
 * Whether this document may carry money at all.
 *
 * A quote and an invoice always do. A delivery note does only under the PRICED
 * profile — which is why the profile has to be passed in rather than deduced
 * from the type alone.
 */
export function carriesPricing(documentType, deliveryNoteProfile = DEFAULT_DELIVERY_NOTE_PROFILE) {
  if (documentType !== HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE) {
    return true;
  }
  return deliveryNoteProfile !== DELIVERY_NOTE_PROFILES.GOODS_ONLY;
}

export function requiredFieldsFor(documentType, { deliveryNoteProfile = DEFAULT_DELIVERY_NOTE_PROFILE } = {}) {
  if (documentType === HKIDS_DOCUMENT_TYPES.INVOICE) {
    return REQUIRED_INVOICE_FIELDS;
  }
  if (documentType === HKIDS_DOCUMENT_TYPES.QUOTE) {
    return REQUIRED_QUOTE_FIELDS;
  }
  if (documentType === HKIDS_DOCUMENT_TYPES.CREDIT_NOTE) {
    return REQUIRED_CREDIT_NOTE_FIELDS;
  }
  if (documentType === HKIDS_DOCUMENT_TYPES.PAYMENT_RECEIPT) {
    return REQUIRED_PAYMENT_RECEIPT_FIELDS;
  }
  if (
    documentType === HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE
    && deliveryNoteProfile === DELIVERY_NOTE_PROFILES.GOODS_ONLY
  ) {
    return REQUIRED_GOODS_ONLY_DELIVERY_NOTE_FIELDS;
  }
  return REQUIRED_DOCUMENT_FIELDS;
}
