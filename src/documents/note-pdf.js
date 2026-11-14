import { readFile } from "node:fs/promises";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { HKIDS_FIXED_IDENTITY } from "./hkids-template.js";
import { logoPath, resolveDocumentFontPath } from "./pdf-renderer.js";

// A PDF the Director hands to the direction in the conversation: a work sheet,
// a memo, a procedure, a summary. A4, the H-KIDS header and legal line, and the
// text written as simple Markdown: "#" titles, "-" bullets, "1." steps,
// "| a | b |" tables, **bold**. Not a commercial document: quotes, orders and
// invoices keep their own numbered templates.

const PAGE = Object.freeze({ width: 595.28, height: 841.89, margin: 50 });
const INK = rgb(0.12, 0.14, 0.13);
const MUTED = rgb(0.42, 0.45, 0.43);
const ACCENT = rgb(0.13, 0.33, 0.28);
const RULE = rgb(0.82, 0.85, 0.83);
const MAX_CHARS = 60_000;

export function pdfFileName(title, today = new Date()) {
  const slug = String(title || "document").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document";
  return `${today.toISOString().slice(0, 10)}_${slug}.pdf`;
}

export async function renderNotePdf({ title, content, date = new Date(), fontPath = process.env.HKIDS_DOCUMENT_FONT_PATH ?? null, boldFontPath = process.env.HKIDS_DOCUMENT_BOLD_FONT_PATH ?? null } = {}) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`H-KIDS — ${title}`);
  pdf.setAuthor("H-KIDS");
  const font = await pdf.embedFont(await readFile(await resolveDocumentFontPath("regular", fontPath)), { subset: true });
  const bold = await pdf.embedFont(await readFile(await resolveDocumentFontPath("bold", boldFontPath)), { subset: true });
  const logo = await pdf.embedJpg(await readFile(logoPath()));
  const writer = createWriter(pdf, { font, bold, logo, title, date });
  writer.title(title);
  for (const block of parseBlocks(String(content ?? "").slice(0, MAX_CHARS))) {
    writer.block(block);
  }
  writer.finish();
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

// Lines of Markdown, read as blocks. Anything unknown is a paragraph.
export function parseBlocks(content) {
  const blocks = [];
  let table = null;
  for (const raw of clean(content).split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\|.*\|$/.test(line)) {
      const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
        continue;
      }
      if (!table) {
        table = { kind: "table", rows: [] };
        blocks.push(table);
      }
      table.rows.push(cells);
      continue;
    }
    table = null;
    if (line === "" || /^(-{3,}|_{3,}|\*{3,})$/.test(line)) {
      blocks.push({ kind: "space" });
    } else if (/^#{1,6}\s+/.test(line)) {
      blocks.push({ kind: "heading", level: line.match(/^#+/)[0].length, text: line.replace(/^#+\s+/, "") });
    } else if (/^[-*•]\s+/.test(line)) {
      blocks.push({ kind: "bullet", depth: raw.match(/^\s*/)[0].length >= 2 ? 1 : 0, text: line.replace(/^[-*•]\s+/, "") });
    } else if (/^\d+[.)]\s+/.test(line)) {
      blocks.push({ kind: "step", label: line.match(/^\d+/)[0], text: line.replace(/^\d+[.)]\s+/, "") });
    } else if (/^\*\*[^*]+\*\*:?$/.test(line) || /^—.*—$/.test(line)) {
      blocks.push({ kind: "heading", level: 3, text: line.replace(/\*\*/g, "").replace(/^—\s*|\s*—$/g, "") });
    } else {
      blocks.push({ kind: "paragraph", text: line });
    }
  }
  return blocks;
}

// What the fonts can draw: no emoji, no invisible characters.
function clean(text) {
  return String(text)
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/[​­]/g, "")
    .replace(/\t/g, "  ");
}

function createWriter(pdf, { font, bold, logo, title, date }) {
  const width = PAGE.width - 2 * PAGE.margin;
  let page;
  let y;
  const pages = [];

  function newPage() {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    pages.push(page);
    const logoHeight = 46;
    const scaled = logo.scale(logoHeight / logo.height);
    page.drawImage(logo, { x: PAGE.margin, y: PAGE.height - PAGE.margin - logoHeight, width: scaled.width, height: logoHeight });
    const right = PAGE.width - PAGE.margin;
    const lines = [HKIDS_FIXED_IDENTITY.companyName, ...HKIDS_FIXED_IDENTITY.addressLines, `${HKIDS_FIXED_IDENTITY.phone} · ${HKIDS_FIXED_IDENTITY.email}`];
    lines.forEach((line, index) => {
      const face = index === 0 ? bold : font;
      const size = index === 0 ? 11 : 8;
      page.drawText(line, { x: right - face.widthOfTextAtSize(line, size), y: PAGE.height - PAGE.margin - 10 - index * 11, size, font: face, color: index === 0 ? ACCENT : MUTED });
    });
    y = PAGE.height - PAGE.margin - logoHeight - 14;
    page.drawLine({ start: { x: PAGE.margin, y }, end: { x: right, y }, thickness: 0.8, color: RULE });
    y -= 22;
  }

  function room(height) {
    if (y - height < PAGE.margin + 30) {
      newPage();
    }
  }

  function wrap(text, face, size, maxWidth) {
    const out = [];
    for (const paragraph of String(text).split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = line ? `${line} ${word}` : word;
        if (face.widthOfTextAtSize(candidate, size) <= maxWidth) {
          line = candidate;
          continue;
        }
        if (line) {
          out.push(line);
        }
        // A word wider than the line is cut.
        let rest = word;
        while (face.widthOfTextAtSize(rest, size) > maxWidth) {
          let cut = rest.length - 1;
          while (cut > 1 && face.widthOfTextAtSize(rest.slice(0, cut), size) > maxWidth) {
            cut -= 1;
          }
          out.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
      out.push(line);
    }
    return out;
  }

  // **bold** inside a line: drawn piece by piece.
  function runs(text) {
    return String(text).split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) => (/^\*\*[^*]+\*\*$/.test(part) ? { text: part.slice(2, -2), bold: true } : { text: part, bold: false }));
  }

  function drawRich(text, x, size, maxWidth, { face = null, color = INK, lineGap = 4 } = {}) {
    const plain = String(text).replace(/\*\*/g, "");
    const lines = wrap(plain, face ?? font, size, maxWidth);
    const boldWords = new Set(face ? [] : runs(text).filter((run) => run.bold).flatMap((run) => run.text.split(/\s+/)));
    for (const line of lines) {
      room(size + lineGap);
      let cursor = x;
      for (const word of line.split(" ")) {
        const wordFace = face ?? (boldWords.has(word) ? bold : font);
        page.drawText(word, { x: cursor, y, size, font: wordFace, color });
        cursor += wordFace.widthOfTextAtSize(`${word} `, size);
      }
      y -= size + lineGap;
    }
  }

  function table(rows) {
    const columns = Math.max(...rows.map((row) => row.length));
    const size = columns > 5 ? 7.5 : 8.5;
    const padding = 4;
    const columnWidth = width / columns;
    rows.forEach((row, index) => {
      const face = index === 0 ? bold : font;
      const cells = Array.from({ length: columns }, (_, column) => wrap(String(row[column] ?? "").replace(/\*\*/g, ""), face, size, columnWidth - 2 * padding));
      const height = Math.max(...cells.map((cell) => cell.length)) * (size + 3) + 2 * padding;
      room(height);
      if (index === 0) {
        page.drawRectangle({ x: PAGE.margin, y: y - height + size, width, height, color: rgb(0.93, 0.95, 0.94) });
      }
      cells.forEach((cell, column) => {
        cell.forEach((line, lineIndex) => {
          page.drawText(line, { x: PAGE.margin + column * columnWidth + padding, y: y - padding - lineIndex * (size + 3), size, font: face, color: INK });
        });
      });
      page.drawLine({ start: { x: PAGE.margin, y: y - height + size }, end: { x: PAGE.margin + width, y: y - height + size }, thickness: 0.5, color: RULE });
      y -= height;
    });
    y -= 6;
  }

  newPage();
  return Object.freeze({
    title(text) {
      drawRich(text, PAGE.margin, 17, width, { face: bold, color: ACCENT, lineGap: 5 });
      const day = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Africa/Casablanca" }).format(date);
      drawRich(`Marrakech, le ${day}`, PAGE.margin, 9, width, { face: font, color: MUTED });
      y -= 10;
    },
    block(block) {
      if (block.kind === "space") {
        y -= 6;
      } else if (block.kind === "heading") {
        y -= 6;
        room(30);
        drawRich(block.text, PAGE.margin, block.level <= 1 ? 14 : block.level === 2 ? 12.5 : 11, width, { face: bold, color: block.level <= 2 ? ACCENT : INK });
        y -= 2;
      } else if (block.kind === "bullet") {
        const indent = 14 + block.depth * 14;
        room(14);
        page.drawText("•", { x: PAGE.margin + indent - 10, y, size: 10, font, color: ACCENT });
        drawRich(block.text, PAGE.margin + indent, 10, width - indent);
      } else if (block.kind === "step") {
        room(14);
        page.drawText(`${block.label}.`, { x: PAGE.margin, y, size: 10, font: bold, color: ACCENT });
        drawRich(block.text, PAGE.margin + 18, 10, width - 18);
      } else if (block.kind === "table") {
        table(block.rows);
      } else {
        drawRich(block.text, PAGE.margin, 10, width);
        y -= 2;
      }
    },
    finish() {
      pages.forEach((current, index) => {
        const legal = HKIDS_FIXED_IDENTITY.legalLine;
        const size = 6.5;
        current.drawText(legal, { x: (PAGE.width - font.widthOfTextAtSize(legal, size)) / 2, y: PAGE.margin - 18, size, font, color: MUTED });
        const label = `${title} — page ${index + 1}/${pages.length}`;
        const shown = font.widthOfTextAtSize(label, 7) > width ? `page ${index + 1}/${pages.length}` : label;
        current.drawText(shown, { x: PAGE.width - PAGE.margin - font.widthOfTextAtSize(shown, 7), y: PAGE.margin - 30, size: 7, font, color: MUTED });
      });
    }
  });
}
