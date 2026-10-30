import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { HkidsDocumentService, InMemoryRepository, HKIDS_ACTIVE_PAYMENT_TERMS } from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// The client is invented, like every name in this file. A committed fixture is
// read by anyone who clones the repository, so it must never carry the name or
// the address of a real customer.
const NOMINAL = Object.freeze({
  documentType: "invoice",
  documentNumber: "165",
  date: "05/09/2026",
  object: "Vente de mobilier",
  deliveryNoteReference: "98",
  client: { name: "MADAME DUPONT", address: "Ville Exemple" },
  items: [
    { designation: "Canapé", unit: "U", quantity: 1, unitPriceHt: 4500, amountHt: 4500 },
    { designation: "Matelas", unit: "U", quantity: 1, unitPriceHt: 1500, amountHt: 1500 },
    { designation: "Tour de lit", unit: "U", quantity: 1, unitPriceHt: 1300, amountHt: 1300 }
  ],
  totals: { totalHt: 7300, tva: 1460, totalTtc: 8760 },
  payment: { method: "virement bancaire", termsRule: HKIDS_ACTIVE_PAYMENT_TERMS.id },
  note: "Référence règlement propriété totalité"
});

async function createApi(t) {
  const repository = new InMemoryRepository();
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-documents-"));
  const { app, inject } = await buildAuthenticatedApi({ repository, documentOutputDir: outputDir });
  t.after(async () => {
    await app.close();
    await rm(outputDir, { recursive: true, force: true });
  });
  return { inject, repository, outputDir };
}

test("preview validates and returns all document data without writing final files", async (t) => {
  const { inject, outputDir } = await createApi(t);
  const response = await inject({ method: "POST", url: "/api/documents/preview", payload: NOMINAL });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.status, "ready_for_confirmation");
  assert.equal(body.document.documentNumber, "165");
  assert.equal(body.document.object, "Vente de mobilier");
  assert.equal(body.document.deliveryNoteReference, "98");
  assert.equal(body.document.totals.totalHt, 7300);
  assert.equal(body.document.totals.tva, 1460);
  assert.equal(body.document.totals.totalTtc, 8760);
  assert.equal(body.template.id, "hkids-invoice-builtin", "drawn in code, no template file");
  assert.equal(body.template.path, null);
  assert.ok(body.previewToken);
  assert.deepEqual(await readdir(outputDir), []);
});

test("generate requires explicit confirmation and a matching preview token", async (t) => {
  const { inject } = await createApi(t);

  const withoutConfirmation = await inject({ method: "POST", url: "/api/documents/generate", payload: NOMINAL });
  assert.equal(withoutConfirmation.statusCode, 400);
  assert.match(withoutConfirmation.body, /CONFIRMATION_REQUIRED/);

  const withoutPreview = await inject({
    method: "POST",
    url: "/api/documents/generate",
    payload: { ...NOMINAL, userConfirmation: true, previewToken: "not-a-real-preview" }
  });
  assert.equal(withoutPreview.statusCode, 409);
  assert.match(withoutPreview.body, /PREVIEW_CONFIRMATION_REQUIRED/);
});

test("document service treats null outputDir as the default generated documents directory", () => {
  const service = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: null });

  assert.ok(service.outputDir.endsWith("assets\\documents\\generated") || service.outputDir.endsWith("assets/documents/generated"));
});

test("generate revalidates, stores PDF and DOCX metadata, and download returns files", async (t) => {
  const { inject } = await createApi(t);
  const preview = JSON.parse((await inject({ method: "POST", url: "/api/documents/preview", payload: NOMINAL })).body);
  const generated = await inject({
    method: "POST",
    url: "/api/documents/generate",
    payload: { ...NOMINAL, userConfirmation: true, previewToken: preview.previewToken }
  });
  const body = JSON.parse(generated.body);

  assert.equal(generated.statusCode, 201);
  assert.equal(body.status, "generated");
  assert.equal(body.files.pdf.mimeType, "application/pdf");
  assert.equal(body.files.docx.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  const pdfDownload = await inject({ method: "GET", url: body.files.pdf.downloadUrl });
  const docxDownload = await inject({ method: "GET", url: body.files.docx.downloadUrl });
  assert.equal(pdfDownload.statusCode, 200);
  assert.equal(pdfDownload.headers["content-type"], "application/pdf");
  assert.equal((await PDFDocument.load(pdfDownload.rawPayload)).getPageCount(), 1);
  assert.equal(docxDownload.statusCode, 200);
  assert.match(docxDownload.headers["content-type"], /officedocument/);
});

