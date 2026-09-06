import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateAndPrepareDocument, DocumentValidationError } from "./document-validation.js";
import { renderHkidsPdf } from "./pdf-renderer.js";
import { renderHkidsDocx } from "./docx-renderer.js";
import { assertHkidsTemplateAvailable } from "./hkids-template.js";

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

  constructor({ repository, outputDir = null } = {}) {
    this.repository = repository;
    this.outputDir = outputDir ?? join(process.cwd(), "assets", "documents", "generated");
  }

  async preview(input = {}) {
    const document = validateAndPrepareDocument(input);
    const template = await assertHkidsTemplateAvailable(document.documentType);
    const previewHash = hashPayload({ document: stripRuntimeFields(document), templateChecksum: template.checksum });
    const previewToken = randomUUID();
    this.#previewTokens.set(previewToken, previewHash);
    return Object.freeze({
      status: "ready_for_confirmation",
      template: publicTemplateInfo(template),
      document,
      previewToken
    });
  }

  async generate(input = {}, { createdById = null } = {}) {
    const document = validateAndPrepareDocument(input, { requireConfirmation: true });
    const template = await assertHkidsTemplateAvailable(document.documentType);
    const expectedHash = this.#previewTokens.get(document.previewToken);
    const actualHash = hashPayload({ document: stripRuntimeFields(document), templateChecksum: template.checksum });
    if (!expectedHash || expectedHash !== actualHash) {
      throw new DocumentGenerationError("A matching preview validation is required before generation.", "PREVIEW_CONFIRMATION_REQUIRED", {
        field: "previewToken"
      });
    }

    await mkdir(this.outputDir, { recursive: true });
    const stem = safeFileStem(document);
    const pdfBuffer = await renderHkidsPdf(document);
    const docxBuffer = await renderHkidsDocx(document);
    const pdfStorageKey = resolve(this.outputDir, `${stem}.pdf`);
    const docxStorageKey = resolve(this.outputDir, `${stem}.docx`);
    await writeFile(pdfStorageKey, pdfBuffer);
    await writeFile(docxStorageKey, docxBuffer);

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

function safeFileStem(document) {
  const prefix = document.documentType === "invoice" ? "facture" : "bon_livraison";
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
  if (error?.code === "HKIDS_TEMPLATE_MISSING") {
    return { statusCode: 500, body: { error: error.message, details: { code: error.code, ...error.details } } };
  }
  if (error?.code === "HKIDS_TEMPLATE_CHECKSUM_MISMATCH") {
    return { statusCode: 500, body: { error: error.message, details: { code: error.code, ...error.details } } };
  }
  return null;
}
