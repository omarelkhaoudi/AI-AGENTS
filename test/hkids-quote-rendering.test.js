import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync, inflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import {
  NOT_PROVIDED_TEXT,
  QuotePresentationError,
  calculateDocumentTotals,
  createDocumentBundle,
  createDocumentNumberingService,
  createInMemoryDocumentRegister,
  createQuotePresentation,
  formatMoney,
  renderHkidsDocx,
  renderQuotePdf
} from "../src/index.js";

/**
 * The quote, rendered as a PDF and as an editable Word file.
 *
 * Both are produced from one presentation, so the two documents state the same
 * thing by construction. These tests read the produced files back and compare
 * what they say against the figures the calculation and payment modules
 * produced — not against numbers written here.
 *
 * The client is invented. A committed fixture is read by whoever clones the
 * repository.
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

function commercialFile(overrides = {}) {
  return createDocumentBundle({
    client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
    items: OFFICIAL_CASE_ITEMS,
    discount: OFFICIAL_DISCOUNT,
    paymentScheduleRuleId: "hkids-60-20-20-2026",
    paymentMethod: "virement bancaire",
    dates: { quoteDate: "06/09/2026" },
    ...overrides
  });
}

function numberedFile(overrides = {}) {
  const register = createInMemoryDocumentRegister({ sequences: { quote: 9001, invoice: 9001, delivery_note: 9001 } });
  return commercialFile({ numbering: createDocumentNumberingService({ register }), ...overrides });
}

// --- reading the produced files back ----------------------------------------

function inflateIfNeeded(stream) {
  let data = Buffer.from(stream.getContents());
  if (String(stream.dict.get(PDFName.of("Filter"))) === "/FlateDecode") {
    try {
      data = inflateSync(data);
    } catch {
      return "";
    }
  }
  return data.toString("latin1");
}

// The renderer embeds a subset font, so the page writes hex strings that only
// the font's ToUnicode map can turn back into words.
function parseToUnicode(text) {
  const map = new Map();
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1], 16), String.fromCharCode(parseInt(pair[2].slice(0, 4), 16)));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const row of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(row[1], 16);
      const hi = parseInt(row[2], 16);
      const start = parseInt(row[3].slice(0, 4), 16);
      for (let code = lo; code <= hi && code - lo < 512; code += 1) {
        map.set(code, String.fromCharCode(start + (code - lo)));
      }
    }
  }
  return map;
}

// The page uses two subset fonts, regular and bold. Each carries its own
// ToUnicode map, and the same code means a different character in each — so the
// maps are kept apart and the run is decoded with the font selected by the Tf
// operator that precedes it. Merging them produces convincing nonsense.
function pageFontMaps(context, page) {
  const maps = new Map();
  const resources = context.lookup(page.node.get(PDFName.of("Resources")));
  const fonts = resources ? context.lookup(resources.get(PDFName.of("Font"))) : null;
  if (!fonts) {
    return maps;
  }

  for (const [name, ref] of fonts.entries()) {
    const font = context.lookup(ref);
    const toUnicode = context.lookup(font?.get(PDFName.of("ToUnicode")));
    if (toUnicode instanceof PDFRawStream) {
      maps.set(String(name).replace(/^\//, ""), parseToUnicode(inflateIfNeeded(toUnicode)));
    }
  }
  return maps;
}

async function pdfText(bytes) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const context = pdf.context;

  let out = "";
  for (const page of pdf.getPages()) {
    const maps = pageFontMaps(context, page);
    const contents = context.lookup(page.node.get(PDFName.of("Contents")));
    const streams = contents && contents.asArray ? contents.asArray().map((ref) => context.lookup(ref)) : [contents];
    let raw = "";
    for (const stream of streams) {
      if (stream instanceof PDFRawStream) raw += inflateIfNeeded(stream);
    }

    let current = null;
    for (const token of raw.matchAll(/\/([^\s/]+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f\s]{4,})>/g)) {
      if (token[1] !== undefined) {
        current = maps.get(token[1]) ?? null;
        continue;
      }
      const hex = token[2].replace(/\s+/g, "");
      for (let i = 0; i + 4 <= hex.length; i += 4) {
        out += current?.get(parseInt(hex.slice(i, i + 4), 16)) ?? "";
      }
      out += "\n";
    }
  }
  return out;
}

// The four bytes that begin a zip entry. "PK" alone also matches the central
// directory at the end of the file, and walking from there reads garbage.
const LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function docxText(bytes) {
  const buffer = Buffer.from(bytes);
  let offset = 0;
  let xml = "";
  while ((offset = buffer.indexOf(LOCAL_FILE_HEADER, offset)) !== -1) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.slice(offset + 30, offset + 30 + nameLength).toString("latin1");
    const start = offset + 30 + nameLength + extraLength;
    if (name === "word/document.xml") {
      const data = buffer.slice(start, start + compressed);
      xml = method === 8 ? inflateRawSync(data).toString("utf8") : data.toString("utf8");
    }
    offset = start + (compressed || 1);
  }
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
    .map((match) => match[1].replace(/&apos;/g, "'").replace(/&amp;/g, "&"))
    .join("\n");
}

function docxEntries(bytes) {
  const buffer = Buffer.from(bytes);
  const names = [];
  let offset = 0;
  while ((offset = buffer.indexOf(LOCAL_FILE_HEADER, offset)) !== -1) {
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    names.push(buffer.slice(offset + 30, offset + 30 + nameLength).toString("latin1"));
    offset = offset + 30 + nameLength + extraLength + (compressed || 1);
  }
  return names;
}

// --- generation --------------------------------------------------------------

test("a quote renders to a real PDF", async () => {
  const bytes = await renderQuotePdf(numberedFile().documents.quote);
  const pdf = await PDFDocument.load(bytes);

  assert.ok(bytes.length > 5000, "a rendered quote is not an empty file");
  assert.equal(pdf.getPageCount(), 1);
  // Unicode-capable text, so accents survive the round trip.
  assert.equal(bytes.includes(Buffer.from("/ToUnicode")), true);

  const size = pdf.getPages()[0].getSize();
  assert.ok(Math.abs(size.width - 595.28) < 1 && Math.abs(size.height - 841.89) < 1, "A4");
});

test("a quote renders to a real editable Word file", async () => {
  const bytes = await renderHkidsDocx(numberedFile().documents.quote);
  const entries = docxEntries(bytes);

  assert.ok(bytes.length > 5000);
  for (const entry of ["[Content_Types].xml", "word/document.xml", "word/styles.xml"]) {
    assert.ok(entries.includes(entry), entry);
  }
  // Text runs, not an image of a document: this is what makes it editable.
  assert.ok(docxText(bytes).includes("MADAME EXEMPLE"));
});

// --- what the documents say --------------------------------------------------

test("both files state the amounts the calculation module produced", async () => {
  const file = numberedFile();
  const quote = file.documents.quote;
  const expected = calculateDocumentTotals(OFFICIAL_CASE_ITEMS, 0.2, { discount: OFFICIAL_DISCOUNT });

  // The bundle and a direct calculation agree, so what follows is checked
  // against the module rather than against figures written in this file.
  assert.deepEqual(quote.totals, expected.totals);

  const pdf = await pdfText(await renderQuotePdf(quote));
  const docx = docxText(await renderHkidsDocx(quote));

  for (const amount of [
    expected.totals.totalBrutHt,
    expected.totals.totalDiscount,
    expected.totals.totalHt,
    expected.totals.tva,
    expected.totals.totalTtc
  ]) {
    assert.ok(pdf.includes(formatMoney(amount)), `PDF must state ${formatMoney(amount)}`);
    assert.ok(docx.includes(formatMoney(amount)), `DOCX must state ${formatMoney(amount)}`);
  }
});

test("VAT is stated at 20 % and its amount is the module's", async () => {
  const file = numberedFile();
  const quote = file.documents.quote;

  assert.equal(quote.totals.tvaRate, 0.2);
  const view = createQuotePresentation(quote);
  const vatRow = view.totalRows.find((row) => row[0].startsWith("TVA"));
  assert.deepEqual(vatRow, ["TVA 20 %", formatMoney(quote.totals.tva)]);

  const pdf = await pdfText(await renderQuotePdf(quote));
  const docx = docxText(await renderHkidsDocx(quote));
  assert.ok(pdf.includes("TVA 20 %"));
  assert.ok(docx.includes("TVA 20 %"));
});

test("the payment plan on the documents is the approved one", async () => {
  for (const ruleId of ["hkids-60-20-20-2026", "hkids-50-30-20-exception", "hkids-40-40-20-exception", "hkids-100-exception"]) {
    const file = numberedFile({ paymentScheduleRuleId: ruleId });
    const quote = file.documents.quote;
    const pdf = await pdfText(await renderQuotePdf(quote));
    const docx = docxText(await renderHkidsDocx(quote));

    for (const installment of file.schedule.installments) {
      const amount = formatMoney(installment.amountTtc);
      assert.ok(pdf.includes(amount), `${ruleId} PDF ${amount}`);
      assert.ok(docx.includes(amount), `${ruleId} DOCX ${amount}`);
      assert.ok(pdf.includes(installment.condition), `${ruleId} PDF ${installment.condition}`);
      assert.ok(docx.includes(installment.condition), `${ruleId} DOCX ${installment.condition}`);
    }
  }
});

test("the PDF and the Word file agree line by line", async () => {
  const file = numberedFile();
  const quote = file.documents.quote;
  const pdf = await pdfText(await renderQuotePdf(quote));
  const docx = docxText(await renderHkidsDocx(quote));

  for (const item of quote.items) {
    assert.ok(pdf.includes(item.designation), `PDF ${item.designation}`);
    assert.ok(docx.includes(item.designation), `DOCX ${item.designation}`);
    assert.ok(pdf.includes(formatMoney(item.netAmountHt)), `PDF ${item.designation} amount`);
    assert.ok(docx.includes(formatMoney(item.netAmountHt)), `DOCX ${item.designation} amount`);
  }

  // The issuer and the customer are the same on both.
  for (const value of ["H KIDS", "MADAME EXEMPLE", "Ville Exemple", "DEV-HK-2026-9001"]) {
    assert.ok(pdf.includes(value), `PDF ${value}`);
    assert.ok(docx.includes(value), `DOCX ${value}`);
  }
});

// --- nothing is invented ------------------------------------------------------

test("with no register number, the documents say so instead of printing one", async () => {
  const file = commercialFile();
  const quote = file.documents.quote;

  assert.equal(quote.documentNumber, null);
  const view = createQuotePresentation(quote);
  assert.equal(view.numberAssigned, false);
  assert.equal(view.numberText, "Numéro de devis à attribuer après vérification du registre.");

  const pdf = await pdfText(await renderQuotePdf(quote));
  const docx = docxText(await renderHkidsDocx(quote));

  for (const rendered of [pdf, docx]) {
    assert.ok(rendered.includes("Numéro de devis à attribuer après vérification du registre."));
    assert.equal(/DEV-HK-\d{4}-\d{4}/.test(rendered), false, "no number may be fabricated");
    assert.equal(rendered.includes("null"), false);
    assert.equal(rendered.includes("undefined"), false);
  }
});

test("a missing date or customer is shown as missing, never filled in", async () => {
  const file = numberedFile({
    client: { name: "MADAME EXEMPLE", address: "" },
    dates: {}
  });
  const quote = file.documents.quote;
  const view = createQuotePresentation(quote);

  assert.equal(view.dateProvided, false);
  assert.equal(view.dateText, NOT_PROVIDED_TEXT);
  assert.equal(view.client.complete, false);
  assert.deepEqual([...view.absent], ["date", "client.address"]);

  const pdf = await pdfText(await renderQuotePdf(quote));
  const docx = docxText(await renderHkidsDocx(quote));
  for (const rendered of [pdf, docx]) {
    assert.ok(rendered.includes(NOT_PROVIDED_TEXT));
    // No date was conjured from today's clock or from anywhere else.
    assert.equal(/\d{2}\/\d{2}\/\d{4}/.test(rendered), false);
  }
});

test("with no schedule chosen the documents say so rather than assume the standard plan", async () => {
  const file = numberedFile({ paymentScheduleRuleId: null });
  const quote = file.documents.quote;
  const view = createQuotePresentation(quote);

  assert.equal(view.scheduleAvailable, false);
  assert.deepEqual([...view.installments], []);

  const pdf = await pdfText(await renderQuotePdf(quote));
  const docx = docxText(await renderHkidsDocx(quote));
  for (const rendered of [pdf, docx]) {
    assert.ok(rendered.includes("Échéancier : non défini."));
    assert.equal(rendered.includes("à la commande"), false, "no plan may be assumed");
  }
});

// --- the client quote carries nothing internal --------------------------------

test("no internal annex reaches the customer's quote", async () => {
  const file = numberedFile({ project: { fullAddress: "12 rue Exemple" } });
  const quote = file.documents.quote;
  const pdf = await pdfText(await renderQuotePdf(quote));
  const docx = docxText(await renderHkidsDocx(quote));

  // The file has plenty to say internally; none of it belongs on the quote.
  assert.ok(file.deliverables.missingInformationList.missingCount > 0);
  for (const rendered of [pdf, docx]) {
    assert.equal(rendered.includes("information manquante, à demander au client"), false);
    assert.equal(rendered.includes("Fiche interne"), false);
    assert.equal(rendered.includes("prerequisites"), false);
    assert.equal(rendered.includes("audience"), false);
  }
});

// --- the renderer only renders quotes -----------------------------------------

test("an invoice or a delivery note cannot be rendered as a quote", () => {
  const file = numberedFile();
  for (const document of [file.documents.invoice, file.documents.deliveryNote]) {
    assert.throws(
      () => createQuotePresentation(document),
      (error) => {
        assert.ok(error instanceof QuotePresentationError);
        assert.equal(error.code, "NOT_A_QUOTE");
        return true;
      },
      document.documentType
    );
  }
});

test("a quote with no line is refused rather than rendered empty", () => {
  assert.throws(
    () => createQuotePresentation({ documentType: "quote", items: [], totals: {} }),
    (error) => {
      assert.equal(error.code, "QUOTE_ITEMS_REQUIRED");
      return true;
    }
  );
});
