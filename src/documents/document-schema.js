export const HKIDS_DOCUMENT_TYPES = Object.freeze({
  DELIVERY_NOTE: "delivery_note",
  INVOICE: "invoice"
});

export const HKIDS_DOCUMENT_TYPE_LABELS = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE]: "BON DE LIVRAISON",
  [HKIDS_DOCUMENT_TYPES.INVOICE]: "FACTURE"
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

export function isControlledDocumentType(value) {
  return Object.values(HKIDS_DOCUMENT_TYPES).includes(value);
}
