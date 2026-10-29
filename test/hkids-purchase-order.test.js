import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  DocumentValidationError,
  HKIDS_LOGO_PATH,
  InMemoryRepository,
  computeInstalments,
  nextPurchaseOrderNumber,
  purchaseOrderPaymentPlan,
  validateAndPrepareDocument
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// Invented client, as in every committed fixture.
const ORDER = Object.freeze({
  documentType: "purchase_order",
  documentNumber: "164",
  date: "30/10/2026",
  object: "Lit maisonnette mezzanine",
  client: { name: "MADAME EXEMPLE", address: "12 rue Exemple, Ville Exemple" },
  items: [
    { designation: "Lit maisonnette mezzanine", quantity: 1, unitPriceHt: 15000, amountHt: 15000 },
    { designation: "Frais de livraison", quantity: 1, unitPriceHt: 1250, amountHt: 1250 }
  ],
  totals: { totalHt: 16250, tva: 3250, totalTtc: 19500 },
  specifications: ["Escalier à droite, avec tiroirs intégrés.", "Coloris : blanc et rose."],
  payment: { termsRule: "hkids-po-50-50" }
});

async function createApi(t) {
  const repository = new InMemoryRepository();
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-purchase-orders-"));
  const { app, inject } = await buildAuthenticatedApi({ repository, documentOutputDir: outputDir });
  t.after(async () => {
    await app.close();
    await rm(outputDir, { recursive: true, force: true });
  });
  return { inject, outputDir };
}

async function previewAndGenerate(inject, payload) {
  const preview = JSON.parse((await inject({ method: "POST", url: "/api/documents/preview", payload })).body);
  return inject({
    method: "POST",
    url: "/api/documents/generate",
    payload: { ...payload, userConfirmation: true, previewToken: preview.previewToken }
  });
}

test("a purchase order validates without a payment method and computes its instalments", () => {
  const document = validateAndPrepareDocument(ORDER);

  assert.equal(document.totals.totalTtc, 19500);
  assert.equal(document.payment.terms, "50 % d'avance à la commande ; 50 % à la livraison.");
  assert.deepEqual(document.payment.instalments.map((part) => part.amount), [9750, 9750]);
  assert.deepEqual([...document.specifications], ORDER.specifications);
});

test("instalments always add up to the total, to the cent", () => {
  const amounts = computeInstalments(purchaseOrderPaymentPlan("hkids-60-20-20-2026"), 1000.01).map((part) => part.amount);
  assert.deepEqual(amounts, [600.01, 200, 200]);
  assert.equal(Math.round(amounts.reduce((sum, amount) => sum + amount, 0) * 100), 100001);
});

test("a purchase order refuses free-text terms, a missing client address and a bad image", () => {
  const cases = [
    [{ payment: { terms: "50 % / 50 %" } }, "payment.termsRule", "UNKNOWN_PAYMENT_TERMS_RULE"],
    [{ client: { name: "MADAME EXEMPLE", address: "" } }, "client.address", "REQUIRED_FIELD_MISSING"],
    [{ referenceImage: "data:image/gif;base64,R0lGOD" }, "referenceImage", "INVALID_REFERENCE_IMAGE"]
  ];
  for (const [patch, field, code] of cases) {
    assert.throws(() => validateAndPrepareDocument({ ...ORDER, ...patch }), (error) => {
      assert.ok(error instanceof DocumentValidationError);
      assert.ok(error.errors.some((entry) => entry.field === field && entry.code === code), `${field} ${code}`);
      return true;
    });
  }
});

test("the purchase order series continues after the orders issued by hand", () => {
  assert.equal(nextPurchaseOrderNumber(), "164");
  assert.equal(nextPurchaseOrderNumber(["164", "165"]), "166");
});

test("a purchase order is generated without a template, with its reference visual on page 2", async (t) => {
  const { inject, outputDir } = await createApi(t);
  const logo = await readFile(HKIDS_LOGO_PATH);
  const payload = { ...ORDER, referenceImage: `data:image/jpeg;base64,${logo.toString("base64")}` };

  const next = JSON.parse((await inject({ method: "GET", url: "/api/documents/purchase-orders/next-number" })).body);
  assert.equal(next.documentNumber, "164");

  const generated = await previewAndGenerate(inject, payload);
  const body = JSON.parse(generated.body);
  assert.equal(generated.statusCode, 201, generated.body);
  assert.equal(body.template.id, "hkids-purchase-order-builtin");
  assert.match(body.files.pdf.name, /^bon_commande_HKIDS_164_/);

  const pdf = await inject({ method: "GET", url: body.files.pdf.downloadUrl });
  assert.equal((await PDFDocument.load(pdf.rawPayload)).getPageCount(), 2);
  const docx = await inject({ method: "GET", url: body.files.docx.downloadUrl });
  assert.equal(docx.statusCode, 200);
  assert.ok((await readdir(outputDir)).some((name) => name.endsWith(".docx")));

  const after = JSON.parse((await inject({ method: "GET", url: "/api/documents/purchase-orders/next-number" })).body);
  assert.equal(after.documentNumber, "165");
});

test("a purchase order number already issued is refused with the next free one", async (t) => {
  const { inject } = await createApi(t);

  const byHand = await inject({ method: "POST", url: "/api/documents/preview", payload: { ...ORDER, documentNumber: "163" } });
  assert.equal(byHand.statusCode, 409);
  assert.equal(JSON.parse(byHand.body).details.code, "PURCHASE_ORDER_NUMBER_USED");
  assert.equal(JSON.parse(byHand.body).details.nextNumber, "164");

  assert.equal((await previewAndGenerate(inject, ORDER)).statusCode, 201);
  const again = await inject({ method: "POST", url: "/api/documents/preview", payload: ORDER });
  assert.equal(again.statusCode, 409);
  assert.equal(JSON.parse(again.body).details.nextNumber, "165");
});
