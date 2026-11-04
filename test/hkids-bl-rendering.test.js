import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync, inflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import {
  createDocumentBundle,
  renderHkidsDocx,
  renderHkidsPdf,
  validateAndPrepareDocument
} from "../src/index.js";
import { createCommercialBatch } from "../src/documents/commercial-batch.js";

/**
 * The delivery note of a commercial file, rendered.
 *
 * It carries the goods and no price. These tests read the produced PDF and Word
 * file back and check what they actually say — a structural check would pass on
 * a document that draws amounts the model never gave it.
 *
 * The client is invented, as in every committed fixture.
 */

const FILE_INPUT = Object.freeze({
  client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
  items: Object.freeze([
    { designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1, unitPriceHt: 24000 },
    { designation: "Matelas enfant", unit: "U", quantity: 3, unitPriceHt: 1600 }
  ]),
  tvaRate: 0.2,
  paymentScheduleRuleId: "hkids-60-20-20-2026",
  paymentMethod: "virement bancaire",
  dates: { quoteDate: "06/09/2026", invoiceDate: "06/09/2026", deliveryNoteDate: "06/09/2026" },
  numbers: { quote: "61", invoice: "35", deliveryNote: "35" }
});

function goodsOnlyDeliveryNote(overrides = {}) {
  return createDocumentBundle({ ...FILE_INPUT, ...overrides }).documents.deliveryNote;
}

// The priced delivery note H-KIDS has always issued, kept here as the control:
// the new profile must not have replaced it.
const PRICED_DELIVERY_NOTE = Object.freeze({
  documentType: "delivery_note",
  documentNumber: "98",
  date: "06/09/2026",
  reference: "Commande validée",
  client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
  items: Object.freeze([
    { designation: "Canapé", unit: "U", quantity: 1, unitPriceHt: 4500, amountHt: 4500 }
  ]),
  totals: { totalHt: 4500, tva: 900, totalTtc: 5400 },
  payment: {
    method: "virement bancaire",
    // The approved standard plan, in full: a partial one is refused, and rightly.
    terms: "60 % à la commande ; 20 % avant livraison ; 20 % après installation."
  }
});

// --- reading the produced files back ------------------------------------------
//
// Same technique as hkids-quote-rendering.test.js: the renderer embeds subset
// fonts, so a page writes hex strings that only each font's own ToUnicode map
// turns back into words.

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

// Each font carries its own map, and the same code means a different character
// in each. They are kept apart and the run is decoded with the font the Tf
// operator selected: merging them produces convincing nonsense.
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

// Anything that reads as an amount of dirhams, and the labels that introduce one.
function assertCarriesNoPrice(text, where) {
  for (const forbidden of ["TOTAL HT", "Total HT", "TVA", "TTC", "Pu HT", "Pu Brut",
    "Prix unitaire", "Montant HT", "DH", "Conditions de paiement", "Moyen de paiement"]) {
    assert.equal(text.includes(forbidden), false, `${where} carries "${forbidden}"`);
  }
  // The figures of this very file, in the formats the renderers use.
  for (const amount of ["24000", "24 000", "1600", "1 600", "28800", "28 800", "4800", "5760"]) {
    assert.equal(text.includes(amount), false, `${where} carries the amount ${amount}`);
  }
}

// --- the PDF -------------------------------------------------------------------

test("a goods-only delivery note renders to a real PDF", async (t) => {

  const bytes = await renderHkidsPdf(goodsOnlyDeliveryNote());
  const pdf = await PDFDocument.load(bytes);

  assert.ok(bytes.length > 5000, "a rendered delivery note is not an empty file");
  assert.equal(pdf.getPageCount(), 1, "the delivery note fits on one page");
  assert.equal(Buffer.from(bytes).includes(Buffer.from("/ToUnicode")), true);
});

test("the PDF states the goods, the references and the delivery date", async (t) => {
  const text = await pdfText(await renderHkidsPdf(goodsOnlyDeliveryNote()));

  assert.match(text, /BON DE LIVRAISON/);
  assert.match(text, /35/, "the delivery note number");
  assert.match(text, /MADAME EXEMPLE/);
  assert.match(text, /Ville Exemple/);

  assert.match(text, /Lit mezzanine sur mesure/);
  assert.match(text, /Matelas enfant/);
  assert.match(text, /Désignation/);
  assert.match(text, /Qté/);
  assert.match(text, /Unité/);

  assert.match(text, /Référence devis : 61/);
  assert.match(text, /Référence facture : 35/);
  assert.match(text, /Date de livraison : à définir/);
});

test("the PDF carries no price of any kind", async (t) => {
  assertCarriesNoPrice(await pdfText(await renderHkidsPdf(goodsOnlyDeliveryNote())), "the PDF");
});

// --- the Word file ---------------------------------------------------------------

test("a goods-only delivery note renders to Word with no template configured", async () => {
  // Deliberately outside useSyntheticHkidsTemplates: this renderer composes the
  // document itself and must not demand a file it never opens.
  const bytes = await renderHkidsDocx(goodsOnlyDeliveryNote());

  assert.ok(bytes.length > 2000);
  assert.equal(Buffer.from(bytes).subarray(0, 4).equals(LOCAL_FILE_HEADER), true, "a .docx is a zip");
});

test("the Word file states the goods, the references and the delivery date", async () => {
  const text = docxText(await renderHkidsDocx(goodsOnlyDeliveryNote()));

  assert.match(text, /BON DE LIVRAISON/);
  assert.match(text, /BON DE LIVRAISON N° 35/, "the number is in the title, at the top");
  assert.match(text, /MADAME EXEMPLE/);
  assert.match(text, /Ville Exemple/);
  assert.match(text, /Lit mezzanine sur mesure/);
  assert.match(text, /Matelas enfant/);
  assert.match(text, /Unité/);
  assert.match(text, /Référence devis : 61/);
  assert.match(text, /Référence facture : 35/);
  assert.match(text, /Date de livraison : à définir/);
});

test("the Word file carries no price of any kind", async () => {
  assertCarriesNoPrice(docxText(await renderHkidsDocx(goodsOnlyDeliveryNote())), "the Word file");
});

test("the quantity on the delivery note is the one that was ordered", async () => {
  const text = docxText(await renderHkidsDocx(goodsOnlyDeliveryNote()));
  const lines = text.split("\n");

  // Three mattresses were ordered, and the delivery note says three.
  assert.equal(lines[lines.indexOf("Matelas enfant") + 1], "3");
  assert.equal(lines[lines.indexOf("Lit mezzanine sur mesure") + 1], "1");
});

// --- the control: the priced delivery note is untouched ------------------------------

test("the priced delivery note still renders its totals and its payment block", async (t) => {

  const priced = validateAndPrepareDocument(PRICED_DELIVERY_NOTE);
  const text = await pdfText(await renderHkidsPdf(priced));

  // Everything the goods-only note must not have, the priced one still has.
  assert.match(text, /TOTAL HT/);
  assert.match(text, /TOTAL TVA/);
  assert.match(text, /TOTAL TTC/);
  assert.match(text, /CONDITIONS DE RÈGLEMENT/);
  assert.match(text, /Prix unitaire HT/, "the priced note keeps its price column");
  assert.match(text, /Montant HT/);

  const docx = docxText(await renderHkidsDocx(priced));
  assert.match(docx, /TOTAL HT/);
  assert.match(docx, /Prix unitaire HT/);
});

test("the two profiles produce different documents from the same delivery", async (t) => {

  const goodsOnly = await pdfText(await renderHkidsPdf(goodsOnlyDeliveryNote()));
  const priced = await pdfText(await renderHkidsPdf(validateAndPrepareDocument(PRICED_DELIVERY_NOTE)));

  assert.equal(goodsOnly.includes("TOTAL HT"), false);
  assert.equal(priced.includes("TOTAL HT"), true);
  assert.equal(goodsOnly.includes("Unité"), true);
  assert.equal(priced.includes("Unité"), false, "the priced note has no unit column");
});

// --- a delivery note with nothing to refer to ------------------------------------------

test("a reference the document does not carry prints nothing rather than an empty label", async () => {
  // No invoice number: the delivery note refers to the quote alone.
  const document = goodsOnlyDeliveryNote({ numbers: { quote: "61", deliveryNote: "35" } });
  const text = docxText(await renderHkidsDocx(document));

  assert.match(text, /Référence devis : 61/);
  assert.equal(text.includes("Référence facture"), false);
  assert.match(text, /Date de livraison : à définir/);
});

// --- files 11 and 16: a designation that states a price ------------------------------------

test("the delivery notes of files 11 and 16 print their goods and not the price their designation states", async (t) => {
  const batch = createCommercialBatch();

  for (const [file, delivered, amounts] of [
    [11, "Deux matelas", ["1600", "1 600"]],
    [16, "Deux packs lits cabanes", ["6 900", "6900"]]
  ]) {
    const deliveryNote = batch.files.find((entry) => entry.file === file).bundle.documents.deliveryNote;
    for (const [where, text] of [
      ["PDF", await pdfText(await renderHkidsPdf(deliveryNote))],
      ["DOCX", docxText(await renderHkidsDocx(deliveryNote))]
    ]) {
      assert.ok(text.includes(delivered), `file ${file} ${where}: "${delivered}" is missing`);
      assert.equal(text.includes("DH"), false, `file ${file} ${where} carries "DH"`);
      for (const amount of amounts) {
        assert.equal(text.includes(amount), false, `file ${file} ${where} carries ${amount}`);
      }
    }
  }
});
