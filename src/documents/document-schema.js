export const HKIDS_DOCUMENT_TYPES = Object.freeze({
  DELIVERY_NOTE: "delivery_note",
  INVOICE: "invoice",
  PURCHASE_ORDER: "purchase_order"
});

export const HKIDS_DOCUMENT_TYPE_LABELS = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE]: "BON DE LIVRAISON",
  [HKIDS_DOCUMENT_TYPES.INVOICE]: "FACTURE",
  [HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER]: "BON DE COMMANDE"
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

export const REQUIRED_INVOICE_FIELDS = Object.freeze([
  ...REQUIRED_DOCUMENT_FIELDS,
  "deliveryNoteReference"
]);

// A purchase order is signed before anything is paid, so the payment method is
// not known yet and is not required. The terms are: they are what the client
// signs for.
export const REQUIRED_PURCHASE_ORDER_FIELDS = Object.freeze(
  REQUIRED_DOCUMENT_FIELDS.filter((field) => field !== "payment.method")
);

export function isControlledDocumentType(value) {
  return Object.values(HKIDS_DOCUMENT_TYPES).includes(value);
}
