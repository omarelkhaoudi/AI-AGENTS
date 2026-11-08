import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { readWordText } from "../agent/chat-attachments.js";
import { validateAndPrepareDocument, DocumentValidationError } from "./document-validation.js";
import { HKIDS_DOCUMENT_TYPES } from "./document-schema.js";
import { logoPath, renderHkidsPdf } from "./pdf-renderer.js";
import { isPurchaseOrderNumberUsed, nextPurchaseOrderNumber } from "./purchase-order.js";
import { renderHkidsDocx } from "./docx-renderer.js";
import { documentLayoutFor } from "./hkids-template.js";
import { checkInvoice, dossierNotices, dossierOf, summarizeIssuedContent, summarizeIssuedWord } from "./document-ledger.js";

export class DocumentGenerationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "DocumentGenerationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export class HkidsDocumentService {
  #previewTokens = new Map();
  // What an issued document says, read once per file name. A correction that
  // keeps the date is written under the same name, so generate forgets it.
  #summaries = new Map();

  constructor({ repository, outputDir = null } = {}) {
    this.repository = repository;
    this.outputDir = outputDir ?? join(process.cwd(), "assets", "documents", "generated");
  }

  // replaceExisting: the document corrects one already issued under the same
  // type and number. It must exist; on generation its files are archived, never
  // deleted. The choice is part of what the preview token confirms.
  async preview(input = {}, { replaceExisting = false } = {}) {
    const document = validateAndPrepareDocument(input);
    if (replaceExisting) {
      await this.#assertIssued(document);
    } else {
      await this.#assertPurchaseOrderNumberFree(document);
      await this.#assertNumberFree(document);
    }
    const chain = await this.#checkChain(document, { replaceExisting });
    const template = await templateFor(document.documentType);
    const previewHash = hashPayload({ document: stripRuntimeFields(document), templateChecksum: template.checksum, replaceExisting });
    const previewToken = randomUUID();
    this.#previewTokens.set(previewToken, previewHash);
    return Object.freeze({
      status: "ready_for_confirmation",
      template: publicTemplateInfo(template),
      document,
      notices: dossierNotices(document, chain),
      previewToken
    });
  }

  async generate(input = {}, { createdById = null, replaceExisting = false } = {}) {
    const document = validateAndPrepareDocument(input, { requireConfirmation: true });
    const template = await templateFor(document.documentType);
    const expectedHash = this.#previewTokens.get(document.previewToken);
    const actualHash = hashPayload({ document: stripRuntimeFields(document), templateChecksum: template.checksum, replaceExisting });
    if (!expectedHash || expectedHash !== actualHash) {
      throw new DocumentGenerationError("A matching preview validation is required before generation.", "PREVIEW_CONFIRMATION_REQUIRED", {
        field: "previewToken"
      });
    }

    // Checked again at generation: another document may have taken the number
    // between the preview and the confirmation.
    if (replaceExisting) {
      await this.#assertIssued(document);
    } else {
      await this.#assertPurchaseOrderNumberFree(document);
      await this.#assertNumberFree(document);
    }
    await this.#checkChain(document, { replaceExisting });

    const pdfBuffer = await renderHkidsPdf(document);
    const docxBuffer = await renderHkidsDocx(document);
    await mkdir(this.outputDir, { recursive: true });
    if (replaceExisting) {
      await this.#archiveIssued(document);
    }
    const stem = safeFileStem(document);
    const pdfStorageKey = resolve(this.outputDir, `${stem}.pdf`);
    const docxStorageKey = resolve(this.outputDir, `${stem}.docx`);
    await writeFile(pdfStorageKey, pdfBuffer);
    await writeFile(docxStorageKey, docxBuffer);
    // What the document says, kept beside its files so that an agent asked to
    // correct it later starts from its exact content, visual included.
    await writeFile(resolve(this.outputDir, `${stem}.json`), JSON.stringify(issuedContent(input), null, 2));
    this.#summaries.delete(stem);

    const pdf = await this.repository.createDocument({
      requestId: null,
      uploadedById: createdById,
      name: `${stem}.pdf`,
      mimeType: "application/pdf",
      storageKey: pdfStorageKey,
      checksum: checksumBuffer(pdfBuffer),
      sizeBytes: pdfBuffer.length,
      metadata: { documentType: document.documentType, documentNumber: document.documentNumber, template: publicTemplateInfo(template), format: "pdf" }
    });
    const docx = await this.repository.createDocument({
      requestId: null,
      uploadedById: createdById,
      name: `${stem}.docx`,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      storageKey: docxStorageKey,
      checksum: checksumBuffer(docxBuffer),
      sizeBytes: docxBuffer.length,
      metadata: { documentType: document.documentType, documentNumber: document.documentNumber, template: publicTemplateInfo(template), format: "docx" }
    });

    this.#previewTokens.delete(document.previewToken);
    return Object.freeze({
      status: "generated",
      template: publicTemplateInfo(template),
      document,
      files: Object.freeze({
        pdf: fileResponse(pdf),
        docx: fileResponse(docx)
      })
    });
  }

  async nextPurchaseOrderNumber() {
    return nextPurchaseOrderNumber(await this.#generatedPurchaseOrderNumbers());
  }

  // The next free number of any type, read from the documents already issued:
  // the ones issued by hand before the generator existed, and every file this
  // service wrote. Null when nothing is known for the type, so the caller asks
  // instead of starting a series at an invented number.
  async nextDocumentNumber(documentType) {
    if (documentType === HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER) {
      return this.nextPurchaseOrderNumber();
    }
    const prefix = FILE_PREFIXES[documentType];
    if (!prefix) {
      return null;
    }
    const used = (await this.#outputNames())
      .map((name) => Number(new RegExp(`^${prefix}_HKIDS_(\\d+)_`).exec(name)?.[1]))
      .filter((number) => Number.isInteger(number) && number > 0);
    const highest = Math.max(ISSUED_BY_HAND[documentType] ?? 0, ...used, 0);
    return highest > 0 ? String(highest + 1) : null;
  }

  async #outputNames() {
    try {
      return await readdir(this.outputDir);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return [];
    }
  }

  // Generated orders are read back from the output directory, which survives a
  // restart, so a number handed out once is never handed out again.
  async #generatedPurchaseOrderNumbers() {
    let names = [];
    try {
      names = await readdir(this.outputDir);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    return names
      .map((name) => new RegExp(`^${PURCHASE_ORDER_FILE_PREFIX}_HKIDS_(\\d+)_`).exec(name)?.[1])
      .filter(Boolean);
  }

  // The files of an issued document, found by type and number whatever its date.
  async #issuedFiles(documentType, documentNumber) {
    const prefix = FILE_PREFIXES[documentType];
    if (!prefix) {
      return [];
    }
    const pattern = new RegExp(`^${prefix}_HKIDS_${String(documentNumber).replace(/[^a-zA-Z0-9_-]+/g, "_")}_.+\\.(pdf|docx|json)$`);
    return (await this.#outputNames()).filter((name) => pattern.test(name));
  }

  // A number already printed on a generated document is never printed on
  // another one by accident: correcting a document is an explicit replacement.
  async #assertNumberFree(document) {
    if ((await this.#issuedFiles(document.documentType, document.documentNumber)).length > 0) {
      throw new DocumentGenerationError("This document number has already been issued.", "DOCUMENT_NUMBER_USED", {
        field: "documentNumber",
        documentNumber: document.documentNumber,
        nextNumber: await this.nextDocumentNumber(document.documentType)
      });
    }
  }

  async #assertIssued(document) {
    if ((await this.#issuedFiles(document.documentType, document.documentNumber)).length === 0) {
      throw new DocumentGenerationError("There is no issued document with this number to replace.", "DOCUMENT_TO_REPLACE_NOT_FOUND", {
        field: "documentNumber",
        documentNumber: document.documentNumber
      });
    }
  }

  async #archiveIssued(document) {
    const archive = join(this.outputDir, ARCHIVE_DIR);
    await mkdir(archive, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (const name of await this.#issuedFiles(document.documentType, document.documentNumber)) {
      await rename(join(this.outputDir, name), join(archive, `remplace-${stamp}_${name}`));
    }
  }

  // What an issued document says: the content kept at its generation, or, for a
  // document generated before that was kept, the text of its Word file and the
  // visual found in its PDF. Null when no document has this type and number.
  async readIssued(documentType, documentNumber) {
    const names = await this.#issuedFiles(documentType, documentNumber);
    if (names.length === 0) {
      return null;
    }
    const json = names.find((name) => name.endsWith(".json"));
    if (json) {
      return { source: "content", input: JSON.parse(await readFile(join(this.outputDir, json), "utf8")) };
    }
    const docx = names.find((name) => name.endsWith(".docx"));
    const pdf = names.find((name) => name.endsWith(".pdf"));
    return {
      source: "word",
      text: docx ? readWordText(await readFile(join(this.outputDir, docx))) : "",
      referenceImage: pdf && documentType === HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER
        ? await referenceImageFromPdf(await readFile(join(this.outputDir, pdf)))
        : null
    };
  }

  // The PDF of an issued document, as the client receives it. Null when there is
  // none under this type and number.
  async readIssuedPdf(documentType, documentNumber) {
    const name = (await this.#issuedFiles(documentType, documentNumber)).find((entry) => entry.endsWith(".pdf"));
    return name ? { name, bytes: await readFile(join(this.outputDir, name)) } : null;
  }

  // One line per issued document: what it is, for whom, how much, and which
  // document it names before it. Read from its kept content, or from its Word
  // file when it was issued before the content was kept.
  async listIssued() {
    const stems = new Map();
    for (const name of await this.#outputNames()) {
      const match = ISSUED_FILE.exec(name);
      if (match) {
        const [, prefix, number, rest, extension] = match;
        const stem = `${prefix}_HKIDS_${number}_${rest}`;
        const entry = stems.get(stem) ?? { type: TYPE_BY_PREFIX[prefix], number, stem, extensions: new Set() };
        entry.extensions.add(extension);
        stems.set(stem, entry);
      }
    }
    const summaries = [];
    for (const entry of [...stems.values()].sort((a, b) => a.stem.localeCompare(b.stem))) {
      // Read again when the files of the document changed (its content removed).
      const files = [...entry.extensions].sort().join(",");
      if (this.#summaries.get(entry.stem)?.files !== files) {
        this.#summaries.set(entry.stem, { files, summary: await this.#summarize(entry) });
      }
      summaries.push(this.#summaries.get(entry.stem).summary);
    }
    return summaries;
  }

  async #summarize({ type, number, stem, extensions }) {
    if (extensions.has("json")) {
      return summarizeIssuedContent({ type, number, stem }, JSON.parse(await readFile(join(this.outputDir, `${stem}.json`), "utf8")));
    }
    const text = extensions.has("docx") ? readWordText(await readFile(join(this.outputDir, `${stem}.docx`))) : "";
    return summarizeIssuedWord({ type, number, stem }, text);
  }

  // Where the sale of a document stands: its quote, order, delivery notes and
  // invoices, what is invoiced and what remains. Null if it was never issued.
  async dossier(documentType, documentNumber) {
    return dossierOf(await this.listIssued(), { type: documentType, number: documentNumber });
  }

  // An invoice that would take the invoices of its sale past the sale itself is
  // refused: the same sale is never invoiced twice. Other documents only learn
  // which sale they belong to.
  async #checkChain(document, { replaceExisting }) {
    if (document.documentType !== HKIDS_DOCUMENT_TYPES.INVOICE) {
      return {};
    }
    const check = checkInvoice(await this.listIssued(), document, { replaceExisting });
    if (!check.ok) {
      throw new DocumentGenerationError("This invoice would invoice the sale more than its amount.", "INVOICE_EXCEEDS_SALE", {
        totalTtc: document.totals.totalTtc,
        ceiling: check.dossier.ceiling,
        ceilingFrom: check.dossier.ceilingFrom,
        invoicedBefore: check.invoicedBefore,
        remainingBefore: check.remainingBefore,
        previousInvoices: check.previous.map((entry) => ({ number: entry.number, date: entry.date, totalTtc: entry.totalTtc }))
      });
    }
    return check;
  }

  async #assertPurchaseOrderNumberFree(document) {
    if (document.documentType !== HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER) {
      return;
    }
    if (isPurchaseOrderNumberUsed(document.documentNumber, await this.#generatedPurchaseOrderNumbers())) {
      throw new DocumentGenerationError("This purchase order number has already been issued.", "PURCHASE_ORDER_NUMBER_USED", {
        field: "documentNumber",
        documentNumber: document.documentNumber,
        nextNumber: await this.nextPurchaseOrderNumber()
      });
    }
  }

  async download(documentId) {
    const document = await this.repository.getDocument(documentId);
    if (!document) {
      throw new DocumentGenerationError("Document not found.", "DOCUMENT_NOT_FOUND", { documentId });
    }
    return Object.freeze({
      metadata: document,
      bytes: await readFile(document.storageKey)
    });
  }
}

function stripRuntimeFields(document) {
  const { previewToken, userConfirmation, ...rest } = document;
  return rest;
}

// `version` used to be a field of the built-in lock. Templates are supplied by
// the company now, so there is no version to state; `locked` takes its place and
// says whether a checksum was configured, rather than leaving a reader to guess.
function publicTemplateInfo(template) {
  return Object.freeze({
    id: template.id,
    path: template.path,
    checksum: template.checksum,
    expectedChecksum: template.expectedChecksum,
    locked: template.locked,
    expectedPageCount: template.expectedPageCount,
    sizeBytes: template.sizeBytes
  });
}

function fileResponse(document) {
  return Object.freeze({
    id: document.id,
    name: document.name,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    checksum: document.checksum,
    downloadUrl: `/api/documents/${document.id}/download`
  });
}

function hashPayload(value) {
  return checksumBuffer(Buffer.from(JSON.stringify(value)));
}

function checksumBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// Every type is drawn in code now; the layout descriptor keeps the place the
// template descriptor had, so the preview hash and the responses keep their shape.
async function templateFor(documentType) {
  return documentLayoutFor(documentType);
}

const PURCHASE_ORDER_FILE_PREFIX = "bon_commande";
// Where a replaced document goes. Inside the output folder, so it stays out of
// the repository, and a folder, so its files never count as issued numbers.
const ARCHIVE_DIR = "annules";

function issuedContent(input) {
  const { previewToken, userConfirmation, ...content } = input;
  return content;
}

// The visual of a purchase order generated before its content was kept: the
// largest JPEG in its PDF that is not the logo.
async function referenceImageFromPdf(bytes) {
  const pdf = await PDFDocument.load(bytes);
  const logo = await readFile(logoPath());
  const images = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream
      && object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image")
      && object.dict.get(PDFName.of("Filter")) === PDFName.of("DCTDecode")
      && !Buffer.from(object.contents).equals(logo)) {
      images.push(Buffer.from(object.contents));
    }
  }
  const largest = images.sort((a, b) => b.length - a.length)[0];
  return largest ? `data:image/jpeg;base64,${largest.toString("base64")}` : null;
}

const FILE_PREFIXES = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.QUOTE]: "devis",
  [HKIDS_DOCUMENT_TYPES.INVOICE]: "facture",
  [HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE]: "bon_livraison",
  [HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER]: PURCHASE_ORDER_FILE_PREFIX
});

const TYPE_BY_PREFIX = Object.freeze(Object.fromEntries(Object.entries(FILE_PREFIXES).map(([type, prefix]) => [prefix, type])));
// An issued file at the top of the output folder; archived ones live in a
// subfolder and never match.
const ISSUED_FILE = /^(devis|facture|bon_livraison|bon_commande)_HKIDS_(\d+)_(.+)\.(pdf|docx|json)$/;

// The highest number issued by hand before the generator, per series. Quotes
// 160 to 163 were written by hand; the purchase orders have their own register.
const ISSUED_BY_HAND = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.QUOTE]: 163
});

function safeFileStem(document) {
  const prefix = FILE_PREFIXES[document.documentType] ?? "document";
  return `${prefix}_HKIDS_${document.documentNumber}_${document.date}`.replace(/[^a-zA-Z0-9_-]+/g, "_");
}

export function normalizeDocumentError(error) {
  if (error instanceof DocumentValidationError) {
    return { statusCode: 400, body: { error: error.message, details: { code: error.code, errors: error.errors } } };
  }
  if (error instanceof DocumentGenerationError) {
    const statusCode = error.code === "DOCUMENT_NOT_FOUND" ? 404 : 409;
    return { statusCode, body: { error: error.message, details: { code: error.code, ...error.details } } };
  }
  return null;
}
