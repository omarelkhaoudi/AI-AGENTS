import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { DELIVERY_NOTE_PROFILES, HKIDS_DOCUMENT_TYPES } from "./document-schema.js";
import {
  HKIDS_FIXED_IDENTITY,
  HKIDS_LOGO_PATH,
  deliveryNoteReferences,
  documentTitleFor,
  invoiceUpstreamReference
} from "./hkids-template.js";
import { parseReferenceImage } from "./purchase-order.js";

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

// Every H-KIDS document is drawn here, in one design: the one the company
// adopted with its purchase orders and quotes (BC 163, devis of October 2026).
// Logo and company block at the top, the title and its subject, the number and
// date on the left and the client on the right, a table with a green header,
// the totals on a green band, the terms, then what the type needs: the
// specifications and an agreement block on an order, a receipt block on a
// delivery note. Nothing is painted over a template any more, so a document
// needs the logo and a font and nothing else.
const PAGE = Object.freeze({ width: 595.28, height: 841.89 });
const L = 40;
const R = PAGE.width - 40;
const CONTENT_BOTTOM = 770;

const COLORS = Object.freeze({
  green: rgb(0x80 / 255, 0xa6 / 255, 0x97 / 255),
  ink: rgb(0x17 / 255, 0x21 / 255, 0x29 / 255),
  gray: rgb(0x66 / 255, 0x71 / 255, 0x7a / 255),
  line: rgb(0xcc / 255, 0xd3 / 255, 0xd8 / 255),
  pale: rgb(0xf1 / 255, 0xf5 / 255, 0xf3 / 255),
  white: rgb(1, 1, 1)
});

// Columns per type. `right` aligns a figure on its right edge; the first column
// is the designation, which wraps within its width. An invoice carries the
// eight columns a Moroccan invoice is read by; the other types the four of the
// purchase order.
const TABLE_LAYOUTS = Object.freeze({
  standard: Object.freeze({
    size: 8.5,
    headerSize: 7.8,
    designation: { label: "Désignation", x: L + 6, width: 250 },
    columns: Object.freeze([
      { label: "Qté", key: "quantity", right: 340 },
      { label: "Prix unitaire HT", key: "unitPriceHt", right: 440 },
      { label: "Montant HT", key: "amountHt", right: R - 6 }
    ])
  }),
  invoice: Object.freeze({
    size: 7.4,
    headerSize: 7,
    designation: { label: "Désignation", x: L + 6, width: 140 },
    columns: Object.freeze([
      { label: "Qté", key: "quantity", right: 214 },
      { label: "Unité", key: "unit", right: 246 },
      { label: "PU HT", key: "unitPriceHt", right: 306 },
      { label: "TVA", key: "tva", right: 361 },
      { label: "PU TTC", key: "unitPriceTtc", right: 423 },
      { label: "Total HT", key: "amountHt", right: 489 },
      { label: "Total TTC", key: "totalTtc", right: R - 6 }
    ])
  }),
  // An invoice discounted by a fixed amount states its lines in HT only:
  // invoiceShowsLineTaxes says why.
  invoiceHtOnly: Object.freeze({
    size: 8,
    headerSize: 7.4,
    designation: { label: "Désignation", x: L + 6, width: 220 },
    columns: Object.freeze([
      { label: "Qté", key: "quantity", right: 300 },
      { label: "Unité", key: "unit", right: 345 },
      { label: "PU HT", key: "unitPriceHt", right: 440 },
      { label: "Total HT", key: "netAmountHt", right: R - 6 }
    ])
  }),
  // A delivery note that states only the goods: no price anywhere.
  goodsOnly: Object.freeze({
    size: 8.5,
    headerSize: 7.8,
    designation: { label: "Désignation", x: L + 6, width: 330 },
    columns: Object.freeze([
      { label: "Qté", key: "quantity", right: 440 },
      { label: "Unité", key: "unit", right: R - 6 }
    ])
  })
});

const TAGLINE = "H-KIDS – Mobilier et aménagement sur mesure pour enfants.";

export async function renderHkidsPdf(document, {
  fontPath = process.env.HKIDS_DOCUMENT_FONT_PATH ?? null,
  boldFontPath = process.env.HKIDS_DOCUMENT_BOLD_FONT_PATH ?? null
} = {}) {
  // Resolved before anything else is read. A missing font is a configuration
  // problem, and reporting it first makes it the error the caller actually sees.
  const resolvedFontPath = await resolveDocumentFontPath("regular", fontPath);
  const resolvedBoldFontPath = await resolveDocumentFontPath("bold", boldFontPath);

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`H-KIDS — ${titleCase(documentTitleFor(document.documentType))} n° ${document.documentNumber} — ${document.client.name}`);
  pdf.setAuthor("H-KIDS");
  const font = await pdf.embedFont(await readFile(resolvedFontPath), { subset: true });
  const bold = await pdf.embedFont(await readFile(resolvedBoldFontPath), { subset: true });
  const logo = await pdf.embedJpg(await readFile(logoPath()));
  const writer = createWriter(pdf, document, { font, bold, logo });

  drawFirstPageHeader(writer, document);
  drawItems(writer, document);
  if (document.totals) {
    drawTotals(writer, document);
  } else {
    drawDeliveryNoteReferences(writer, document);
  }
  drawSpecifications(writer, document);
  if (document.payment) {
    drawPaymentTerms(writer, document);
  }
  drawClosing(writer, document);

  const { image } = parseReferenceImage(document.referenceImage);
  if (image) {
    const embedded = image.format === "png" ? await pdf.embedPng(image.bytes) : await pdf.embedJpg(image.bytes);
    drawReferenceImagePage(writer, document, embedded);
  }

  assertNoQuestionMarkInPdfText(document);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

// Coordinates are written from the top of the page, as on the reference
// documents, and converted to pdf-lib's bottom-up frame in one place.
function createWriter(pdf, document, { font, bold, logo }) {
  const writer = {
    pdf,
    font,
    bold,
    logo,
    page: null,
    y: 0,
    text(value, x, top, { size = 9, isBold = false, color = COLORS.ink, align = "left" } = {}) {
      const usedFont = isBold ? bold : font;
      const content = String(value);
      const width = usedFont.widthOfTextAtSize(content, size);
      const left = align === "right" ? x - width : align === "center" ? x - width / 2 : x;
      this.page.drawText(content, { x: left, y: PAGE.height - top, size, font: usedFont, color });
    },
    box(x, top, width, height, { fill = null, border = COLORS.line } = {}) {
      this.page.drawRectangle({
        x,
        y: PAGE.height - top - height,
        width,
        height,
        ...(fill ? { color: fill } : { borderColor: border, borderWidth: 0.6 })
      });
    },
    rule(top) {
      this.page.drawLine({ start: { x: L, y: PAGE.height - top }, end: { x: R, y: PAGE.height - top }, color: COLORS.line, thickness: 0.5 });
    },
    wrap(value, width, size = 9, isBold = false) {
      return wrapText(String(value), isBold ? bold : font, size, width);
    },
    newPage() {
      this.page = pdf.addPage([PAGE.width, PAGE.height]);
      drawFooter(this);
      this.y = 0;
    },
    // Starts a continuation page when the block would cross the footer.
    ensure(height) {
      if (this.y + height > CONTENT_BOTTOM) {
        this.newPage();
        drawContinuationHeader(this, document);
      }
    }
  };
  writer.newPage();
  return writer;
}

function drawFirstPageHeader(w, document) {
  drawLogo(w);
  w.text(HKIDS_FIXED_IDENTITY.companyName, 170, 48, { size: 11, isBold: true });
  [...HKIDS_FIXED_IDENTITY.addressLines, `E-mail : ${HKIDS_FIXED_IDENTITY.email}`, `Tél : ${HKIDS_FIXED_IDENTITY.phone}`]
    .forEach((line, index) => w.text(line, 170, 63 + index * 10, { size: 8, color: COLORS.gray }));

  w.text(documentTitleFor(document.documentType), L, 112, { size: 18, isBold: true });
  if (document.object) {
    w.wrap(document.object.toUpperCase(), 290, 12, true).slice(0, 2)
      .forEach((line, index) => w.text(line, L, 132 + index * 15, { size: 12, isBold: true }));
  }

  w.text(`N° : ${document.documentNumber}`, L, 166, { size: 9, isBold: true });
  w.text(`Date : ${displayDate(document.date)}`, L, 183, { size: 8.5 });
  const reference = referenceLine(document);
  if (reference) {
    w.text(reference, L, 199, { size: 8.5 });
  }

  w.text("Adressé à :", 350, 156, { size: 9, isBold: true });
  const nameLines = w.wrap(document.client.name, R - 350, 10, true).slice(0, 2);
  nameLines.forEach((line, index) => w.text(line, 350, 173 + index * 13, { size: 10, isBold: true }));
  w.wrap(document.client.address, R - 350, 9).slice(0, 4)
    .forEach((line, index) => w.text(line, 350, 173 + nameLines.length * 13 + 3 + index * 13, { size: 9, color: COLORS.gray }));

  w.y = 236;
}

// The label follows the reference the invoice actually carries: a quote for the
// commercial file, a delivery note for the historical flow.
function referenceLine(document) {
  if (document.documentType === HKIDS_DOCUMENT_TYPES.INVOICE) {
    const upstream = invoiceUpstreamReference(document);
    if (!upstream) {
      return null;
    }
    const value = upstream.field === "deliveryNoteReference"
      ? String(upstream.value).replace(/^BL\s*n°?\s*/i, "")
      : upstream.value;
    return `${upstream.label} : ${value}`;
  }
  return document.reference ? `Référence : ${document.reference}` : null;
}

function tableLayout(document) {
  if (document.documentType === HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE
    && document.deliveryNoteProfile === DELIVERY_NOTE_PROFILES.GOODS_ONLY) {
    return TABLE_LAYOUTS.goodsOnly;
  }
  if (document.documentType === HKIDS_DOCUMENT_TYPES.INVOICE) {
    return invoiceShowsLineTaxes(document) ? TABLE_LAYOUTS.invoice : TABLE_LAYOUTS.invoiceHtOnly;
  }
  return TABLE_LAYOUTS.standard;
}

function drawTableHeader(w, layout) {
  w.box(L, w.y, R - L, 23, { fill: COLORS.green });
  const top = w.y + 15;
  const style = { size: layout.headerSize, isBold: true, color: COLORS.white };
  w.text(layout.designation.label, layout.designation.x, top, style);
  for (const column of layout.columns) {
    w.text(column.label, column.right, top, { ...style, align: "right" });
  }
  w.y += 23;
}

function drawItems(w, document) {
  const layout = tableLayout(document);
  drawTableHeader(w, layout);
  for (const item of document.items) {
    const lines = w.wrap(item.designation, layout.designation.width, layout.size + 0.5);
    const height = Math.max(33, 14 + lines.length * 12);
    if (w.y + height > CONTENT_BOTTOM) {
      w.ensure(height + 23);
      drawTableHeader(w, layout);
    }
    lines.forEach((line, index) => w.text(line, layout.designation.x, w.y + 19 + index * 12, { size: layout.size + 0.5 }));
    for (const column of layout.columns) {
      w.text(cellValue(item, column.key), column.right, w.y + 19, { size: layout.size, align: "right" });
    }
    w.y += height;
    w.rule(w.y);
  }
  w.y += 12;
}

function cellValue(item, key) {
  if (key === "quantity") {
    return formatQuantity(item.quantity);
  }
  if (key === "unit") {
    return item.unit || "—";
  }
  // A line rebated on its own states its net; otherwise net and gross agree.
  if (key === "netAmountHt" || key === "amountHt") {
    return formatMoney(item.netAmountHt ?? item.amountHt);
  }
  return formatMoney(item[key]);
}

// A discounted invoice states the gross, the rebate and the net before the tax,
// as the quote does. Every figure is the engine's: nothing here adds anything.
function drawTotals(w, document) {
  const totals = document.totals;
  const discountLabel = invoiceDiscountLabel(document);
  const tvaPercent = Math.round(Number(totals.tvaRate ?? document.tvaRate ?? 0.2) * 100);
  const rows = discountLabel
    ? [["TOTAL BRUT HT", totals.totalBrutHt], [discountLabel, totals.totalDiscount], ["TOTAL NET HT", totals.totalHt], [`TOTAL TVA ${tvaPercent} %`, totals.tva]]
    : [["TOTAL HT", totals.totalHt], [`TOTAL TVA ${tvaPercent} %`, totals.tva]];
  w.ensure(44 + rows.length * 18);
  const labelX = 340;
  for (const [label, value] of rows) {
    w.text(label, labelX, w.y + 12, { size: 9, isBold: true });
    w.text(formatMoney(value), R - 10, w.y + 12, { size: 9, align: "right" });
    w.y += 18;
  }
  w.box(labelX - 10, w.y, R - labelX + 10, 30, { fill: COLORS.green });
  w.text("TOTAL TTC", labelX, w.y + 19, { size: 10.5, isBold: true, color: COLORS.white });
  w.text(formatMoney(document.totals.totalTtc), R - 10, w.y + 20, { size: 12.5, isBold: true, color: COLORS.white, align: "right" });
  w.y += 46;
}

// What a delivery note with no price says instead of amounts: the documents
// it refers back to, and when the goods are due, exactly as the document says.
function drawDeliveryNoteReferences(w, document) {
  const lines = deliveryNoteReferences(document).map((reference) => `${reference.label} : ${reference.value}`);
  if (document.deliveryDateText) {
    lines.push(document.deliveryDateText);
  }
  if (lines.length === 0) {
    return;
  }
  w.ensure(lines.length * 16 + 10);
  for (const line of lines) {
    w.text(line, L, w.y + 10, { size: 9, isBold: !line.startsWith("Date") });
    w.y += 16;
  }
  w.y += 12;
}

function drawSpecifications(w, document) {
  const specifications = document.specifications ?? [];
  if (specifications.length === 0) {
    return;
  }
  w.ensure(23 + 30);
  w.box(L, w.y, R - L, 23, { fill: COLORS.pale });
  w.text("CARACTÉRISTIQUES ET FINITIONS", L + 8, w.y + 15, { size: 9, isBold: true });
  w.y += 33;
  for (const specification of specifications) {
    const lines = w.wrap(specification, R - L - 30, 9);
    w.ensure(lines.length * 14 + 6);
    w.text("•", L + 8, w.y + 10, { size: 9, color: COLORS.green });
    lines.forEach((line, index) => w.text(line, L + 21, w.y + 10 + index * 14, { size: 9 }));
    w.y += lines.length * 14 + 6;
  }
  w.y += 8;
}

// An order states its plan as instalments with their amounts; the other types
// state the terms as written, as before.
function drawPaymentTerms(w, document) {
  const instalments = document.payment.instalments ?? [];
  const termLines = instalments.length > 0
    ? instalments.map((instalment) => `${instalment.percent} % ${instalment.due} : ${formatMoney(instalment.amount)}.`)
    : document.payment.terms ? w.wrap(document.payment.terms, R - L, 9) : [];
  const extra = (document.payment.method ? 1 : 0) + (document.note ? 1 : 0);
  w.ensure(28 + (termLines.length + extra) * 18);
  w.text("CONDITIONS DE RÈGLEMENT", L, w.y + 10, { size: 9, isBold: true });
  w.y += 28;
  for (const line of termLines) {
    w.text(line, L, w.y, { size: 9 });
    w.y += 18;
  }
  if (document.payment.method) {
    w.text(`Moyen de paiement : ${document.payment.method}`, L, w.y, { size: 9 });
    w.y += 18;
  }
  if (document.note) {
    for (const line of w.wrap(`Note : ${document.note}`, R - L, 9)) {
      w.ensure(14);
      w.text(line, L, w.y, { size: 9 });
      w.y += 14;
    }
    w.y += 4;
  }
}

// What closes the document depends on what it is for: the client agrees to an
// order, receives a delivery, and settles an invoice, which needs no signature.
function drawClosing(w, document) {
  const block = {
    [HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER]: { title: "BON POUR ACCORD", left: "Pour H KIDS", right: "Le client", leftSign: "Signature / Cachet :", rightSign: "Signature :" },
    [HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE]: { title: "RÉCEPTION DE LA LIVRAISON", left: "Livré par H KIDS", right: "Reçu par le client", leftSign: "Signature / Cachet :", rightSign: "Date et signature :" }
  }[document.documentType];

  w.ensure(block ? 110 : 20);
  w.text(TAGLINE, L, w.y + 4, { size: 8, color: COLORS.gray });
  w.y += 16;
  if (!block) {
    return;
  }
  w.rule(w.y);
  w.text(block.title, L, w.y + 19, { size: 9, isBold: true });
  w.text(block.left, L, w.y + 40, { size: 9, isBold: true });
  w.text(block.right, 310, w.y + 40, { size: 9, isBold: true });
  w.text("Nom : ______________________________", L, w.y + 56, { size: 8 });
  w.text(`Nom : ${document.client.name}`, 310, w.y + 56, { size: 8 });
  w.text(block.leftSign, L, w.y + 72, { size: 8 });
  w.text(block.rightSign, 310, w.y + 72, { size: 8 });
  w.box(L, w.y + 80, 245, 33);
  w.box(310, w.y + 80, R - 310, 33);
  w.y += 120;
}

function drawReferenceImagePage(w, document, image) {
  w.newPage();
  drawContinuationHeader(w, document);
  w.text("VISUEL DE RÉFÉRENCE", L, 132, { size: 12, isBold: true });
  const maxWidth = R - L;
  const maxHeight = CONTENT_BOTTOM - 150 - 10;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1.5);
  const width = image.width * scale;
  const height = image.height * scale;
  w.page.drawImage(image, { x: (PAGE.width - width) / 2, y: PAGE.height - 150 - height, width, height });
}

function drawContinuationHeader(w, document) {
  drawLogo(w);
  w.text(`${documentTitleFor(document.documentType)} N° ${document.documentNumber}`, R, 57, { size: 13, isBold: true, align: "right" });
  w.text(document.client.name, R, 77, { size: 9, color: COLORS.gray, align: "right" });
  w.rule(106);
  w.y = 120;
}

function drawLogo(w) {
  const height = 100 * w.logo.height / w.logo.width;
  w.page.drawImage(w.logo, { x: L, y: PAGE.height - 29 - height, width: 100, height });
}

function drawFooter(w) {
  w.text(HKIDS_FIXED_IDENTITY.footerMention, L, 792, { size: 6.5, color: COLORS.gray });
  w.text(HKIDS_FIXED_IDENTITY.legalLine, L, 804, { size: 5.7, color: COLORS.gray });
}

function wrapText(value, font, size, width) {
  const lines = [];
  for (const paragraph of value.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(candidate, size) > width) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

// An override that is set to an empty string is not an override, as for the
// Word renderer.
function logoPath() {
  const configured = typeof process.env.HKIDS_LOGO_PATH === "string" ? process.env.HKIDS_LOGO_PATH.trim() : "";
  return configured === "" ? HKIDS_LOGO_PATH : configured;
}

function titleCase(value) {
  return String(value ?? "").toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
}

/**
 * How a document's rebate is named on its totals. One wording for the quote and
 * the invoice, the PDF and the Word file: "REMISE 5 %" for a percentage, the
 * rebate's own label for a fixed amount, and "REMISE" otherwise.
 */
export function discountRowLabel(discount) {
  if (discount?.percent) {
    return `REMISE ${discount.percent} %`;
  }
  const label = typeof discount?.label === "string" ? discount.label.trim() : "";
  return isFixedDiscount(discount) && label !== "" ? label.toLocaleUpperCase("fr-FR") : "REMISE";
}

function isFixedDiscount(discount) {
  const amount = discount?.fixedAmount;
  return amount !== undefined && amount !== null && amount !== "";
}

/**
 * Whether an invoice prints a TVA and a TTC on each of its lines. It does,
 * except when its rebate is a fixed amount: that rebate is taken off the total
 * and on no line, so the lines' TTC would add up to more than the invoice
 * charges. The lines then state their HT, and the tax is stated once, on the net.
 */
export function invoiceShowsLineTaxes(document) {
  return !(document?.documentType === HKIDS_DOCUMENT_TYPES.INVOICE && isFixedDiscount(document.discount));
}

/**
 * The label of the rebate row of an invoice, or null when the invoice carries
 * no rebate. Shared with the Word renderer so both files say the same thing.
 */
export function invoiceDiscountLabel(document) {
  if (document?.documentType !== HKIDS_DOCUMENT_TYPES.INVOICE || !(Number(document.totals?.totalDiscount) > 0)) {
    return null;
  }
  return discountRowLabel(document.discount);
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

function displayDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }
  return value;
}

function assertNoQuestionMarkInPdfText(document) {
  const { referenceImage, ...rest } = document;
  if (JSON.stringify(rest).includes("?")) {
    throw new Error("Document data contains a forbidden question mark.");
  }
}
