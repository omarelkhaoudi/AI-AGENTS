import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { createDocumentBundle } from "./document-bundle-service.js";
import {
  HKIDS_ANNEX_KINDS,
  HKIDS_DELIVERABLE_KINDS,
  HKIDS_DELIVERABLE_LABELS,
  HKIDS_DOCUMENT_TYPES
} from "./document-schema.js";
import { renderHkidsDocx } from "./docx-renderer.js";
import { renderHkidsPdf } from "./pdf-renderer.js";
import { renderQuotePdf } from "./quote-pdf-renderer.js";

/**
 * What the API needs to hand a commercial file to a person.
 *
 * The file itself is built by createDocumentBundle, the amounts by the
 * calculation module and the installments by the payment module. Nothing here
 * computes anything: this service answers two questions the interface has to
 * ask — what does this file contain, and which of its deliverables can actually
 * be produced today — and then produces one.
 *
 * There is no store of commercial files. The bundle is a pure function of its
 * input, and persisting one would need an identifier, a lifecycle and an owner
 * that nothing in this project specifies. So a file is composed from the
 * request, exactly as the existing document routes already work, and only the
 * produced files are persisted.
 */

export class CommercialFileError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "CommercialFileError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// Why a deliverable cannot be produced, said in the words a user reads.
export const RENDERING_UNAVAILABLE_REASONS = Object.freeze({
  NO_RENDERER: "Ce livrable est modélisé mais n'a pas encore de rendu.",
  TEMPLATE_REQUIRED: "Le gabarit officiel H-KIDS est nécessaire et n'est pas configuré."
});

const RENDERABLE_FORMATS = Object.freeze(["pdf", "docx"]);

/**
 * The renderers, one entry per deliverable that can really be produced.
 *
 * This table is the only thing that makes a deliverable renderable, and it names
 * the functions that produce THAT document together with the bundle document
 * they are given. A deliverable absent from it is not renderable, whatever else
 * is configured: a configured template is not a renderer.
 *
 * Every H-KIDS document is drawn in code, in the company's design, so a
 * deliverable with a renderer can always be produced: no template is needed.
 */
const RENDERERS = Object.freeze({
  [HKIDS_DELIVERABLE_KINDS.QUOTE]: Object.freeze({
    document: "quote",
    documentType: HKIDS_DOCUMENT_TYPES.QUOTE,
    pdf: renderQuotePdf,
    docx: renderHkidsDocx
  }),
  [HKIDS_DELIVERABLE_KINDS.INVOICE]: Object.freeze({
    document: "invoice",
    documentType: HKIDS_DOCUMENT_TYPES.INVOICE,
    pdf: renderHkidsPdf,
    docx: renderHkidsDocx
  }),
  [HKIDS_DELIVERABLE_KINDS.DELIVERY_NOTE]: Object.freeze({
    document: "deliveryNote",
    documentType: HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE,
    pdf: renderHkidsPdf,
    docx: renderHkidsDocx
  })
});

// What to say about a deliverable no renderer covers: today, the five annexes.
function unavailableReason() {
  return RENDERING_UNAVAILABLE_REASONS.NO_RENDERER;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

// A file name a person can recognise and a machine can predict. A document with
// no register number is named as having none: nothing is invented to fill the
// slot, and the same file always produces the same name.
export function commercialFileStem(kind, document) {
  const prefix = {
    [HKIDS_DELIVERABLE_KINDS.QUOTE]: "devis",
    [HKIDS_DELIVERABLE_KINDS.INVOICE]: "facture",
    [HKIDS_DELIVERABLE_KINDS.DELIVERY_NOTE]: "bon_livraison"
  }[kind] ?? kind;

  const number = text(document?.documentNumber) === "" ? "sans-numero" : text(document.documentNumber);
  const date = text(document?.date) === "" ? "sans-date" : text(document.date);
  return `${prefix}_HKIDS_${number}_${date}`.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

/**
 * What each deliverable of this file is, who it is for, and whether it can be
 * produced right now. The interface reads this instead of deciding for itself.
 */
export async function describeDeliverables(bundle) {
  const described = [];

  for (const entry of Object.values(bundle.deliverables)) {
    const annex = HKIDS_ANNEX_KINDS.includes(entry.kind);
    const renderer = RENDERERS[entry.kind];
    let available = false;
    let reason = null;

    if (!renderer) {
      reason = unavailableReason();
    } else {
      available = true;
    }

    described.push(Object.freeze({
      kind: entry.kind,
      label: HKIDS_DELIVERABLE_LABELS[entry.kind],
      audience: entry.audience,
      audienceConfirmed: entry.audienceConfirmed,
      annex,
      rendering: Object.freeze({
        available,
        formats: available ? Object.freeze([...RENDERABLE_FORMATS]) : Object.freeze([]),
        reason
      })
    }));
  }

  return Object.freeze(described);
}

export function createCommercialFileService({ repository, outputDir = null } = {}) {
  const directory = outputDir ?? join(process.cwd(), "assets", "documents", "generated");

  return Object.freeze({
    outputDir: directory,

    /**
     * Builds the file and reports it. Nothing is written and nothing is sent:
     * this is the read a person does before deciding to produce anything.
     */
    async describe(input = {}) {
      const bundle = createDocumentBundle(input);
      return Object.freeze({
        status: "ready",
        file: Object.freeze({
          client: bundle.client,
          project: bundle.project,
          items: bundle.items,
          totals: bundle.totals,
          discount: bundle.discount,
          tvaRate: bundle.tvaRate,
          payment: bundle.payment,
          schedule: bundle.schedule,
          numbers: bundle.numbers,
          documents: bundle.documents,
          deliverables: bundle.deliverables
        }),
        deliverables: await describeDeliverables(bundle),
        missingInformation: bundle.missingInformation,
        issues: bundle.issues
      });
    },

    /**
     * Produces one deliverable of the file, as a PDF and an editable Word
     * document, and records the two files so they can be downloaded through the
     * route that already serves documents.
     *
     * The file is rebuilt from the same input rather than carried between
     * calls: two requests with the same input produce the same file, and a
     * caller cannot hand back a bundle it altered in between.
     */
    async render(input = {}, { deliverable, createdById = null } = {}) {
      const kind = text(deliverable);
      if (!Object.values(HKIDS_DELIVERABLE_KINDS).includes(kind)) {
        throw new CommercialFileError(
          `Unknown deliverable: ${deliverable}`,
          "DELIVERABLE_UNKNOWN",
          { deliverable, known: Object.values(HKIDS_DELIVERABLE_KINDS) }
        );
      }

      const bundle = createDocumentBundle(input);
      const described = (await describeDeliverables(bundle)).find((entry) => entry.kind === kind);
      if (!described.rendering.available) {
        throw new CommercialFileError(
          described.rendering.reason,
          "DELIVERABLE_NOT_RENDERABLE",
          { deliverable: kind }
        );
      }

      // The deliverable is produced by its own renderer, from its own document.
      // A deliverable declared available always has an entry here: the check
      // above reads the same table, so the two can never disagree.
      const renderer = RENDERERS[kind];
      const document = bundle.documents[renderer.document];
      // The failure this guards against did happen: render() read the quote
      // whatever was asked for, and an invoice came back as a quote under an
      // invoice name. It is cheap, and it makes that class of mistake loud.
      if (document?.documentType !== renderer.documentType) {
        throw new CommercialFileError(
          `Le rendu de ${kind} produirait un document ${document?.documentType ?? "inconnu"}.`,
          "DELIVERABLE_DOCUMENT_MISMATCH",
          { deliverable: kind, produced: document?.documentType ?? null }
        );
      }

      const pdfBytes = await renderer.pdf(document);
      const docxBytes = await renderer.docx(document);

      await mkdir(directory, { recursive: true });
      const stem = commercialFileStem(kind, document);
      const pdfKey = resolve(directory, `${stem}.pdf`);
      const docxKey = resolve(directory, `${stem}.docx`);
      await writeFile(pdfKey, pdfBytes);
      await writeFile(docxKey, docxBytes);

      const pdf = await repository.createDocument({
        requestId: null,
        uploadedById: createdById,
        name: `${stem}.pdf`,
        mimeType: "application/pdf",
        storageKey: pdfKey,
        checksum: checksum(pdfBytes),
        sizeBytes: pdfBytes.length,
        metadata: { deliverable: kind, documentType: document.documentType, format: "pdf" }
      });
      const docx = await repository.createDocument({
        requestId: null,
        uploadedById: createdById,
        name: `${stem}.docx`,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        storageKey: docxKey,
        checksum: checksum(docxBytes),
        sizeBytes: docxBytes.length,
        metadata: { deliverable: kind, documentType: document.documentType, format: "docx" }
      });

      return Object.freeze({
        status: "generated",
        deliverable: described,
        document,
        files: Object.freeze({ pdf: fileResponse(pdf), docx: fileResponse(docx) }),
        issues: bundle.issues
      });
    }
  });
}

function checksum(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileResponse(document) {
  return Object.freeze({
    id: document.id,
    name: document.name,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    checksum: document.checksum,
    // Served by the route that already downloads documents; no second one.
    downloadUrl: `/api/documents/${document.id}/download`
  });
}

export function normalizeCommercialFileError(error) {
  if (error instanceof CommercialFileError) {
    const statusCode = error.code === "DELIVERABLE_UNKNOWN" ? 400 : 409;
    return { statusCode, body: { error: error.message, details: { code: error.code, ...error.details } } };
  }
  return null;
}
