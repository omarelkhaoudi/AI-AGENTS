import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HKIDS_DOCUMENT_TYPE_LABELS, HKIDS_DOCUMENT_TYPES } from "./document-schema.js";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const HKIDS_LOGO_PATH = join(PROJECT_ROOT, "assets", "documents", "hkids-logo.jpg");

// The identity printed on every H-KIDS document. The address is the one of the
// company register, as on the purchase orders and quotes: DOUAR HARAKAT, not
// the Al Mazar shop address the old templates carried.
//
// Documents used to be painted over PDF templates the company supplied. The
// company adopted the design of its purchase orders for every document, which
// is drawn in pdf-renderer.js, so there is no template to configure any more.
export const HKIDS_FIXED_IDENTITY = Object.freeze({
  companyName: "H KIDS",
  addressLines: Object.freeze([
    "Adresse : DOUAR HARAKAT N 2153",
    "TASSELTANT SAADA MARRAKECH"
  ]),
  email: "hkidsmaroc@gmail.com",
  phone: "0524018420",
  legalLine: "ICE:002635757000066 - IF 47322069 - RC 109155 - PATENTE 47952443 - CNSS 2305083 - www.hkids.store",
  footerMention: "Les produits H KIDS deviennent la propriété du client uniquement après le règlement intégral de la facture.",
  deliveryNoteColumns: Object.freeze(["Désignation", "Qté", "Prix unitaire HT", "Montant HT"]),
  invoiceColumns: Object.freeze(["Désignation", "Qté", "Unité", "PU HT", "TVA", "PU TTC", "Total HT", "Total TTC"]),
  columns: Object.freeze(["Désignation", "Qté", "Prix unitaire HT", "Montant HT"])
});

export const HKIDS_ACTIVE_PAYMENT_TERMS = Object.freeze({
  id: "hkids-60-20-20-2026",
  label: "60 % à la commande ; 20 % avant livraison ; 20 % après installation.",
  parts: Object.freeze([
    Object.freeze({ percent: 60, due: "à la commande" }),
    Object.freeze({ percent: 20, due: "avant livraison" }),
    Object.freeze({ percent: 20, due: "après installation" })
  ])
});

export function documentTitleFor(type) {
  return HKIDS_DOCUMENT_TYPE_LABELS[type] ?? null;
}

/**
 * The upstream document an invoice points at, and how to label it.
 *
 * Two flows exist. The historical invoice follows a delivery note; the invoice
 * of a commercial file follows a quote. Printing "Référence BL" whatever the
 * document carried put that label on a quote number, which is simply wrong.
 *
 * The quote is looked at first because it is the upstream document of the
 * newer flow; an invoice carrying only a delivery note reference keeps its
 * historical label. Returns null when the invoice references nothing: no
 * reference is ever invented, and none is substituted for another.
 */
export function invoiceUpstreamReference(document) {
  const quote = typeof document?.quoteReference === "string" ? document.quoteReference.trim() : "";
  if (quote !== "") {
    return Object.freeze({ field: "quoteReference", label: "Référence devis", value: quote });
  }

  const deliveryNote = typeof document?.deliveryNoteReference === "string"
    ? document.deliveryNoteReference.trim()
    : "";
  if (deliveryNote !== "") {
    return Object.freeze({ field: "deliveryNoteReference", label: "Référence BL", value: deliveryNote });
  }

  return null;
}

/**
 * The documents a delivery note refers back to.
 *
 * The delivery note of a commercial file carries both: the quote the order came
 * from, and the invoice it is billed on. Only the references the document
 * actually holds are returned, so a missing one prints nothing rather than an
 * empty label, and none is ever invented.
 */
export function deliveryNoteReferences(document) {
  const references = [];

  const quote = typeof document?.quoteReference === "string" ? document.quoteReference.trim() : "";
  if (quote !== "") {
    references.push(Object.freeze({ field: "quoteReference", label: "Référence devis", value: quote }));
  }

  const invoice = typeof document?.invoiceReference === "string" ? document.invoiceReference.trim() : "";
  if (invoice !== "") {
    references.push(Object.freeze({ field: "invoiceReference", label: "Référence facture", value: invoice }));
  }

  return Object.freeze(references);
}

export function referenceLabelFor(document) {
  if (document.documentType === HKIDS_DOCUMENT_TYPES.INVOICE) {
    const upstream = invoiceUpstreamReference(document);
    return upstream ? `${upstream.label}: ${upstream.value}` : "";
  }
  const quote = purchaseOrderQuoteReference(document);
  if (quote) {
    return `Référence devis: ${quote}`;
  }
  return document.reference ? `Référence: ${document.reference}` : "";
}

// A purchase order made from a quote names it, so the order on paper says which
// quote the client accepted.
export function purchaseOrderQuoteReference(document) {
  if (document?.documentType !== HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER) {
    return "";
  }
  return typeof document.quoteReference === "string" ? document.quoteReference.trim() : "";
}

// Describes how a document is drawn, in the place the template descriptor used
// to be, so the preview and generation responses keep their shape.
export function documentLayoutFor(type) {
  return Object.freeze({
    id: `hkids-${String(type).replace(/_/g, "-")}-builtin`,
    path: null,
    checksum: null,
    expectedChecksum: null,
    locked: false,
    expectedPageCount: null,
    sizeBytes: null
  });
}
