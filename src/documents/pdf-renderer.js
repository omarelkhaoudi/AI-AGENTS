import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { HKIDS_DOCUMENT_TYPES } from "./document-schema.js";
import { HKIDS_FIXED_IDENTITY, assertHkidsTemplateAvailable, documentTitleFor } from "./hkids-template.js";

// pdf-lib embeds a real font file, so rendering needs a .ttf that exists on the
// machine doing the rendering. The two variables below are the way to name one.
export const DOCUMENT_FONT_VARIABLES = Object.freeze({
  regular: "HKIDS_DOCUMENT_FONT_PATH",
  bold: "HKIDS_DOCUMENT_BOLD_FONT_PATH"
});

// Candidates, never assumptions. Each path is probed and the first readable one
// wins, so a machine that has none of them gets a refusal naming the variable to
// set rather than an ENOENT on a path this file invented. The Windows entries
// come first because the reference documents were produced with Arial and must
// keep rendering identically there.
const FONT_CANDIDATES = Object.freeze({
  regular: Object.freeze([
    "C:\\Windows\\Fonts\\arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    // Liberation Sans is metric-compatible with Arial; DejaVu is the fallback
    // present on almost every Linux install.
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf"
  ]),
  bold: Object.freeze([
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"
  ])
});

export class DocumentFontError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "DocumentFontError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// A configured path is used exactly as given, or refused. Falling back to a
// probed font would render the document in a typeface nobody asked for, and the
// operator would have no way to notice.
export async function resolveDocumentFontPath(variant, configuredPath = null) {
  const variable = DOCUMENT_FONT_VARIABLES[variant];
  if (!variable) {
    throw new DocumentFontError(`Unknown font variant: ${variant}`, "DOCUMENT_FONT_VARIANT_UNKNOWN", { variant });
  }

  const configured = typeof configuredPath === "string" ? configuredPath.trim() : "";
  if (configured !== "") {
    if (await isReadableFile(configured)) {
      return configured;
    }
    throw new DocumentFontError(
      `${variable} points to a font file that cannot be read: ${configured}`,
      "DOCUMENT_FONT_NOT_READABLE",
      { variant, variable, path: configured }
    );
  }

  for (const candidate of FONT_CANDIDATES[variant]) {
    if (await isReadableFile(candidate)) {
      return candidate;
    }
  }

  throw new DocumentFontError(
    `No ${variant} font was found on this machine. Set ${variable} to the absolute path of a .ttf file.`,
    "DOCUMENT_FONT_NOT_CONFIGURED",
    { variant, variable, candidates: [...FONT_CANDIDATES[variant]] }
  );
}

async function isReadableFile(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const TEMPLATE_LAYOUTS = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE]: Object.freeze({
    expectedPages: 3,
    header: Object.freeze({
      title: { x: 306, y: 807, size: 8.4 },
      number: { x: 437, y: 807, size: 8.4 },
      date: { x: 306, y: 792, size: 8 },
      reference: { x: 306, y: 775, size: 7.6 },
      clientBox: { x: 306, y: 704, width: 262, height: 47 },
      clientTextCover: { x: 306, y: 704, width: 262, height: 58 },
      clientLabel: { x: 313, y: 741, size: 8 },
      clientName: { x: 313, y: 727, size: 7.8 },
      clientAddress: { x: 313, y: 713, size: 7.2, maxWidth: 238 }
    }),
    covers: Object.freeze([
      Object.freeze([
        { x: 305, y: 772, width: 258, height: 50 },
        { x: 20, y: 37, width: 555, height: 613 }
      ]),
      Object.freeze([
        { x: 20, y: 335, width: 555, height: 475 },
        { x: 0, y: 180, width: 595, height: 185 },
        { x: 400, y: 120, width: 175, height: 260 }
      ]),
      Object.freeze([])
    ]),
    tables: Object.freeze([
      { x: 20, y: 37, width: 555, top: 620, headerBottom: 600, verticals: [193, 413, 445, 505], headers: ["Image", "Désignation", "Qté", "Pu HT", "Total HT"] },
      { x: 20, y: 395, width: 555, top: 810, headerBottom: null, verticals: [193, 413, 445, 505], headers: null },
      null
    ]),
    itemPageIndex: 0,
    totalsPageIndex: 1,
    itemStartY: 575,
    rowHeight: 55,
    columns: Object.freeze([
      { key: "designation", x: 195, width: 216, align: "left", size: 8 },
      { key: "quantity", x: 414, width: 29, align: "center", size: 8 },
      { key: "unitPriceHt", x: 446, width: 57, align: "right", size: 8 },
      { key: "amountHt", x: 506, width: 67, align: "right", size: 8 }
    ]),
    totals: { xLabel: 420, xValue: 500, y: 315, size: 8 },
    payment: { x: 45, y: 252, size: 7.4, maxWidth: 500 },
    footer: null
  }),
  [HKIDS_DOCUMENT_TYPES.INVOICE]: Object.freeze({
    expectedPages: 2,
    outputPageIndices: Object.freeze([0]),
    header: Object.freeze({
      title: { x: 306, y: 799, size: 10.6 },
      number: { x: 365, y: 799, size: 10 },
      date: { x: 348, y: 785, size: 9.5 },
      reference: { x: 306, y: 758, size: 8.5 },
      clientBox: { x: 306, y: 696, width: 262, height: 47 },
      clientTextCover: { x: 306, y: 696, width: 262, height: 55 },
      clientLabel: { x: 313, y: 731, size: 8 },
      clientName: { x: 313, y: 716, size: 8 },
      clientAddress: { x: 313, y: 702, size: 7.4, maxWidth: 240 }
    }),
    covers: Object.freeze([
      Object.freeze([
        { x: 305, y: 748, width: 258, height: 64 },
        { x: 20, y: 25, width: 560, height: 602 },
        { x: 575, y: 25, width: 20, height: 602 }
      ]),
      Object.freeze([
        { x: 20, y: 588, width: 560, height: 220 },
        { x: 0, y: 360, width: 595, height: 225 },
        { x: 420, y: 170, width: 160, height: 180 }
      ])
    ]),
    tables: Object.freeze([
      { x: 20, y: 315, width: 555, top: 627, headerBottom: 608, verticals: [225, 253, 285, 345, 401, 461, 519], headers: ["Désignation", "Qté", "Unité", "Pu Brut", "TVA", "Pu TTC", "Total HT", "Total TTC"] }
    ]),
    itemPageIndex: 0,
    totalsPageIndex: 0,
    paymentPageIndex: 0,
    object: { x: 20, y: 640, size: 8.4, maxWidth: 500, cover: { x: 18, y: 632, width: 230, height: 18 } },
    itemStartY: 586,
    rowHeight: 24,
    columns: Object.freeze([
      { key: "designation", x: 25, width: 198, align: "left", size: 6.7 },
      { key: "quantity", x: 226, width: 26, align: "center", size: 6.7 },
      { key: "unit", x: 254, width: 30, align: "center", size: 6.7 },
      { key: "unitPriceHt", x: 286, width: 58, align: "right", size: 5.9 },
      { key: "tva", x: 346, width: 54, align: "right", size: 5.9 },
      { key: "unitPriceTtc", x: 402, width: 58, align: "right", size: 5.9 },
      { key: "amountHt", x: 462, width: 56, align: "right", size: 5.9 },
      { key: "totalTtc", x: 520, width: 53, align: "right", size: 5.9 }
    ]),
    totals: { xLabel: 420, xValue: 500, y: 280, size: 8.4 },
    payment: { x: 45, y: 220, size: 8.3, maxWidth: 500 },
    footer: { x: 45, y: 95, size: 7.2, maxWidth: 505 }
  })
});

export async function renderHkidsPdf(document, {
  fontPath = process.env.HKIDS_DOCUMENT_FONT_PATH ?? null,
  boldFontPath = process.env.HKIDS_DOCUMENT_BOLD_FONT_PATH ?? null
} = {}) {
  // Resolved before anything else is read. A missing font is a configuration
  // problem, and reporting it first makes it the error the caller actually sees
  // instead of an ENOENT thrown halfway through a render.
  const resolvedFontPath = await resolveDocumentFontPath("regular", fontPath);
  const resolvedBoldFontPath = await resolveDocumentFontPath("bold", boldFontPath);

  const template = await assertHkidsTemplateAvailable(document.documentType);
  const templateBytes = await readFile(template.path);
  const source = await PDFDocument.load(templateBytes);
  const layout = TEMPLATE_LAYOUTS[document.documentType];
  if (source.getPageCount() !== layout.expectedPages) {
    throw new Error(`Template ${template.id} must contain ${layout.expectedPages} pages.`);
  }

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const copiedPages = await pdf.copyPages(source, layout.outputPageIndices ?? [...Array(source.getPageCount()).keys()]);
  copiedPages.forEach((page) => pdf.addPage(page));

  const font = await pdf.embedFont(await readFile(resolvedFontPath), { subset: true });
  const boldFont = await pdf.embedFont(await readFile(resolvedBoldFontPath), { subset: true });
  const pages = pdf.getPages();

  applyCovers(pages, layout);
  drawTableFrames(pages, layout, { font: boldFont });
  drawHeaderVariables(pages[0], document, layout, { font, boldFont });
  drawDocumentObject(pages[0], document, layout, { font: boldFont });
  drawItems(pages[layout.itemPageIndex], document, layout, { font });
  drawTotals(pages[layout.totalsPageIndex], document, layout, { font, boldFont });
  drawPaymentAndNotes(pages[layout.paymentPageIndex ?? layout.totalsPageIndex], document, layout, { font, boldFont });

  assertNoQuestionMarkInPdfText(document);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

function applyCovers(pages, layout) {
  layout.covers.forEach((pageCovers, index) => {
    const page = pages[index];
    if (!page) {
      return;
    }
    for (const box of pageCovers) {
      cover(page, box);
    }
  });
}

function drawTableFrames(pages, layout, { font }) {
  if (!layout.tables) {
    return;
  }
  layout.tables.forEach((table, index) => {
    if (!table) {
      return;
    }
    const page = pages[index];
    if (!page) {
      return;
    }
    const right = table.x + table.width;
    const black = rgb(0, 0, 0);
    const line = { color: black, thickness: 0.6 };
    page.drawLine({ start: { x: table.x, y: table.top }, end: { x: right, y: table.top }, ...line });
    page.drawLine({ start: { x: table.x, y: table.y }, end: { x: right, y: table.y }, ...line });
    page.drawLine({ start: { x: table.x, y: table.y }, end: { x: table.x, y: table.top }, ...line });
    page.drawLine({ start: { x: right, y: table.y }, end: { x: right, y: table.top }, ...line });
    for (const x of table.verticals) {
      page.drawLine({ start: { x, y: table.y }, end: { x, y: table.top }, ...line });
    }
    if (table.headerBottom) {
      page.drawLine({ start: { x: table.x, y: table.headerBottom }, end: { x: right, y: table.headerBottom }, ...line });
      drawTableHeaders(page, table, font);
    }
  });
}

function drawTableHeaders(page, table, font) {
  const boundaries = [table.x, ...table.verticals, table.x + table.width];
  table.headers.forEach((label, index) => {
    const left = boundaries[index];
    const right = boundaries[index + 1];
    const size = 8.2;
    const width = font.widthOfTextAtSize(label, size);
    page.drawText(label, {
      x: left + (right - left - width) / 2,
      y: table.headerBottom + 6,
      size,
      font,
      color: rgb(0, 0, 0)
    });
  });
}

function drawHeaderVariables(page, document, layout, { font, boldFont }) {
  const h = layout.header;
  drawText(page, documentTitleFor(document.documentType), h.title, boldFont);
  drawText(page, `N°: ${document.documentNumber}`, h.number, boldFont);
  drawText(page, `Date : ${formatDateForDisplay(document.date)}`, h.date, font);
  if (document.documentType === HKIDS_DOCUMENT_TYPES.INVOICE) {
    drawText(page, `Référence BL : ${normalizeDeliveryNoteReference(document.deliveryNoteReference)}`, h.reference, font);
  } else if (document.reference) {
    drawText(page, `Référence : ${document.reference}`, h.reference, font);
  }

  cover(page, h.clientTextCover);
  page.drawRectangle({ ...h.clientBox, borderColor: rgb(0, 0, 0), borderWidth: 0.45 });
  drawText(page, "Adressé à :", h.clientLabel, font);
  drawText(page, document.client.name, h.clientName, boldFont);
  drawText(page, document.client.address, h.clientAddress, font);
}

function drawDocumentObject(page, document, layout, { font }) {
  if (!layout.object) {
    return;
  }
  if (layout.object.cover) {
    cover(page, layout.object.cover);
  }
  if (document.object) {
    drawText(page, `Objet : ${document.object}`, layout.object, font);
  }
}

function drawItems(page, document, layout, { font }) {
  document.items.forEach((item, index) => {
    const y = layout.itemStartY - index * layout.rowHeight;
    for (const column of layout.columns) {
      const value = valueForColumn(item, column.key);
      drawAlignedText(page, value, column, y, font);
    }
  });
}

function drawTotals(page, document, layout, { font, boldFont }) {
  const rows = [
    ["TOTAL HT:", formatMoney(document.totals.totalHt)],
    ["TOTAL TVA:", formatMoney(document.totals.tva)],
    ["TOTAL TTC:", formatMoney(document.totals.totalTtc)]
  ];
  let y = layout.totals.y;
  for (const [label, value] of rows) {
    page.drawText(label, { x: layout.totals.xLabel, y, size: layout.totals.size, font: boldFont, color: rgb(0, 0, 0) });
    page.drawText(value, { x: layout.totals.xValue, y, size: layout.totals.size, font, color: rgb(0, 0, 0) });
    y -= document.documentType === HKIDS_DOCUMENT_TYPES.INVOICE ? 15 : 14;
  }
}

function drawPaymentAndNotes(page, document, layout, { font, boldFont }) {
  const payment = layout.payment;
  let y = payment.y;
  if (document.note) {
    drawText(page, `Note : ${document.note}`, { x: payment.x, y, size: payment.size, maxWidth: payment.maxWidth }, font);
    y -= 20;
  } else if (document.documentType === HKIDS_DOCUMENT_TYPES.INVOICE) {
    cover(page, { x: payment.x - 1, y: y - 3, width: 42, height: payment.size + 6 });
  }
  drawText(page, "Conditions de paiement", { x: payment.x, y, size: payment.size, maxWidth: payment.maxWidth }, boldFont);
  drawText(page, document.payment.terms, { x: payment.x, y: y - 15, size: payment.size, maxWidth: payment.maxWidth }, font);
  drawText(page, `Moyen de paiement : ${document.payment.method}`, { x: payment.x, y: y - 30, size: payment.size, maxWidth: payment.maxWidth }, font);
  if (layout.footer) {
    drawText(page, HKIDS_FIXED_IDENTITY.footerMention, layout.footer, font);
  }
}

function valueForColumn(item, key) {
  if (["unitPriceHt", "tva", "unitPriceTtc", "amountHt", "totalTtc"].includes(key)) {
    return formatMoney(item[key]);
  }
  if (key === "quantity") {
    return formatQuantity(item.quantity);
  }
  return item[key] ?? "";
}

function drawText(page, text, position, font) {
  page.drawText(String(text), {
    x: position.x,
    y: position.y,
    size: position.size,
    font,
    color: rgb(0, 0, 0),
    maxWidth: position.maxWidth
  });
}

function drawAlignedText(page, text, column, y, font) {
  const value = String(text);
  const padding = 2;
  let x = column.x + padding;
  if (column.align === "right") {
    x = column.x + column.width - padding - font.widthOfTextAtSize(value, column.size);
  } else if (column.align === "center") {
    x = column.x + (column.width - font.widthOfTextAtSize(value, column.size)) / 2;
  }
  page.drawText(value, { x, y, size: column.size, font, color: rgb(0, 0, 0), maxWidth: column.width - padding * 2 });
}

function cover(page, box) {
  page.drawRectangle({ ...box, color: rgb(1, 1, 1) });
}

export function formatMoney(value) {
  return `${formatMoneyNumber(value)} DH`;
}

function formatMoneyNumber(value) {
  return new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Number(value)).replace(/\u202f/g, " ");
}

function formatQuantity(value) {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Number(value)).replace(/\u202f/g, " ");
}

function formatDateForDisplay(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }
  return value;
}

function normalizeDeliveryNoteReference(value) {
  return String(value).replace(/^BL\s*n°?\s*/i, "");
}

function assertNoQuestionMarkInPdfText(document) {
  const serialized = JSON.stringify(document);
  if (serialized.includes("?")) {
    throw new Error("Document data contains a forbidden question mark.");
  }
}
