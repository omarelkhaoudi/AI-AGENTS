import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  DocumentValidationError,
  HKIDS_ACTIVE_PAYMENT_TERMS,
  HKIDS_FIXED_IDENTITY,
  HKIDS_TEMPLATE_VARIABLES,
  assertHkidsTemplateAvailable,
  checksumFile,
  formatMoney,
  renderHkidsPdf,
  resolveDocumentFontPath,
  templateLockFor,
  validateAndPrepareDocument
} from "../src/index.js";
import { useSyntheticHkidsTemplates } from "../test-support/hkids-templates.js";

// The client is invented. A fixture is committed, read by anyone who clones the
// repository and kept for the life of the project, so it must never carry the
// name or the address of a real customer.
const INVOICE = Object.freeze({
  documentType: "invoice",
  documentNumber: "165",
  date: "05/09/2026",
  object: "Vente de mobilier",
  deliveryNoteReference: "98",
  client: { name: "MADAME DUPONT", address: "Ville Exemple" },
  items: [
    { designation: "Canapé", unit: "U", quantity: 1, unitPriceHt: 4500, amountHt: 4500, tva: 900, unitPriceTtc: 5400, totalTtc: 5400 },
    { designation: "Matelas", unit: "U", quantity: 1, unitPriceHt: 1500, amountHt: 1500, tva: 300, unitPriceTtc: 1800, totalTtc: 1800 },
    { designation: "Tour de lit", unit: "U", quantity: 1, unitPriceHt: 1300, amountHt: 1300, tva: 260, unitPriceTtc: 1560, totalTtc: 1560 }
  ],
  totals: { totalHt: 7300, tva: 1460, totalTtc: 8760 },
  payment: { method: "virement bancaire", termsRule: HKIDS_ACTIVE_PAYMENT_TERMS.id },
  note: "Référence règlement propriété totalité à é è ê ç"
});

const DELIVERY_NOTE = Object.freeze({
  ...INVOICE,
  documentType: "delivery_note",
  object: "",
  reference: "Commande validée",
  deliveryNoteReference: ""
});

// --- the template is configuration, not repository content ------------------

test("a configured template is accepted, and its identity is reported", async (t) => {
  const { paths } = await useSyntheticHkidsTemplates(t);

  const delivery = await assertHkidsTemplateAvailable("delivery_note");
  const invoice = await assertHkidsTemplateAvailable("invoice");

  assert.equal(delivery.path, paths.delivery_note);
  assert.equal(invoice.path, paths.invoice);
  assert.equal(delivery.expectedPageCount, 3);
  assert.equal(invoice.expectedPageCount, 2);
  assert.equal(delivery.locked, false, "no checksum configured means no lock, and it says so");
  assert.equal(delivery.expectedChecksum, null);
});

// The lock did not disappear with the templates: it became opt-in. A company
// that names its digest gets exactly the old guarantee.
test("a configured checksum locks the template, and a changed byte is refused", async (t) => {
  const { paths } = await useSyntheticHkidsTemplates(t, { lock: true });

  const locked = await assertHkidsTemplateAvailable("invoice");
  assert.equal(locked.locked, true);
  assert.equal(locked.checksum, locked.expectedChecksum);
  assert.equal(locked.checksum, await checksumFile(paths.invoice));

  process.env[HKIDS_TEMPLATE_VARIABLES.invoice.checksum] = "0".repeat(64);
  await assert.rejects(
    () => assertHkidsTemplateAvailable("invoice"),
    (error) => {
      assert.equal(error.code, "HKIDS_TEMPLATE_CHECKSUM_MISMATCH");
      assert.equal(error.details.templateId, "hkids-invoice-reference");
      return true;
    }
  );
});

// A fresh clone has no template at all. The refusal must name the variable to
// set, because "missing" is the normal first answer, not an exceptional one.
test("a missing template names the variable to set", async (t) => {
  const restore = process.env[HKIDS_TEMPLATE_VARIABLES.invoice.path];
  process.env[HKIDS_TEMPLATE_VARIABLES.invoice.path] = join("nowhere", "aucun-gabarit.pdf");
  t.after(() => {
    if (restore === undefined) {
      delete process.env[HKIDS_TEMPLATE_VARIABLES.invoice.path];
    } else {
      process.env[HKIDS_TEMPLATE_VARIABLES.invoice.path] = restore;
    }
  });

  await assert.rejects(
    () => assertHkidsTemplateAvailable("invoice"),
    (error) => {
      assert.equal(error.code, "HKIDS_TEMPLATE_MISSING");
      assert.equal(error.details.pathVariable, "HKIDS_INVOICE_TEMPLATE_PATH");
      assert.match(error.message, /HKIDS_INVOICE_TEMPLATE_PATH/);
      return true;
    }
  );
});

test("the fixed H-KIDS identity is the one the renderers draw", () => {
  assert.equal(HKIDS_FIXED_IDENTITY.companyName, "H KIDS");
  assert.ok(HKIDS_FIXED_IDENTITY.legalLine.includes("ICE:002635757000066"));
  assert.deepEqual([...HKIDS_FIXED_IDENTITY.deliveryNoteColumns], ["Image", "Désignation", "Qté", "Pu HT", "Total HT"]);
  assert.deepEqual([...HKIDS_FIXED_IDENTITY.invoiceColumns], ["Désignation", "Qté", "Unité", "Pu Brut", "TVA", "Pu TTC", "Total HT", "Total TTC"]);
  assert.equal(HKIDS_FIXED_IDENTITY.invoiceColumns.includes("Image"), false);
  assert.equal(HKIDS_FIXED_IDENTITY.footerMention, "Les produits H KIDS deviennent la propriété du client uniquement après le règlement intégral de la facture.");
  assert.equal(templateLockFor("invoice", {}).id, "hkids-invoice-reference");
});

// --- validation -------------------------------------------------------------

test("document validation computes the reference invoice totals exactly", () => {
  const prepared = validateAndPrepareDocument(INVOICE);

  assert.deepEqual(prepared.items.map((item) => item.amountHt), [4500, 1500, 1300]);
  assert.deepEqual(prepared.items.map((item) => item.tva), [900, 300, 260]);
  assert.deepEqual(prepared.items.map((item) => item.unitPriceTtc), [5400, 1800, 1560]);
  assert.equal(prepared.totals.totalHt, 7300);
  assert.equal(prepared.totals.tva, 1460);
  assert.equal(prepared.totals.totalTtc, 8760);
  assert.equal(prepared.object, "Vente de mobilier");
  assert.equal(prepared.payment.method, "virement bancaire");
  assert.equal(prepared.payment.terms, "60 % à la commande ; 20 % avant livraison ; 20 % après installation.");
});

test("invoice money formatting keeps two decimals", () => {
  assert.equal(formatMoney(4500), "4 500,00 DH");
  assert.equal(formatMoney(1500), "1 500,00 DH");
  assert.equal(formatMoney(1300), "1 300,00 DH");
  assert.equal(formatMoney(7300), "7 300,00 DH");
  assert.equal(formatMoney(1460), "1 460,00 DH");
  assert.equal(formatMoney(8760), "8 760,00 DH");
});

test("document validation blocks missing, placeholder and invented-looking fields", () => {
  for (const [patch, field, code] of [
    [{ documentNumber: "" }, "documentNumber", "REQUIRED_FIELD_MISSING"],
    [{ date: "" }, "date", "REQUIRED_FIELD_MISSING"],
    [{ client: { name: "", address: "Ville Exemple" } }, "client.name", "REQUIRED_FIELD_MISSING"],
    [{ client: { name: "MADAME DUPONT", address: "" } }, "client.address", "REQUIRED_FIELD_MISSING"],
    [{ object: "Facturation" }, "object", "INVALID_DOCUMENT_OBJECT"],
    [{ items: [{ designation: "Canapé", quantity: 1, unitPriceHt: 4500, amountHt: 4500 }] }, "items.0.unit", "REQUIRED_FIELD_MISSING"],
    [{ client: { name: "MADAME ?", address: "Ville Exemple" } }, "client.name", "FORBIDDEN_PLACEHOLDER"],
    [{ client: { name: "MADAME DUPONT", address: "À compléter" } }, "client.address", "FORBIDDEN_PLACEHOLDER"]
  ]) {
    assert.throws(
      () => validateAndPrepareDocument({ ...INVOICE, ...patch }),
      (error) => hasValidation(error, field, code)
    );
  }
});

test("document validation blocks wrong line and total calculations", () => {
  assert.throws(
    () => validateAndPrepareDocument({
      ...INVOICE,
      items: [{ designation: "Canapé", unit: "U", quantity: 2, unitPriceHt: 4500, amountHt: 4500 }],
      totals: { totalHt: 4500, tva: 900, totalTtc: 5400 }
    }),
    (error) => hasValidation(error, "items.0.amountHt", "LINE_AMOUNT_MISMATCH")
  );

  assert.throws(
    () => validateAndPrepareDocument({ ...INVOICE, totals: { totalHt: 7300, tva: 1000, totalTtc: 8300 } }),
    (error) => hasValidation(error, "totals.tva", "TOTAL_MISMATCH")
  );
});

test("old 50/50 payment terms are refused and not reused automatically", () => {
  assert.throws(
    () => validateAndPrepareDocument({
      ...INVOICE,
      payment: { method: "virement", terms: "50% avance 50 % à la livraison avant le montage" }
    }),
    (error) => hasValidation(error, "payment.terms", "OLD_PAYMENT_TERMS_FORBIDDEN")
  );
});

// --- fonts ------------------------------------------------------------------

// The renderer embeds a real .ttf, so the path has to exist on the machine doing
// the rendering. A path someone configured is honoured or refused by name; it is
// never quietly replaced by a probed one.
test("a configured font path is honoured, and a missing one is refused by name", async () => {
  assert.equal(await resolveDocumentFontPath("regular", "package.json"), "package.json");

  await assert.rejects(
    () => resolveDocumentFontPath("bold", "/nowhere/this-font-does-not-exist.ttf"),
    (error) => {
      assert.equal(error.name, "DocumentFontError");
      assert.equal(error.code, "DOCUMENT_FONT_NOT_READABLE");
      assert.equal(error.details.variable, "HKIDS_DOCUMENT_BOLD_FONT_PATH");
      assert.match(error.message, /HKIDS_DOCUMENT_BOLD_FONT_PATH/);
      return true;
    }
  );
});

test("an unconfigured font resolves to a file that exists on this machine", async () => {
  for (const variant of ["regular", "bold"]) {
    const resolved = await resolveDocumentFontPath(variant, null);
    await access(resolved, constants.R_OK);
    assert.match(resolved, /\.ttf$/i, variant);
  }
});

// --- rendering --------------------------------------------------------------

test("PDF renderer keeps official page counts and Unicode-capable generated text", async (t) => {
  await useSyntheticHkidsTemplates(t);

  const invoice = validateAndPrepareDocument(INVOICE);
  const invoicePdf = await PDFDocument.load(await renderHkidsPdf(invoice));
  assert.equal(invoicePdf.getPageCount(), 1);

  const delivery = validateAndPrepareDocument(DELIVERY_NOTE);
  const deliveryPdf = await PDFDocument.load(await renderHkidsPdf(delivery));
  assert.equal(deliveryPdf.getPageCount(), 3);

  const renderedBytes = await renderHkidsPdf(invoice);
  assert.equal(Buffer.from(renderedBytes).includes(Buffer.from("/ToUnicode")), true);

  for (const expected of ["Canapé", "Référence", "règlement", "propriété", "totalité", "à", "é", "è", "ê", "ç"]) {
    assert.equal(JSON.stringify(invoice).includes(expected), true, expected);
  }
  assert.equal(JSON.stringify(invoice).includes("?"), false);
});

// A template of the wrong shape is a configuration mistake, and the renderer
// says so instead of producing a document with pages missing.
test("a template with the wrong page count is refused", async (t) => {
  const { paths } = await useSyntheticHkidsTemplates(t);
  const wrongShape = await PDFDocument.create();
  wrongShape.addPage([595.56, 842.04]);
  await writeFile(paths.invoice, Buffer.from(await wrongShape.save({ useObjectStreams: false })));

  await assert.rejects(
    () => renderHkidsPdf(validateAndPrepareDocument(INVOICE)),
    /must contain 2 pages/
  );
});

function hasValidation(error, field, code) {
  assert.ok(error instanceof DocumentValidationError);
  assert.ok(error.errors.some((entry) => entry.field === field && entry.code === code), `${field} ${code}`);
  return true;
}
