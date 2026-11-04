import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync, inflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import {
  createDocumentBundle,
  createQuotePresentation,
  discountRowLabel,
  formatMoney,
  invoiceDiscountLabel,
  invoiceShowsLineTaxes,
  renderHkidsDocx,
  renderHkidsPdf,
  renderQuotePdf,
  validateAndPrepareDocument
} from "../src/index.js";
import { HKIDS_BATCH_SCENARIOS, HKIDS_SALMA_QUOTE, createCommercialBatch } from "../src/documents/commercial-batch.js";

/**
 * The invoice, rendered, when the order carries a rebate.
 *
 * The audit found the invoice printing the gross line amount under "Total HT"
 * and nothing between the lines and a net TOTAL HT: the rebate the quote shows
 * was invisible, and the mezzanine line read 24 000 HT for 27 360 TTC. These
 * tests read the produced files back instead of trusting the structure.
 *
 * The amounts are those of files 3 and 2 of the official H-KIDS test; the
 * client and the designations are invented.
 */

const DISCOUNTED = Object.freeze({
  client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
  items: Object.freeze([
    { designation: "Lit mezzanine sur mesure", unit: "U", quantity: 1, unitPriceHt: 24000 },
    { designation: "Bureau enfant", unit: "U", quantity: 1, unitPriceHt: 4800 },
    { designation: "Armoire deux portes", unit: "U", quantity: 1, unitPriceHt: 4500 },
    { designation: "Livraison et installation", unit: "U", quantity: 1, unitPriceHt: 2000 }
  ]),
  tvaRate: 0.2,
  discount: { percent: 5, appliesToIndexes: [0], label: "Remise exceptionnelle" },
  paymentScheduleRuleId: "hkids-60-20-20-2026",
  paymentMethod: "virement bancaire",
  dates: { quoteDate: "06/09/2026", invoiceDate: "06/09/2026", deliveryNoteDate: "06/09/2026" },
  numbers: { quote: "63", invoice: "37", deliveryNote: "37" }
});

const UNDISCOUNTED = Object.freeze({
  ...DISCOUNTED,
  items: Object.freeze([
    { designation: "Lit superposé", unit: "U", quantity: 1, unitPriceHt: 18000 },
    { designation: "Bureau enfant", unit: "U", quantity: 1, unitPriceHt: 3200 },
    { designation: "Livraison et installation", unit: "U", quantity: 1, unitPriceHt: 2500 }
  ]),
  discount: null,
  numbers: { quote: "62", invoice: "36", deliveryNote: "36" }
});

// The invoice H-KIDS has always issued, prepared by the validator as the
// document routes prepare it: no rebate, a delivery note reference.
const HISTORICAL_INVOICE = Object.freeze({
  documentType: "invoice",
  documentNumber: "36",
  date: "06/09/2026",
  deliveryNoteReference: "98",
  object: "Vente de mobilier",
  client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
  items: [{ designation: "Canapé", unit: "U", quantity: 1, unitPriceHt: 4500, amountHt: 4500 }],
  totals: { totalHt: 4500, tva: 900, totalTtc: 5400 },
  payment: {
    method: "virement bancaire",
    terms: "60 % à la commande ; 20 % avant livraison ; 20 % après installation."
  }
});

const invoiceOf = (input) => createDocumentBundle(input).documents.invoice;

// --- reading the produced files back ------------------------------------------
//
// Same technique as hkids-quote-rendering.test.js: the renderer embeds subset
// fonts, so a page writes hex strings that only each font's own ToUnicode map
// turns back into words.

// The no-break spaces a number format may use, read as plain spaces.
const SPACES = new RegExp(`[${String.fromCharCode(0x00a0, 0x202f)}]`, "g");
const money = (value) => formatMoney(value).replace(SPACES, " ");

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
// in each. They are kept apart and each run is decoded with the font the Tf
// operator selected: merging them produces convincing nonsense.
function pageFontMaps(context, page) {
  const maps = new Map();
  const resources = context.lookup(page.node.get(PDFName.of("Resources")));
  const fonts = resources ? context.lookup(resources.get(PDFName.of("Font"))) : null;
  if (!fonts) {
    return maps;
  }
  for (const [name, ref] of fonts.entries()) {
    const toUnicode = context.lookup(context.lookup(ref)?.get(PDFName.of("ToUnicode")));
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
  return out.replace(SPACES, " ");
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
    .join("\n")
    .replace(SPACES, " ");
}

// The five rows of a discounted invoice, with the figures file 3 publishes.
function assertDiscountedTotals(text, labels, where) {
  const expected = [[labels[0], 35300], [labels[1], 1200], [labels[2], 34100], [labels[3], 6820], [labels[4], 40920]];
  for (const [label, amount] of expected) {
    assert.ok(text.includes(label), `${where}: "${label}" is missing`);
    assert.ok(text.includes(money(amount)), `${where}: ${amount} is missing`);
  }
  // Gross, rebate, net, then the tax: the order a reader checks them in.
  const positions = expected.map(([label]) => text.indexOf(label));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, `${where}: rows out of order`);
}

// --- a discounted invoice ---------------------------------------------------------

test("a discounted invoice PDF states the gross, the rebate, the net, the VAT and the total", async (t) => {
  const text = await pdfText(await renderHkidsPdf(invoiceOf(DISCOUNTED)));

  assertDiscountedTotals(text, ["TOTAL BRUT HT", "REMISE 5 %", "TOTAL NET HT", "TOTAL TVA", "TOTAL TTC"], "PDF");
});

test("a discounted invoice Word file states the gross, the rebate, the net, the VAT and the total", async (t) => {
  const text = docxText(await renderHkidsDocx(invoiceOf(DISCOUNTED)));

  assertDiscountedTotals(text, ["TOTAL BRUT HT", "REMISE 5 %", "TOTAL NET HT", "TOTAL TVA 20 %", "TOTAL TTC"], "DOCX");
});

test("the discounted line reads its net amount, and its gross stays readable", async (t) => {
  const invoice = invoiceOf(DISCOUNTED);

  // Désignation | Qté | Unité | PU HT | TVA | PU TTC | Total HT | Total TTC
  const cells = docxText(await renderHkidsDocx(invoice)).split("\n");
  const at = cells.indexOf("Lit mezzanine sur mesure");
  const [, , , puBrut, tva, , totalHt, totalTtc] = cells.slice(at, at + 8);
  assert.equal(puBrut, money(24000), "the gross unit price is still printed");
  assert.equal(totalHt, money(22800), "Total HT is the line amount after its rebate");
  assert.equal(tva, money(4560));
  assert.equal(totalTtc, money(27360));

  // 22 800 appears nowhere else on the page: only the net line column prints it.
  const pdf = await pdfText(await renderHkidsPdf(invoice));
  assert.ok(pdf.includes(money(22800)), "the PDF prints the net line amount");
});

test("every amount the invoice prints is one the engine produced", async (t) => {
  const invoice = invoiceOf(DISCOUNTED);

  const produced = new Set([
    ...Object.entries(invoice.totals).filter(([key]) => key !== "tvaRate").map(([, value]) => money(value)),
    ...invoice.items.flatMap((item) => ["unitPriceHt", "tva", "unitPriceTtc", "netAmountHt", "totalTtc"].map((key) => money(item[key]))),
    ...(invoice.schedule?.installments ?? []).map((installment) => money(installment.amountTtc))
  ]);
  const printed = docxText(await renderHkidsDocx(invoice)).split("\n").filter((cell) => / DH$/.test(cell));

  assert.ok(printed.length >= 10, "the invoice must actually carry amounts");
  for (const cell of printed) {
    assert.ok(produced.has(cell), `${cell} was printed but the engine never produced it`);
  }
});

// --- an invoice without a rebate -----------------------------------------------------

test("an invoice without a rebate keeps its three usual totals", async (t) => {
  const invoice = invoiceOf(UNDISCOUNTED);
  const pdf = await pdfText(await renderHkidsPdf(invoice));
  const docx = docxText(await renderHkidsDocx(invoice));

  for (const [where, text] of [["PDF", pdf], ["DOCX", docx]]) {
    assert.ok(text.includes("TOTAL HT"), `${where} TOTAL HT`);
    assert.ok(text.includes("TOTAL TVA"), `${where} TOTAL TVA`);
    assert.ok(text.includes("TOTAL TTC"), `${where} TOTAL TTC`);
    for (const absent of ["TOTAL BRUT HT", "REMISE", "TOTAL NET HT"]) {
      assert.equal(text.includes(absent), false, `${where} carries "${absent}"`);
    }
    // File 2's figures.
    assert.ok(text.includes(money(23700)), `${where} total HT`);
    assert.ok(text.includes(money(4740)), `${where} TVA`);
    assert.ok(text.includes(money(28440)), `${where} TTC`);
  }
});

test("an invoice prepared by the validator, as the document routes prepare it, renders as before", async (t) => {
  const invoice = validateAndPrepareDocument(HISTORICAL_INVOICE);
  const pdf = await pdfText(await renderHkidsPdf(invoice));
  const docx = docxText(await renderHkidsDocx(invoice));

  for (const [where, text] of [["PDF", pdf], ["DOCX", docx]]) {
    assert.ok(text.includes("TOTAL HT"), where);
    assert.equal(text.includes("REMISE"), false, where);
    assert.ok(text.includes(money(4500)), `${where} line and total HT`);
    assert.ok(text.includes(money(5400)), `${where} TTC`);
    assert.equal(text.includes("NaN"), false, `${where} prints an amount it could not read`);
  }
});

// --- a fixed rebate: file 7 --------------------------------------------------------------
//
// File 7 of the official test: 2 333,33 off 44 000,00, taken on the document and on
// no line. Its lines and its figures are the official test's; the unit, the dates
// and the payment method are stand-ins written here only.
//
// The engine leaves every line as it is without the rebate, so a line's TVA and TTC
// are those of its gross. Printed per line, they would add up to 8 800 and 52 800
// for an invoice charging 8 333,33 and 50 000. The invoice states its lines in HT
// and the tax once, on the net.

const FIXED = Object.freeze({
  ...DISCOUNTED,
  client: { name: "École Les Petits Explorateurs", address: "Marrakech" },
  items: Object.freeze([
    { designation: "Meuble TV et espace créatif", unit: "U", quantity: 1, unitPriceHt: 19500 },
    { designation: "Banquette de lecture", unit: "U", quantity: 1, unitPriceHt: 14500 },
    { designation: "Tableau noir mural", unit: "U", quantity: 1, unitPriceHt: 5500 },
    { designation: "Éclairage LED", unit: "U", quantity: 1, unitPriceHt: 2500 },
    { designation: "Livraison/install", unit: "U", quantity: 1, unitPriceHt: 2000 }
  ]),
  discount: { fixedAmount: 2333.33, label: "Remise exceptionnelle" },
  numbers: { quote: "67", invoice: "41", deliveryNote: "41" }
});

const quoteOf = (input) => createDocumentBundle(input).documents.quote;

// The rows in the order a reader checks them, each with its amount.
function assertRows(text, rows, where) {
  for (const [label, amount] of rows) {
    assert.ok(text.includes(label), `${where}: "${label}" is missing`);
    assert.ok(text.includes(money(amount)), `${where}: ${amount} is missing`);
  }
  const positions = rows.map(([label]) => text.indexOf(label));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, `${where}: rows out of order`);
}

const FIXED_INVOICE_ROWS = [
  ["TOTAL BRUT HT", 44000],
  ["REMISE EXCEPTIONNELLE", 2333.33],
  ["TOTAL NET HT", 41666.67],
  ["TOTAL TVA", 8333.33],
  ["TOTAL TTC", 50000]
];

test("file 7 keeps its figures, and no line receives a share of its fixed rebate", () => {
  for (const document of [invoiceOf(FIXED), quoteOf(FIXED)]) {
    const { totals } = document;
    assert.deepEqual(
      [totals.totalBrutHt, totals.totalDiscount, totals.totalNetHt, totals.tva, totals.totalTtc],
      [44000, 2333.33, 41666.67, 8333.33, 50000],
      document.documentType
    );
    assert.equal(
      document.items.every((item) => item.discountAmount === 0 && item.netAmountHt === item.amountHt),
      true,
      `${document.documentType}: a line carries a rebate`
    );
  }
});

test("file 7's invoice states the gross, REMISE EXCEPTIONNELLE, the net, the VAT and the total", async (t) => {
  const invoice = invoiceOf(FIXED);

  assertRows(await pdfText(await renderHkidsPdf(invoice)), FIXED_INVOICE_ROWS, "PDF");
  assertRows(docxText(await renderHkidsDocx(invoice)), FIXED_INVOICE_ROWS, "DOCX");
});

test("file 7's invoice states its lines in HT, with no TVA or TTC column that adds up to more", async (t) => {
  const invoice = invoiceOf(FIXED);
  const docx = docxText(await renderHkidsDocx(invoice));
  const pdf = await pdfText(await renderHkidsPdf(invoice));

  // Désignation | Qté | Unité | PU HT | Total HT, then the next line.
  const cells = docx.split("\n");
  const at = cells.indexOf("Meuble TV et espace créatif");
  assert.deepEqual(cells.slice(at, at + 6), ["Meuble TV et espace créatif", "1", "U", money(19500), money(19500), "Banquette de lecture"]);

  for (const [where, text] of [["PDF", pdf], ["DOCX", docx]]) {
    const tokens = text.split("\n");
    for (const header of ["Désignation", "Qté", "Unité", "PU HT", "Total HT"]) {
      assert.ok(tokens.includes(header), `${where}: header "${header}" is missing`);
    }
    for (const header of ["TVA", "PU TTC", "Total TTC"]) {
      assert.equal(tokens.includes(header), false, `${where}: a "${header}" column is printed`);
    }
    // A line's gross TVA and TTC, and the sums they would come to, appear nowhere.
    for (const amount of [3900, 23400, 400, 2400, 8800, 52800]) {
      assert.equal(text.includes(money(amount)), false, `${where}: ${amount} is printed`);
    }
  }
});

test("every amount file 7's invoice prints is one the engine produced", async (t) => {
  const invoice = invoiceOf(FIXED);

  const produced = new Set([
    ...Object.entries(invoice.totals).filter(([key]) => key !== "tvaRate").map(([, value]) => money(value)),
    ...invoice.items.flatMap((item) => ["unitPriceHt", "netAmountHt"].map((key) => money(item[key])))
  ]);
  const printed = docxText(await renderHkidsDocx(invoice)).split("\n").filter((cell) => / DH$/.test(cell));

  assert.equal(printed.length, 15, "five lines of two amounts, and five totals");
  for (const cell of printed) {
    assert.ok(produced.has(cell), `${cell} was printed but the engine never produced it`);
  }
});

test("file 7's quote names the rebate and keeps its lines whole, in PDF and Word", async () => {
  const quote = quoteOf(FIXED);
  const rows = [
    ["TOTAL BRUT HT", 44000],
    ["REMISE EXCEPTIONNELLE", 2333.33],
    ["TOTAL HT", 41666.67],
    ["TVA 20 %", 8333.33],
    ["TOTAL TTC", 50000]
  ];

  const view = createQuotePresentation(quote);
  assert.deepEqual(view.totalRows.map(([label]) => label), rows.map(([label]) => label));
  assert.equal(view.lines.every((line) => line.discountAmount === ""), true, "no line shows a rebate");

  const pdf = await pdfText(await renderQuotePdf(quote));
  const docx = docxText(await renderHkidsDocx(quote));
  for (const [where, text] of [["PDF", pdf], ["DOCX", docx]]) {
    assertRows(text, rows, where);
    assert.equal(text.includes("…"), false, `${where}: a label was cut short`);
    // Printed once, in the totals: never on a line.
    assert.equal(text.split(money(2333.33)).length - 1, 1, `${where}: 2 333,33 printed more than once`);
  }
});

test("percentage rebates and invoices without one keep their wording and their eight columns", async (t) => {
  // The label: a percentage names its rate, and never the rebate's label.
  assert.equal(discountRowLabel({ percent: 5, appliesToIndexes: [0], label: "Remise exceptionnelle" }), "REMISE 5 %");
  assert.equal(discountRowLabel({ fixedAmount: 2333.33, label: "Remise exceptionnelle" }), "REMISE EXCEPTIONNELLE");
  assert.equal(discountRowLabel({ fixedAmount: 100 }), "REMISE", "no label is invented");
  assert.equal(discountRowLabel(null), "REMISE");

  // Files 3, 6, 11 and 17, Salma, and a file without a rebate: the same labels as
  // before, and every line still carries its TVA and TTC.
  const batch = createCommercialBatch();
  const bundles = [
    ...[[3, "REMISE 5 %"], [6, "REMISE 10 %"], [11, "REMISE 7 %"], [17, "REMISE 5 %"], [2, null]]
      .map(([file, label]) => [`file ${file}`, batch.files.find((entry) => entry.file === file).bundle, label]),
    ["Salma", createDocumentBundle({
      client: { name: HKIDS_SALMA_QUOTE.client.name, address: HKIDS_SALMA_QUOTE.client.address },
      items: HKIDS_SALMA_QUOTE.lines.map(({ designation, quantity, unitPriceHt }) => ({ designation, quantity, unitPriceHt })),
      discount: HKIDS_SALMA_QUOTE.rebate,
      paymentScheduleRuleId: HKIDS_SALMA_QUOTE.paymentScheduleRuleId
    }), "REMISE 5 %"]
  ];
  for (const [where, bundle, label] of bundles) {
    const { quote, invoice } = bundle.documents;
    assert.equal(invoiceShowsLineTaxes(invoice), true, where);
    assert.equal(invoiceDiscountLabel(invoice), label, where);
    assert.equal(createQuotePresentation(quote).totalRows.some(([row]) => row === (label ?? "TOTAL HT")), true, where);
  }
  assert.equal(invoiceShowsLineTaxes(batch.files.find((entry) => entry.file === 7).bundle.documents.invoice), false);
  assert.equal(HKIDS_BATCH_SCENARIOS.filter((scenario) => scenario.rebate?.fixedAmount !== undefined).length, 1, "file 7 only");

  // Rendered: a discounted invoice keeps its eight columns.
  const cells = docxText(await renderHkidsDocx(invoiceOf(DISCOUNTED))).split("\n");
  for (const header of ["TVA", "PU TTC", "Total HT", "Total TTC"]) {
    assert.ok(cells.includes(header), `header "${header}"`);
  }
});

// Hiba reads the number first: it belongs in the title, at the top of the page,
// not on a line of its own under the subject.
test("the document number is in the title at the top, in the PDF and the Word file", async () => {
  const invoice = invoiceOf(DISCOUNTED);
  const pdf = await pdfText(await renderHkidsPdf(invoice));
  const word = docxText(await renderHkidsDocx(invoice));

  for (const [label, text] of [["PDF", pdf], ["Word", word]]) {
    assert.match(text, new RegExp(`FACTURE N° ${invoice.documentNumber}`), label);
    assert.doesNotMatch(text, /N° :/, `${label}: no separate number line`);
  }
});

test("the number is printed once, never repeated on the following pages", async () => {
  const invoice = invoiceOf(DISCOUNTED);
  const many = { ...invoice, items: Array.from({ length: 30 }, (_, index) => ({ ...invoice.items[0], designation: `Ligne ${index + 1}` })) };
  const text = await pdfText(await renderHkidsPdf(many));

  assert.equal(text.match(new RegExp(`N° ${invoice.documentNumber}`, "g"))?.length, 1);
});

// Hiba wants a quote on a single sheet. A document that only just spills over
// is drawn tighter to hold on one page; a long one keeps several pages.
test("a document that only just spills over holds on one page, a long one keeps several", async () => {
  const invoice = invoiceOf(DISCOUNTED);
  const withLines = (count) => ({
    ...invoice,
    items: Array.from({ length: count }, (_, index) => ({ ...invoice.items[0], designation: `Ligne ${index + 1} : meuble sur mesure, finition chêne, avec intégration de l'éclairage LED et quincaillerie` }))
  });
  const pages = async (document) => (await PDFDocument.load(await renderHkidsPdf(document))).getPageCount();

  assert.equal(await pages(withLines(6)), 1, "two pages in the regular layout");
  assert.ok(await pages(withLines(30)) > 1);
});
