import { excelText, readWordText } from "./chat-attachments.js";

// A reference document the direction gives an agent (catalogue, price list,
// procedure, technical sheet), read into text once, at import. Word, Excel and
// text files are read here; a PDF is read by the model, since nothing here
// reads PDF text, and the reading is counted like any other call.

export const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const KINDS = Object.freeze({ pdf: "pdf", docx: "word", xlsx: "excel", txt: "texte", csv: "texte", md: "texte" });

export class ReferenceReadError extends Error {
  constructor(message, code = "AGENT_DOCUMENT_UNREADABLE") {
    super(message);
    this.name = "ReferenceReadError";
    this.code = code;
  }
}

export async function readReferenceFile({ name, data }, { readPdf = null } = {}) {
  const fileName = typeof name === "string" ? name.trim().slice(0, 160) : "";
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? "";
  const kind = KINDS[extension];
  if (!kind) {
    throw new ReferenceReadError(`« ${fileName || "fichier"} » n'est pas pris en charge : PDF, Word (.docx), Excel (.xlsx), texte ou CSV.`, "AGENT_DOCUMENT_TYPE");
  }
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/=]+)$/.exec(typeof data === "string" ? data.trim() : "");
  const bytes = match ? Buffer.from(match[2], "base64") : Buffer.alloc(0);
  if (bytes.length === 0) {
    throw new ReferenceReadError(`« ${fileName} » n'a pas pu être lu.`);
  }
  if (bytes.length > MAX_REFERENCE_BYTES) {
    throw new ReferenceReadError(`« ${fileName} » dépasse ${MAX_REFERENCE_BYTES / 1024 / 1024} Mo.`, "AGENT_DOCUMENT_TOO_LARGE");
  }
  if (kind === "pdf") {
    if (!readPdf) {
      throw new ReferenceReadError("La lecture d'un PDF passe par l'IA : renseignez OPENAI_API_KEY, ou importez le document en Word, Excel ou texte.", "AGENT_DOCUMENT_PDF_UNAVAILABLE");
    }
    return { fileName, kind, text: String(await readPdf({ name: fileName, base64: match[2] })).trim() };
  }
  try {
    const text = kind === "word" ? readWordText(bytes) : kind === "excel" ? excelText(bytes) : bytes.toString("utf8").replace(/^﻿/, "");
    return { fileName, kind, text: text.trim() };
  } catch {
    throw new ReferenceReadError(`« ${fileName} » n'a pas pu être lu : le fichier semble abîmé.`);
  }
}
