import { readFile } from "node:fs/promises";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { HKIDS_LOGO_PATH } from "./hkids-template.js";
import { resolveDocumentFontPath } from "./pdf-renderer.js";
import { createQuotePresentation } from "./quote-presentation.js";

/**
 * The quote, drawn.
 *
 * The invoice and the delivery note are produced by copying an official H-KIDS
 * template and writing the variable values onto it. There is no official quote
 * template: none was supplied, and inventing one would put a document under the
 * company's name in a layout it never approved.
 *
 * So this page is composed. What it prints comes from the repository — the
 * fixed identity H-KIDS already declares, the versioned logo, and the figures
 * the calculation and payment modules produced. The *layout* is this file's
 * own, and it is the one part of the document H-KIDS has not seen. When a
 * template arrives, the overlay path is where it belongs, and this renderer
 * becomes the fallback.
 */

const A4 = Object.freeze({ width: 595.28, height: 841.89 });

const MARGIN = 40;
const INK = rgb(0.09, 0.13, 0.16);
const MUTED = rgb(0.4, 0.44, 0.48);
const RULE = rgb(0.78, 0.8, 0.83);
const HEADER_FILL = rgb(0.5, 0.65, 0.59);

// Column widths, left to right, summing to the printable width.
const COLUMN_WIDTHS = Object.freeze([196, 34, 40, 78, 68, 99]);
const ROW_HEIGHT = 18;
const BOTTOM_LIMIT = 96;

async function embedLogo(pdf) {
  const configured = typeof process.env.HKIDS_LOGO_PATH === "string" ? process.env.HKIDS_LOGO_PATH.trim() : "";
  try {
    return await pdf.embedJpg(await readFile(configured === "" ? HKIDS_LOGO_PATH : configured));
  } catch {
    // A missing logo is not a reason to refuse a quote. Everything else on the
    // page is still true.
    return null;
  }
}

function truncate(value, font, size, maxWidth) {
  let out = String(value);
  if (font.widthOfTextAtSize(out, size) <= maxWidth) {
    return out;
  }
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

function drawCell(page, value, { x, y, width, size, font, color = INK, align = "left" }) {
  const shown = truncate(value, font, size, width - 8);
  const textWidth = font.widthOfTextAtSize(shown, size);
  const offset = align === "right" ? width - 4 - textWidth : align === "center" ? (width - textWidth) / 2 : 4;
  page.drawText(shown, { x: x + offset, y, size, font, color });
}

export async function renderQuotePdf(quote, {
  fontPath = process.env.HKIDS_DOCUMENT_FONT_PATH ?? null,
  boldFontPath = process.env.HKIDS_DOCUMENT_BOLD_FONT_PATH ?? null
} = {}) {
  // One view, shared with the Word renderer. Nothing below recomputes a figure.
  const view = createQuotePresentation(quote);

  // Resolved first: a missing font is a configuration problem, and reporting it
  // before anything is drawn makes it the error the caller actually sees.
  const regularPath = await resolveDocumentFontPath("regular", fontPath);
  const boldPath = await resolveDocumentFontPath("bold", boldFontPath);

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(await readFile(regularPath), { subset: true });
  const bold = await pdf.embedFont(await readFile(boldPath), { subset: true });
  const logo = await embedLogo(pdf);

  const printable = A4.width - MARGIN * 2;
  let page = pdf.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN;

  function newPage() {
    page = pdf.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN;
  }

  function ensure(space) {
    if (y - space < BOTTOM_LIMIT) {
      newPage();
    }
  }

  function line(value, { size = 8, useBold = false, color = INK, gap = 12, x = MARGIN } = {}) {
    ensure(gap);
    page.drawText(String(value), { x, y, size, font: useBold ? bold : font, color });
    y -= gap;
  }

  // --- issuer -------------------------------------------------------------
  if (logo) {
    const size = logo.scaleToFit(110, 62);
    page.drawImage(logo, { x: MARGIN, y: y - size.height, width: size.width, height: size.height });
  }

  const identityX = MARGIN + 130;
  let identityY = y - 10;
  page.drawText(view.issuer.name, { x: identityX, y: identityY, size: 11, font: bold, color: INK });
  identityY -= 13;
  for (const addressLine of view.issuer.addressLines) {
    page.drawText(addressLine, { x: identityX, y: identityY, size: 7.4, font, color: MUTED });
    identityY -= 10;
  }
  page.drawText(`E-mail : ${view.issuer.email}`, { x: identityX, y: identityY, size: 7.4, font, color: MUTED });
  identityY -= 10;
  page.drawText(`Tél : ${view.issuer.phone}`, { x: identityX, y: identityY, size: 7.4, font, color: MUTED });

  y = Math.min(y - 72, identityY - 18);

  // --- title, number, date --------------------------------------------------
  line(view.title, { size: 18, useBold: true, gap: 22 });
  // A number the register has not given prints the register's sentence, never
  // a value made up to fill the field.
  line(`N° : ${view.numberText}`, { size: 9, useBold: view.numberAssigned, color: view.numberAssigned ? INK : MUTED });
  line(`Date : ${view.dateText}`, { size: 8.4, color: view.dateProvided ? INK : MUTED, gap: 18 });

  // --- client ---------------------------------------------------------------
  line("Adressé à :", { size: 8.4, useBold: true, gap: 12 });
  line(view.client.name, { size: 9, color: view.client.complete ? INK : MUTED });
  line(view.client.address, { size: 8.4, color: view.client.complete ? INK : MUTED, gap: 20 });

  // --- lines ----------------------------------------------------------------
  function drawTableHeader() {
    ensure(ROW_HEIGHT + 4);
    page.drawRectangle({ x: MARGIN, y: y - 4, width: printable, height: ROW_HEIGHT, color: HEADER_FILL });
    let x = MARGIN;
    view.columns.forEach((label, index) => {
      drawCell(page, label, {
        x,
        y: y + 1,
        width: COLUMN_WIDTHS[index],
        size: 7.4,
        font: bold,
        color: rgb(1, 1, 1),
        align: index === 0 ? "left" : "center"
      });
      x += COLUMN_WIDTHS[index];
    });
    y -= ROW_HEIGHT;
  }

  drawTableHeader();
  for (const item of view.lines) {
    if (y - ROW_HEIGHT < BOTTOM_LIMIT) {
      newPage();
      drawTableHeader();
    }
    let x = MARGIN;
    item.cells.forEach((value, index) => {
      drawCell(page, value, {
        x,
        y: y + 1,
        width: COLUMN_WIDTHS[index],
        size: 7.2,
        font,
        align: index === 0 ? "left" : index >= 3 ? "right" : "center"
      });
      x += COLUMN_WIDTHS[index];
    });
    page.drawLine({
      start: { x: MARGIN, y: y - 4 },
      end: { x: MARGIN + printable, y: y - 4 },
      thickness: 0.4,
      color: RULE
    });
    y -= ROW_HEIGHT;
  }

  y -= 12;

  // --- totals ---------------------------------------------------------------
  const totalsX = MARGIN + printable - 240;
  for (const [label, amount] of view.totalRows) {
    ensure(14);
    const last = label === "TOTAL TTC";
    drawCell(page, label, { x: totalsX, y, width: 140, size: last ? 9 : 8.2, font: last ? bold : font });
    drawCell(page, amount, { x: totalsX + 140, y, width: 100, size: last ? 9 : 8.2, font: last ? bold : font, align: "right" });
    y -= 14;
  }

  y -= 14;

  // --- payment --------------------------------------------------------------
  line("CONDITIONS DE RÈGLEMENT", { size: 8.4, useBold: true, gap: 14 });
  line(`Moyen de paiement : ${view.paymentMethod}`, { size: 8 });
  line(view.paymentTerms, { size: 8, gap: 16 });

  if (view.scheduleAvailable) {
    for (const installment of view.installments) {
      ensure(13);
      drawCell(page, `${installment.percent} %`, { x: MARGIN, y, width: 50, size: 8, font: bold });
      drawCell(page, installment.condition, { x: MARGIN + 54, y, width: 200, size: 8, font });
      drawCell(page, installment.amountTtc, { x: MARGIN + 258, y, width: 110, size: 8, font, align: "right" });
      y -= 13;
    }
  } else {
    // No plan chosen is said, not filled in with the standard one.
    line("Échéancier : non défini.", { size: 8, color: MUTED });
  }

  // --- footer ---------------------------------------------------------------
  for (const current of pdf.getPages()) {
    current.drawText(view.footerMention, { x: MARGIN, y: 62, size: 6.6, font, color: MUTED });
    current.drawText(view.issuer.legalLine, { x: MARGIN, y: 50, size: 5.6, font, color: MUTED });
  }

  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
