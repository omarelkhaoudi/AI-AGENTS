import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HKIDS_DOCUMENT_TYPE_LABELS, HKIDS_DOCUMENT_TYPES } from "./document-schema.js";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const HKIDS_TEMPLATE_DIR = join(PROJECT_ROOT, "assets", "documents", "hkids");
export const HKIDS_DELIVERY_NOTE_TEMPLATE_PATH = join(HKIDS_TEMPLATE_DIR, "bon_livraison_reference.pdf");
export const HKIDS_INVOICE_TEMPLATE_PATH = join(HKIDS_TEMPLATE_DIR, "facture_reference.pdf");
export const HKIDS_TEMPLATE_PATH = HKIDS_DELIVERY_NOTE_TEMPLATE_PATH;
export const HKIDS_LOGO_PATH = join(PROJECT_ROOT, "assets", "documents", "hkids-logo.jpg");
export const HKIDS_LOGO_SOURCE_PAGE_INDEX = 0;

export const HKIDS_FIXED_IDENTITY = Object.freeze({
  companyName: "H KIDS",
  addressLines: Object.freeze([
    "Adresse : Centre Commercial Al Mazar Zone",
    "Touristique d'agdal"
  ]),
  email: "hkidsmaroc@gmail.com",
  phone: "0524018420",
  legalLine: "ICE:002635757000066 - IF 47322069 - RC 109155 - PATENTE 47952443 - CNSS 2305083 - www.hkids.store",
  footerMention: "Les produits H KIDS deviennent la propriété du client uniquement après le règlement intégral de la facture.",
  deliveryNoteColumns: Object.freeze(["Image", "Désignation", "Qté", "Pu HT", "Total HT"]),
  invoiceColumns: Object.freeze(["Désignation", "Qté", "Unité", "Pu Brut", "TVA", "Pu TTC", "Total HT", "Total TTC"]),
  columns: Object.freeze(["Image", "Désignation", "Qté", "Pu HT", "Total HT"])
});

const COMMON_MARKERS = Object.freeze([
  "H KIDS",
  "ICE:002635757000066",
  "IF 47322069",
  "RC 109155",
  "PATENTE 47952443",
  "CNSS 2305083",
  "www.hkids.store"
]);

// The reference templates are not versioned with the project. The two files
// that used to sit here were real filled documents: a named customer, an order
// and its amounts, all of it still selectable under the white boxes the renderer
// paints. They were removed, and shipping them again would put a person's data
// back into a repository handed to a third party.
//
// So the templates became configuration. The company supplies its own blank
// documents and names them here; the layout coordinates below expect the H-KIDS
// page geometry, and a template of a different shape will render badly rather
// than fail loudly.
export const HKIDS_TEMPLATE_VARIABLES = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE]: Object.freeze({
    path: "HKIDS_DELIVERY_NOTE_TEMPLATE_PATH",
    checksum: "HKIDS_DELIVERY_NOTE_TEMPLATE_CHECKSUM"
  }),
  [HKIDS_DOCUMENT_TYPES.INVOICE]: Object.freeze({
    path: "HKIDS_INVOICE_TEMPLATE_PATH",
    checksum: "HKIDS_INVOICE_TEMPLATE_CHECKSUM"
  })
});

const TEMPLATE_DEFINITIONS = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE]: Object.freeze({
    id: "hkids-delivery-note-reference",
    defaultPath: HKIDS_DELIVERY_NOTE_TEMPLATE_PATH,
    expectedPageCount: 3,
    requiredMarkers: Object.freeze(["BON DE LIVRAISON", ...COMMON_MARKERS])
  }),
  [HKIDS_DOCUMENT_TYPES.INVOICE]: Object.freeze({
    id: "hkids-invoice-reference",
    defaultPath: HKIDS_INVOICE_TEMPLATE_PATH,
    expectedPageCount: 2,
    requiredMarkers: Object.freeze(["Facture", ...COMMON_MARKERS])
  })
});

// The checksum lock is kept, and it is now opt-in rather than baked in. A
// company that names its template and its digest gets exactly the old
// guarantee: one byte changed and generation stops. A company that names only
// the file gets no lock, and the returned descriptor says so instead of
// pretending otherwise.
export function templateLockFor(type, env = process.env) {
  const definition = TEMPLATE_DEFINITIONS[type];
  if (!definition) {
    return null;
  }

  const variables = HKIDS_TEMPLATE_VARIABLES[type];
  const configuredPath = readSetting(env[variables.path]);
  const expectedChecksum = readSetting(env[variables.checksum]);

  return Object.freeze({
    id: definition.id,
    path: configuredPath ?? definition.defaultPath,
    pathIsConfigured: configuredPath !== null,
    expectedChecksum,
    locked: expectedChecksum !== null,
    expectedPageCount: definition.expectedPageCount,
    requiredMarkers: definition.requiredMarkers,
    pathVariable: variables.path,
    checksumVariable: variables.checksum
  });
}

function readSetting(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value.trim();
}

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

export async function assertHkidsTemplateAvailable(typeOrPath = HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE, env = process.env) {
  const lock = templateLockFor(typeOrPath, env);
  const path = lock?.path ?? typeOrPath;
  try {
    await access(path, constants.R_OK);
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0) {
      throw new Error("Template path is not a readable file.");
    }
    const checksum = await checksumFile(path);
    if (lock?.locked && checksum !== lock.expectedChecksum) {
      const error = new Error(`Le template H-KIDS ${lock.id} ne correspond pas au checksum attendu.`);
      error.code = "HKIDS_TEMPLATE_CHECKSUM_MISMATCH";
      error.details = { path, expectedChecksum: lock.expectedChecksum, actualChecksum: checksum, templateId: lock.id };
      throw error;
    }
    return Object.freeze({
      id: lock?.id ?? "custom-template",
      path,
      sizeBytes: info.size,
      checksum,
      expectedChecksum: lock?.expectedChecksum ?? null,
      locked: lock?.locked ?? false,
      expectedPageCount: lock?.expectedPageCount ?? null
    });
  } catch (cause) {
    if (cause.code === "HKIDS_TEMPLATE_CHECKSUM_MISMATCH") {
      throw cause;
    }
    // The message names the variable to set. The templates are no longer part
    // of the repository, so "missing" is the normal state of a fresh clone and
    // the reader must be told what to do about it, not merely that it failed.
    const error = new Error(
      lock
        ? `Le template H-KIDS ${lock.id} est introuvable. Renseignez ${lock.pathVariable} avec le chemin d'un gabarit fourni par l'entreprise.`
        : "Le template de référence H-KIDS est nécessaire avant de poursuivre."
    );
    error.code = "HKIDS_TEMPLATE_MISSING";
    error.details = {
      path,
      templateId: lock?.id ?? null,
      pathVariable: lock?.pathVariable ?? null,
      cause: cause.message
    };
    throw error;
  }
}

export async function checksumFile(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}
