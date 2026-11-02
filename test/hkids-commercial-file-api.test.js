import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  InMemoryRepository,
  buildApi,
  calculateDocumentTotals,
  createDocumentBundle
} from "../src/index.js";
import { buildAuthenticatedApi, createAuthenticatedUser } from "../test-support/api-auth.js";

/**
 * The commercial file, reached through the API.
 *
 * The routes are a way in, not a second implementation: what they answer is
 * built by the bundle service and computed by the calculation and payment
 * modules. These tests check that the API says what those modules say, and
 * that nothing is invented on the way through.
 *
 * The client is invented, as in every committed fixture.
 */

const OFFICIAL_CASE_ITEMS = Object.freeze([
  { designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1, unitPriceHt: 24000 },
  { designation: "Matelas enfant", unit: "U", quantity: 1, unitPriceHt: 1600 },
  { designation: "Bureau evolutif", unit: "U", quantity: 1, unitPriceHt: 6800 },
  { designation: "Armoire trois portes", unit: "U", quantity: 1, unitPriceHt: 8900 },
  { designation: "Papier peint personnalise", unit: "U", quantity: 1, unitPriceHt: 3400 },
  { designation: "Eclairage LED indirect", unit: "U", quantity: 1, unitPriceHt: 4500 },
  { designation: "Livraison et installation", unit: "U", quantity: 1, unitPriceHt: 2500 }
]);

const OFFICIAL_DISCOUNT = Object.freeze({
  percent: 5,
  appliesToIndexes: Object.freeze([0, 2, 3]),
  label: "Remise exceptionnelle"
});

const FILE_INPUT = Object.freeze({
  client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
  items: OFFICIAL_CASE_ITEMS,
  discount: OFFICIAL_DISCOUNT,
  paymentScheduleRuleId: "hkids-60-20-20-2026",
  paymentMethod: "virement bancaire",
  dates: { quoteDate: "06/09/2026" }
});

// Every produced file is written to a temporary directory, so a test run never
// leaves a document in the project.
async function createApi(t, options = {}) {
  const repository = new InMemoryRepository();
  const documentOutputDir = await mkdtemp(join(tmpdir(), "hkids-commercial-api-"));
  const api = await buildAuthenticatedApi({ repository, documentOutputDir, ...options });
  t.after(async () => {
    await api.app.close();
    await rm(documentOutputDir, { recursive: true, force: true });
  });
  return { ...api, repository, documentOutputDir };
}

function preview(inject, payload = FILE_INPUT) {
  return inject({ method: "POST", url: "/api/commercial-files/preview", payload });
}

function render(inject, deliverable, payload = FILE_INPUT) {
  return inject({ method: "POST", url: "/api/commercial-files/render", payload: { ...payload, deliverable } });
}

// --- preview ------------------------------------------------------------------

test("the preview route answers with the file the bundle service builds", async (t) => {
  const { inject } = await createApi(t);
  const response = await preview(inject);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.status, "ready");

  // The same input through the module directly, so the API is compared against
  // the business layer rather than against figures written here.
  const bundle = createDocumentBundle(FILE_INPUT);
  assert.deepEqual(body.file.totals, bundle.totals);
  assert.deepEqual(body.file.schedule.installments, bundle.schedule.installments);
  assert.equal(body.file.items.length, 7);
});

test("the amounts the API returns are the calculation module's", async (t) => {
  const { inject } = await createApi(t);
  const body = JSON.parse((await preview(inject)).body);
  const expected = calculateDocumentTotals(OFFICIAL_CASE_ITEMS, 0.2, { discount: OFFICIAL_DISCOUNT });

  assert.deepEqual(body.file.totals, expected.totals);
  assert.equal(body.file.totals.totalBrutHt, 51700);
  assert.equal(body.file.totals.totalDiscount, 1985);
  assert.equal(body.file.totals.totalNetHt, 49715);
  assert.equal(body.file.totals.tva, 9943);
  assert.equal(body.file.totals.totalTtc, 59658);
});

test("each deliverable reports its audience and whether it can be produced", async (t) => {
  const { inject } = await createApi(t);
  const body = JSON.parse((await preview(inject)).body);

  assert.equal(body.deliverables.length, 8);

  const quote = body.deliverables.find((entry) => entry.kind === "quote");
  assert.equal(quote.audience, "client");
  assert.equal(quote.rendering.available, true);
  assert.deepEqual(quote.rendering.formats, ["pdf", "docx"]);

  // The annexes are modelled and not rendered, and the answer says which.
  const annex = body.deliverables.find((entry) => entry.kind === "calculation_sheet");
  assert.equal(annex.audience, "internal");
  assert.equal(annex.rendering.available, false);
  assert.match(annex.rendering.reason, /n'a pas encore de rendu/);

  // The invoice is drawn in code, so it can always be produced.
  const invoice = body.deliverables.find((entry) => entry.kind === "invoice");
  assert.equal(invoice.rendering.available, true);
  assert.equal(invoice.rendering.reason, null);

  // The unsettled classifications travel through the API unchanged.
  assert.deepEqual(
    body.deliverables.filter((entry) => !entry.audienceConfirmed).map((entry) => entry.kind).sort(),
    ["calculation_sheet", "missing_information_list", "order_summary"]
  );
});

test("missing project information is reported, never completed", async (t) => {
  const { inject } = await createApi(t);
  const body = JSON.parse((await preview(inject, { ...FILE_INPUT, project: { fullAddress: "12 rue Exemple" } })).body);

  assert.equal(body.missingInformation.length, 11);
  for (const entry of body.missingInformation) {
    assert.equal(entry.status, "missing");
    assert.equal(entry.value, null);
  }
  assert.ok(body.issues.some((issue) => issue.code === "PROJECT_INFORMATION_MISSING"));
});

test("a file with no register number is reported as pending, and no number appears", async (t) => {
  const { inject } = await createApi(t);
  const result = await preview(inject);
  const body = JSON.parse(result.body);

  const documents = Object.values(body.file.documents);
  assert.equal(documents.length, 3);
  for (const document of documents) {
    assert.equal(document.documentNumber, null);
    assert.equal(document.numberStatus, "pending_registry");
  }
  assert.ok(body.issues.some((issue) => issue.code === "DOCUMENT_NUMBER_PENDING_REGISTRY"));
  // Not only in the number field: no sequence is invented anywhere in the answer.
  assert.equal(/DEV-HK-\d{4}-\d{4}/.test(result.body), false, "no number may be fabricated");
});

// --- rendering ----------------------------------------------------------------

test("rendering a quote returns a PDF and an editable Word file", async (t) => {
  const { inject } = await createApi(t);
  const result = await render(inject, "quote");
  const body = JSON.parse(result.body);

  assert.equal(result.statusCode, 201);
  assert.equal(body.status, "generated");
  assert.equal(body.deliverable.kind, "quote");
  assert.equal(body.files.pdf.mimeType, "application/pdf");
  assert.equal(
    body.files.docx.mimeType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  // A file name a person can recognise, and no number invented to build it.
  assert.match(body.files.pdf.name, /^devis_HKIDS_sans-numero_06_09_2026\.pdf$/);
});

test("the produced files download with the right headers", async (t) => {
  const { inject } = await createApi(t);
  const body = JSON.parse((await render(inject, "quote")).body);

  for (const [format, mimeType] of [
    ["pdf", "application/pdf"],
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
  ]) {
    const download = await inject({ method: "GET", url: body.files[format].downloadUrl });
    assert.equal(download.statusCode, 200, format);
    assert.equal(download.headers["content-type"], mimeType, format);
    assert.equal(
      download.headers["content-disposition"],
      `attachment; filename="${body.files[format].name}"`,
      format
    );
    assert.ok(download.rawPayload.length > 1000, format);
  }
});

test("the same input produces the same file name twice", async (t) => {
  const { inject } = await createApi(t);
  const first = JSON.parse((await render(inject, "quote")).body);
  const second = JSON.parse((await render(inject, "quote")).body);

  assert.equal(first.files.pdf.name, second.files.pdf.name);
  assert.equal(first.files.docx.name, second.files.docx.name);
});

test("nothing is written outside the configured output directory", async (t) => {
  const { inject, documentOutputDir, repository } = await createApi(t);
  const body = JSON.parse((await render(inject, "quote")).body);

  // Each recorded document points inside the directory the API was given, and
  // the bytes on disk are the ones the repository says were written.
  for (const format of ["pdf", "docx"]) {
    const stored = await repository.getDocument(body.files[format].id);
    assert.equal(stored.storageKey, resolve(documentOutputDir, body.files[format].name), format);
    const written = await readFile(stored.storageKey);
    assert.equal(written.length, stored.sizeBytes, format);
    assert.ok(written.length > 1000, format);
  }
});

// --- a configured template is not a renderer --------------------------------------
//
// The audit found render() reading bundle.documents.quote whatever was asked
// for, while describeDeliverables() offered the invoice and the delivery note as
// soon as a template was configured. A quote could therefore be produced under
// the name of a facture. These tests configure the templates - the case the
// suite never covered - and check what actually comes out.

test("with the templates configured, only the deliverables that have a renderer are offered", async (t) => {
  const { inject } = await createApi(t);
  const body = JSON.parse((await preview(inject)).body);
  const kindOf = (kind) => body.deliverables.find((entry) => entry.kind === kind);

  // The invoice has a real renderer: the template one, which draws the official
  // invoice. With the template configured it becomes producible.
  assert.equal(kindOf("invoice").rendering.available, true);

  // The delivery note has one too, since the GOODS_ONLY renderer exists: it
  // draws the same official page without a single price on it.
  assert.equal(kindOf("delivery_note").rendering.available, true);
  assert.equal(kindOf("delivery_note").rendering.reason, null);

  // And the annexes stay where they were.
  for (const kind of ["order_summary", "calculation_sheet", "deposit_request",
    "internal_tracking_sheet", "missing_information_list"]) {
    assert.equal(kindOf(kind).rendering.available, false, kind);
    assert.match(kindOf(kind).rendering.reason, /n'a pas encore de rendu/, kind);
  }

  assert.equal(kindOf("quote").rendering.available, true);
});

test("a rendered delivery note is a delivery note, and carries no amount", async (t) => {
  const { inject, documentOutputDir } = await createApi(t);
  const result = await render(inject, "delivery_note");
  const body = JSON.parse(result.body);

  assert.equal(result.statusCode, 201);
  assert.equal(body.deliverable.kind, "delivery_note");
  assert.equal(body.document.documentType, "delivery_note");
  assert.equal(body.document.deliveryNoteProfile, "goods_only");
  assert.match(body.files.pdf.name, /^bon_livraison_HKIDS_/);

  // The delivery note keeps the three pages of its own template, where the
  // invoice keeps one: the file is drawn with the delivery note layout.
  const pdf = await PDFDocument.load(await readFile(resolve(documentOutputDir, body.files.pdf.name)));
  assert.equal(pdf.getPageCount(), 1);

  // Nothing priced travelled to the document the API answered with.
  const serialised = JSON.stringify(body.document);
  assert.equal(serialised.includes("totals"), false);
  assert.equal(serialised.includes("payment"), false);
  assert.equal(serialised.includes("59658"), false);
});

test("a rendered invoice is an invoice, not a quote wearing its name", async (t) => {
  const { inject, documentOutputDir } = await createApi(t);
  const body = JSON.parse((await render(inject, "invoice")).body);

  assert.equal(body.deliverable.kind, "invoice");
  assert.equal(body.document.documentType, "invoice");
  assert.match(body.files.pdf.name, /^facture_HKIDS_/);

  // The proof is the document itself: its title names what it is, whatever the
  // file is called.
  const invoicePdf = await PDFDocument.load(
    await readFile(resolve(documentOutputDir, body.files.pdf.name))
  );
  assert.match(invoicePdf.getTitle(), /Facture/);
  assert.equal(invoicePdf.getPageCount(), 1);

  const quote = JSON.parse((await render(inject, "quote")).body);
  const quotePdf = await PDFDocument.load(
    await readFile(resolve(documentOutputDir, quote.files.pdf.name))
  );
  assert.equal(Math.round(quotePdf.getPage(0).getWidth() * 100), 59528);
  assert.notEqual(body.files.pdf.checksum, quote.files.pdf.checksum);
  assert.notEqual(body.files.docx.checksum, quote.files.docx.checksum);
});

// --- refusals ------------------------------------------------------------------

test("an unknown deliverable is refused", async (t) => {
  const { inject } = await createApi(t);
  const result = await render(inject, "purchase_order");
  const body = JSON.parse(result.body);

  assert.equal(result.statusCode, 400);
  assert.equal(body.details.code, "DELIVERABLE_UNKNOWN");
});

test("a deliverable that has no renderer is refused with its reason", async (t) => {
  const { inject } = await createApi(t);

  for (const [deliverable, pattern] of [
    ["calculation_sheet", /n'a pas encore de rendu/]
  ]) {
    const result = await render(inject, deliverable);
    const body = JSON.parse(result.body);
    assert.equal(result.statusCode, 409, deliverable);
    assert.equal(body.details.code, "DELIVERABLE_NOT_RENDERABLE", deliverable);
    assert.match(body.error, pattern, deliverable);
  }
});

test("an unapproved payment plan cannot get in through the API", async (t) => {
  const { inject } = await createApi(t);
  const result = await preview(inject, {
    ...FILE_INPUT,
    paymentScheduleRuleId: null,
    paymentScheduleParts: [
      { percent: 70, condition: "à la commande" },
      { percent: 30, condition: "avant livraison" }
    ]
  });

  assert.equal(result.statusCode >= 400, true);
  assert.match(result.body, /SCHEDULE_PLAN_NOT_SUPPORTED/);
});

test("a file with no line is refused", async (t) => {
  const { inject } = await createApi(t);
  const result = await preview(inject, { ...FILE_INPUT, items: [] });

  assert.equal(result.statusCode >= 400, true);
  assert.match(result.body, /BUNDLE_ITEMS_REQUIRED/);
});

// --- authentication and permissions --------------------------------------------

test("an anonymous caller reaches neither route", async (t) => {
  const app = buildApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  for (const url of ["/api/commercial-files/preview", "/api/commercial-files/render"]) {
    const response = await app.inject({ method: "POST", url, payload: FILE_INPUT });
    assert.equal(response.statusCode, 401, url);
    assert.equal(JSON.parse(response.body).details.code, "AUTHENTICATION_REQUIRED", url);
  }
});

test("a role that cannot create requests is refused", async (t) => {
  const { app, repository } = await createApi(t);
  const viewer = await createAuthenticatedUser(repository, { id: "test-viewer", role: "viewer" });

  for (const url of ["/api/commercial-files/preview", "/api/commercial-files/render"]) {
    const response = await app.inject({ method: "POST", url, headers: viewer.headers, payload: FILE_INPUT });
    assert.equal(response.statusCode, 403, url);
  }
});
