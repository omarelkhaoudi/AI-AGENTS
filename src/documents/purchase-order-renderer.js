import { readFile } from "node:fs/promises";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { HKIDS_FIXED_IDENTITY, HKIDS_LOGO_PATH, documentTitleFor } from "./hkids-template.js";
import { formatMoney, resolveDocumentFontPath } from "./pdf-renderer.js";
import { HKIDS_PURCHASE_ORDER_ADDRESS_LINES, parseReferenceImage } from "./purchase-order.js";

// Delivery notes and invoices are painted over a template the company supplies.
// The purchase order has no template: it is drawn entirely here, on the layout
// of the orders H-KIDS issued by hand (160 to 163), so it needs nothing but the
// logo and a font.
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

const COLUMNS = Object.freeze({
  designation: { x: L + 6, width: 250 },
  quantity: { right: 340 },
  unitPrice: { right: 440 },
  amount: { right: R - 6 }
});

export async function renderPurchaseOrderPdf(document, {
  fontPath = process.env.HKIDS_DOCUMENT_FONT_PATH ?? null,
  boldFontPath = process.env.HKIDS_DOCUMENT_BOLD_FONT_PATH ?? null
} = {}) {
  const resolvedFontPath = await resolveDocumentFontPath("regular", fontPath);
  const resolvedBoldFontPath = await resolveDocumentFontPath("bold", boldFontPath);

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`H-KIDS — Bon de commande n° ${document.documentNumber} — ${document.client.name}`);
  pdf.setAuthor("H-KIDS");
  const font = await pdf.embedFont(await readFile(resolvedFontPath), { subset: true });
  const bold = await pdf.embedFont(await readFile(resolvedBoldFontPath), { subset: true });
  const logo = await pdf.embedJpg(await readFile(logoPath()));
  const writer = createWriter(pdf, document, { font, bold, logo });

  drawFirstPageHeader(writer, document);
  drawItems(writer, document);
  drawTotals(writer, document);
  drawSpecifications(writer, document);
  drawPaymentTerms(writer, document);
  drawSignatures(writer, document);

  const { image } = parseReferenceImage(document.referenceImage);
  if (image) {
    const embedded = image.format === "png" ? await pdf.embedPng(image.bytes) : await pdf.embedJpg(image.bytes);
    drawReferenceImagePage(writer, document, embedded);
  }

  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

// Coordinates are written from the top of the page, as on the reference orders,
// and converted to pdf-lib's bottom-up frame in one place.
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
  [...HKIDS_PURCHASE_ORDER_ADDRESS_LINES, `E-mail : ${HKIDS_FIXED_IDENTITY.email}`, `Tél : ${HKIDS_FIXED_IDENTITY.phone}`]
    .forEach((line, index) => w.text(line, 170, 63 + index * 10, { size: 8, color: COLORS.gray }));

  w.text(documentTitleFor(document.documentType), L, 112, { size: 18, isBold: true });
  if (document.object) {
    w.wrap(document.object.toUpperCase(), 290, 12, true).slice(0, 2)
      .forEach((line, index) => w.text(line, L, 132 + index * 15, { size: 12, isBold: true }));
  }

  w.text(`N° : ${document.documentNumber}`, L, 166, { size: 9, isBold: true });
  w.text(`Date : ${displayDate(document.date)}`, L, 183, { size: 8.5 });
  if (document.reference) {
    w.text(`Référence : ${document.reference}`, L, 199, { size: 8.5 });
  }

  w.text("Adressé à :", 350, 156, { size: 9, isBold: true });
  w.wrap(document.client.name, R - 350, 10, true).slice(0, 2)
    .forEach((line, index) => w.text(line, 350, 173 + index * 13, { size: 10, isBold: true }));
  const nameLines = Math.min(2, w.wrap(document.client.name, R - 350, 10, true).length);
  w.wrap(document.client.address, R - 350, 9).slice(0, 4)
    .forEach((line, index) => w.text(line, 350, 173 + nameLines * 13 + 3 + index * 13, { size: 9, color: COLORS.gray }));

  w.y = 236;
}

function drawTableHeader(w) {
  w.box(L, w.y, R - L, 23, { fill: COLORS.green });
  const top = w.y + 15;
  w.text("Désignation", COLUMNS.designation.x, top, { size: 7.8, isBold: true, color: COLORS.white });
  w.text("Qté", COLUMNS.quantity.right, top, { size: 7.8, isBold: true, color: COLORS.white, align: "right" });
  w.text("Prix unitaire HT", COLUMNS.unitPrice.right, top, { size: 7.8, isBold: true, color: COLORS.white, align: "right" });
  w.text("Montant HT", COLUMNS.amount.right, top, { size: 7.8, isBold: true, color: COLORS.white, align: "right" });
  w.y += 23;
}

function drawItems(w, document) {
  drawTableHeader(w);
  for (const item of document.items) {
    const lines = w.wrap(item.designation, COLUMNS.designation.width, 9);
    const height = Math.max(33, 14 + lines.length * 12);
    if (w.y + height > CONTENT_BOTTOM) {
      w.ensure(height + 23);
      drawTableHeader(w);
    }
    lines.forEach((line, index) => w.text(line, COLUMNS.designation.x, w.y + 19 + index * 12, { size: 9 }));
    w.text(formatQuantity(item.quantity), COLUMNS.quantity.right, w.y + 19, { size: 8.5, align: "right" });
    w.text(formatMoney(item.unitPriceHt), COLUMNS.unitPrice.right, w.y + 19, { size: 8.5, align: "right" });
    w.text(formatMoney(item.amountHt), COLUMNS.amount.right, w.y + 19, { size: 8.5, align: "right" });
    w.y += height;
    w.rule(w.y);
  }
  w.y += 12;
}

function drawTotals(w, document) {
  w.ensure(80);
  const labelX = 340;
  const tvaPercent = Math.round(Number(document.totals.tvaRate ?? document.tvaRate ?? 0.2) * 100);
  for (const [label, value] of [["TOTAL HT", document.totals.totalHt], [`TVA ${tvaPercent} %`, document.totals.tva]]) {
    w.text(label, labelX, w.y + 12, { size: 9, isBold: true });
    w.text(formatMoney(value), R - 10, w.y + 12, { size: 9, align: "right" });
    w.y += 18;
  }
  w.box(labelX - 10, w.y, R - labelX + 10, 30, { fill: COLORS.green });
  w.text("TOTAL TTC", labelX, w.y + 19, { size: 10.5, isBold: true, color: COLORS.white });
  w.text(formatMoney(document.totals.totalTtc), R - 10, w.y + 20, { size: 12.5, isBold: true, color: COLORS.white, align: "right" });
  w.y += 46;
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

function drawPaymentTerms(w, document) {
  const instalments = document.payment.instalments ?? [];
  const extra = (document.payment.method ? 1 : 0) + (document.note ? 1 : 0);
  w.ensure(24 + (instalments.length + extra) * 18);
  w.text("CONDITIONS DE RÈGLEMENT", L, w.y + 10, { size: 9, isBold: true });
  w.y += 28;
  for (const instalment of instalments) {
    w.text(`${instalment.percent} % ${instalment.due} : ${formatMoney(instalment.amount)}.`, L, w.y, { size: 9 });
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

function drawSignatures(w, document) {
  w.ensure(110);
  w.text("H-KIDS – Mobilier et aménagement sur mesure pour enfants.", L, w.y + 4, { size: 8, color: COLORS.gray });
  w.y += 16;
  w.rule(w.y);
  w.text("BON POUR ACCORD", L, w.y + 19, { size: 9, isBold: true });
  w.text("Pour H KIDS", L, w.y + 40, { size: 9, isBold: true });
  w.text("Le client", 310, w.y + 40, { size: 9, isBold: true });
  w.text("Nom : ______________________________", L, w.y + 56, { size: 8 });
  w.text(`Nom : ${document.client.name}`, 310, w.y + 56, { size: 8 });
  w.text("Signature / Cachet :", L, w.y + 72, { size: 8 });
  w.text("Signature :", 310, w.y + 72, { size: 8 });
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

function formatQuantity(value) {
  return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Number(value)).replace(/ /g, " ");
}

function displayDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }
  return value;
}
