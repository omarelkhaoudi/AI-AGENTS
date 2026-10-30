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

export function referenceLabelFor(document) {
  if (document.documentType === HKIDS_DOCUMENT_TYPES.INVOICE) {
    return `Référence BL: ${document.deliveryNoteReference}`;
  }
  return document.reference ? `Référence: ${document.reference}` : "";
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
