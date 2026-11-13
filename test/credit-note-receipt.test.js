import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { dirhamsInWords } from "../src/documents/amount-in-words.js";

// Credit notes and payment receipts: a credit note gives back part of an
// invoice the cockpit issued, a receipt records what the client paid on a sale.
// Neither may go past what it settles. Invented clients and figures only.

async function service(t) {
  const dir = await mkdtemp(join(tmpdir(), "hkids-settle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, documents: new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: dir }) };
}

const client = { name: "Client Exemple", address: "Marrakech" };

function quote() {
  return {
    documentType: "quote",
    documentNumber: "170",
    date: "02/11/2026",
    object: "Lit cabane",
    client,
    items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: 3750, amountHt: 3750 }],
    totals: { totalHt: 3750, tva: 750, totalTtc: 4500 },
    payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
  };
}

function priced(ttc) {
  const ht = Math.round((ttc / 1.2) * 100) / 100;
  return { ht, tva: Math.round((ttc - ht) * 100) / 100 };
}

function invoice(number, ttc) {
  const { ht, tva } = priced(ttc);
  return {
    documentType: "invoice",
    documentNumber: number,
    date: "04/11/2026",
    object: "Vente de mobilier",
    client,
    quoteReference: "170",
    items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: ht, amountHt: ht }],
    totals: { totalHt: ht, tva, totalTtc: ttc },
    payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
  };
}

function creditNote(number, ttc, overrides = {}) {
  const { ht, tva } = priced(ttc);
  return {
    documentType: "credit_note",
    documentNumber: number,
    date: "06/11/2026",
    object: "Remise commerciale",
    client,
    invoiceReference: "180",
    items: [{ designation: "Geste commercial sur la facture n° 180", unit: "U", quantity: 1, unitPriceHt: ht, amountHt: ht }],
    totals: { totalHt: ht, tva, totalTtc: ttc },
    payment: { method: "déduit du reste à payer" },
    ...overrides
  };
}

function receipt(number, amount, overrides = {}) {
  return {
    documentType: "payment_receipt",
    documentNumber: number,
    date: "05/11/2026",
    object: "Acompte",
    client,
    quoteReference: "170",
    items: [{ designation: "Acompte sur le devis n° 170", quantity: 1, unitPriceHt: amount, amountHt: amount }],
    totals: { totalHt: amount, tva: 0, totalTtc: amount },
    payment: { method: "chèque" },
    ...overrides
  };
}

async function issue(documents, input, options = {}) {
  const preview = await documents.preview(input, options);
  await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true }, options);
  return preview;
}

test("amounts are written out in French as a Moroccan receipt states them", () => {
  assert.equal(dirhamsInWords(4500), "quatre mille cinq cents dirhams");
  assert.equal(dirhamsInWords(1), "un dirham");
  assert.equal(dirhamsInWords(80), "quatre-vingts dirhams");
  assert.equal(dirhamsInWords(81), "quatre-vingt-un dirhams");
  assert.equal(dirhamsInWords(71), "soixante et onze dirhams");
  assert.equal(dirhamsInWords(200000), "deux cent mille dirhams");
  assert.equal(dirhamsInWords(1250.5), "mille deux cent cinquante dirhams et cinquante centimes");
  assert.equal(dirhamsInWords(2000000), "deux millions de dirhams");
});

test("receipts add up what the client paid, and never go past the sale", async (t) => {
  const { dir, documents } = await service(t);
  await issue(documents, quote());

  const first = await issue(documents, receipt("1", 2700));
  assert.match(first.notices[0], /Vente de 4\s500,00 DH TTC \(selon le devis\) : déjà reçu 0,00 DH ; après ce reçu, reste à payer 1\s800,00 DH\./);

  await assert.rejects(issue(documents, receipt("2", 2000)), { code: "RECEIPT_EXCEEDS_SALE" });

  await issue(documents, receipt("2", 1800, { payment: { method: "espèces" } }));
  const dossier = await documents.dossier("quote", "170");
  assert.equal(dossier.received, 4500);
  assert.equal(dossier.remainingToPay, 0);
  assert.equal(dossier.stage, "payé en totalité");
  assert.deepEqual(dossier.receipts.map((entry) => entry.number), ["1", "2"]);

  const files = (await readdir(dir)).filter((name) => name.startsWith("recu_")).sort();
  assert.deepEqual(files.filter((name) => name.endsWith(".pdf")).length, 2);
  assert.ok(files.some((name) => name.endsWith(".docx")));
});

test("a receipt carries no tax, names a method from the list and what it settles", async (t) => {
  const { documents } = await service(t);
  await issue(documents, quote());
  await assert.rejects(documents.preview(receipt("1", 1000, { payment: { method: "bitcoin" } })), (error) => {
    assert.ok(error.errors.some((entry) => entry.code === "UNKNOWN_PAYMENT_METHOD"));
    return true;
  });
  await assert.rejects(documents.preview(receipt("1", 1000, { quoteReference: "" })), (error) => {
    assert.ok(error.errors.some((entry) => entry.code === "UPSTREAM_REFERENCE_MISSING"));
    return true;
  });
  const preview = await documents.preview(receipt("1", 1000, { tvaRate: 0.2 }));
  assert.equal(preview.document.totals.tva, 0);
  assert.equal(preview.document.totals.totalTtc, 1000);
});

test("a credit note lowers what is invoiced and frees the room to invoice again", async (t) => {
  const { documents } = await service(t);
  await issue(documents, quote());
  await issue(documents, invoice("180", 4500));
  await assert.rejects(issue(documents, invoice("181", 600)), { code: "INVOICE_EXCEEDS_SALE" });

  const preview = await issue(documents, creditNote("1", 600));
  assert.match(preview.notices[0], /^Avoir sur la facture n° 180 \(4\s500,00 DH TTC, du 04\/11\/2026\)\.$/);

  const dossier = await documents.dossier("quote", "170");
  assert.equal(dossier.invoicedGross, 4500);
  assert.equal(dossier.credited, 600);
  assert.equal(dossier.invoiced, 3900);
  assert.equal(dossier.remaining, 600);
  assert.deepEqual(dossier.creditNotes.map((entry) => entry.number), ["1"]);

  // The credit note reaches the sale through its invoice.
  assert.equal((await documents.dossier("credit_note", "1")).quoteNumber, "170");
});

test("credit notes never give back more than their invoice, which must exist", async (t) => {
  const { documents } = await service(t);
  await issue(documents, quote());
  await assert.rejects(documents.preview(creditNote("1", 500)), { code: "CREDITED_INVOICE_NOT_FOUND" });

  await issue(documents, invoice("180", 4500));
  await issue(documents, creditNote("1", 4000));
  await assert.rejects(issue(documents, creditNote("2", 600)), (error) => {
    assert.equal(error.code, "CREDIT_NOTE_EXCEEDS_INVOICE");
    assert.equal(error.details.creditableBefore, 500);
    return true;
  });
  const second = await issue(documents, creditNote("2", 500));
  assert.match(second.notices[0], /déjà 4\s000,00 DH en avoir \(n° 1\) ; reste possible avant celui-ci : 500,00 DH\./);

  // A correction of an existing credit note replaces it rather than adding to it.
  await issue(documents, creditNote("2", 300), { replaceExisting: true });
  assert.equal((await documents.dossier("quote", "170")).credited, 4300);
});

test("a credit note must name its invoice and say how the amount is settled", async (t) => {
  const { documents } = await service(t);
  await assert.rejects(documents.preview(creditNote("1", 100, { invoiceReference: "" })), (error) => {
    assert.ok(error.errors.some((entry) => entry.code === "UPSTREAM_REFERENCE_MISSING"));
    return true;
  });
  await assert.rejects(documents.preview(creditNote("1", 100, { payment: { method: "chèque", terms: "30 jours" } })), (error) => {
    const codes = error.errors.map((entry) => entry.code);
    assert.ok(codes.includes("UNKNOWN_PAYMENT_METHOD"));
    assert.ok(codes.includes("TERMS_NOT_ALLOWED"));
    return true;
  });
});
