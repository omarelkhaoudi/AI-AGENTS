import { readXlsxSheets, readZipEntries } from "../business-memory/xlsx-reader.js";

// Documents the direction joins to a message for the Director: a client's
// plan, a supplier's quote, a list of orders. The model reads a PDF itself,
// pictures included; Word, Excel and text files are turned into text here,
// since the model takes no other file type.

export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 40_000;
// What later messages keep of a document read as text: enough to answer a
// follow-up question without sending the whole file again each time.
const REMEMBERED_TEXT_CHARS = 4_000;

const KINDS = Object.freeze({
  pdf: "pdf",
  docx: "word",
  xlsx: "excel",
  txt: "text",
  csv: "text",
  md: "text"
});

export class ChatAttachmentError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChatAttachmentError";
  }
}

// Returns, for each file, what the model reads in this message and what the
// conversation remembers of it afterwards.
export function readAttachments(files, { firstNumber = 1 } = {}) {
  if (files === undefined || files === null) {
    return [];
  }
  if (!Array.isArray(files) || files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new ChatAttachmentError(`Joignez au plus ${MAX_ATTACHMENTS_PER_MESSAGE} documents par message.`);
  }
  return files.map((file, index) => readAttachment(file, firstNumber + index));
}

function readAttachment(file, number) {
  const name = typeof file?.name === "string" ? file.name.trim().slice(0, 160) : "";
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  const kind = KINDS[extension];
  if (!kind) {
    const hint = extension === "doc" || extension === "xls" ? " Enregistrez-le au format .docx ou .xlsx, ou en PDF." : "";
    throw new ChatAttachmentError(`« ${name || "fichier"} » n'est pas pris en charge (PDF, Word .docx, Excel .xlsx, texte ou CSV).${hint}`);
  }
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/=]+)$/.exec(typeof file.data === "string" ? file.data.trim() : "");
  const bytes = match ? Buffer.from(match[2], "base64") : Buffer.alloc(0);
  if (bytes.length === 0) {
    throw new ChatAttachmentError(`« ${name} » n'a pas pu être lu.`);
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new ChatAttachmentError(`« ${name} » dépasse ${MAX_ATTACHMENT_BYTES / 1024 / 1024} Mo.`);
  }

  const label = `Document n° ${number} « ${name} »`;
  if (kind === "pdf") {
    return Object.freeze({
      name,
      kind,
      part: { type: "input_file", filename: name, file_data: `data:application/pdf;base64,${match[2]}` },
      remembered: `[${label} : PDF lu à ce message.]`
    });
  }

  let text;
  try {
    text = kind === "word" ? wordText(bytes) : kind === "excel" ? excelText(bytes) : bytes.toString("utf8").replace(/^﻿/, "");
  } catch {
    throw new ChatAttachmentError(`« ${name} » n'a pas pu être lu : le fichier semble abîmé.`);
  }
  text = text.trim();
  const clipped = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[… document coupé : trop long]` : text;
  return Object.freeze({
    name,
    kind,
    part: { type: "input_text", text: `[${label}]\n${clipped || "(document vide)"}` },
    remembered: `[${label}, lu à ce message. Début :]\n${text.slice(0, REMEMBERED_TEXT_CHARS)}${text.length > REMEMBERED_TEXT_CHARS ? "\n[…]" : ""}`
  });
}

// The paragraphs of a .docx, tables included, one per line.
function wordText(bytes) {
  const xml = readZipEntries(bytes).get("word/document.xml")?.toString("utf8");
  if (!xml) {
    throw new Error("not a Word document");
  }
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br[^>]*\/>/g, "\n")
    // A table cell holds its own paragraphs: one row of a table is one line.
    .replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (cell) => `${cell.replace(/<\/w:p>/g, " ")} | `)
    .replace(/ \| <\/w:tr>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/ +\| /g, " | ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

// Each sheet as a table: its header row, then one line per row.
function excelText(bytes) {
  return Object.entries(readXlsxSheets(bytes))
    .map(([sheet, rows]) => {
      const headers = [...new Set(rows.flatMap((row) => Object.keys(row.values)))];
      const lines = rows.map((row) => headers.map((header) => String(row.values[header] ?? "")).join(" | "));
      return [`Feuille « ${sheet} » (${rows.length} lignes)`, headers.join(" | "), ...lines].join("\n");
    })
    .join("\n\n");
}
