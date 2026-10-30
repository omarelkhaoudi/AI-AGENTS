import { inflateRawSync } from "node:zlib";

// A minimal .xlsx reader, enough to read a workbook a person filled in by hand:
// sheet names, text, numbers and booleans, by header. It does not evaluate
// formulas (it reads the value Excel cached, if any) and it does not read
// styles, so a date arrives as its Excel serial number and the caller, who
// knows which columns hold dates, converts it with excelSerialToIsoDate.
//
// Written here rather than taken from a package because reading cell values is
// a small, closed problem, and the project keeps its dependency list short.

export class XlsxReadError extends Error {
  constructor(message, code = "XLSX_UNREADABLE") {
    super(message);
    this.name = "XlsxReadError";
    this.code = code;
  }
}

// Returns { [sheetName]: Array<{ rowNumber, values: { [header]: value } }> }.
// The first row of each sheet is its header row; rows with no value at all are
// left out.
export function readXlsxSheets(buffer) {
  const files = unzip(buffer);
  const text = (path) => {
    const bytes = files.get(path);
    return bytes ? bytes.toString("utf8") : null;
  };

  const workbook = text("xl/workbook.xml");
  if (!workbook) {
    throw new XlsxReadError("The file is not an Excel workbook (.xlsx).");
  }
  const relations = new Map(
    matchAll(text("xl/_rels/workbook.xml.rels") ?? "", /<Relationship\b([^>]*)\/?>/g)
      .map((attributes) => [attribute(attributes, "Id"), attribute(attributes, "Target")])
  );
  const sharedStrings = matchAll(text("xl/sharedStrings.xml") ?? "", /<si>([\s\S]*?)<\/si>/g).map(readRichText);

  const sheets = {};
  for (const attributes of matchAll(workbook, /<sheet\b([^>]*)\/?>/g)) {
    const name = decodeXml(attribute(attributes, "name") ?? "");
    const target = relations.get(attribute(attributes, "r:id"));
    if (!target) {
      continue;
    }
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const xml = text(path);
    sheets[name] = xml ? readSheetRows(xml, sharedStrings) : [];
  }
  return sheets;
}

// Excel counts days from 1899-12-30 (the 1900 leap-year bug is folded into
// that origin). Only the date part is kept.
export function excelSerialToIsoDate(serial) {
  const days = Math.floor(Number(serial));
  if (!Number.isFinite(days)) {
    return null;
  }
  return new Date(Date.UTC(1899, 11, 30) + days * 86400000).toISOString().slice(0, 10);
}

function readSheetRows(xml, sharedStrings) {
  const grid = [];
  for (const [rowAttributes, rowBody] of matchAllPairs(xml, /<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(attribute(rowAttributes, "r"));
    const cells = new Map();
    for (const [cellAttributes, cellBody] of matchAllPairs(rowBody, /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const value = readCell(cellAttributes, cellBody ?? "", sharedStrings);
      if (value !== null) {
        cells.set(columnIndex(attribute(cellAttributes, "r")), value);
      }
    }
    grid.push({ rowNumber, cells });
  }

  const header = grid.find((row) => row.rowNumber === 1) ?? grid[0];
  if (!header) {
    return [];
  }
  const headers = new Map([...header.cells].map(([index, value]) => [index, String(value).trim()]));
  return grid
    .filter((row) => row !== header && row.cells.size > 0)
    .map((row) => {
      const values = {};
      for (const [index, name] of headers) {
        if (row.cells.has(index)) {
          values[name] = row.cells.get(index);
        }
      }
      return { rowNumber: row.rowNumber, values };
    })
    .filter((row) => Object.values(row.values).some((value) => value !== ""));
}

function readCell(attributes, body, sharedStrings) {
  const type = attribute(attributes, "t");
  if (type === "inlineStr") {
    const inline = /<is>([\s\S]*?)<\/is>/.exec(body);
    return inline ? readRichText(inline[1]) : null;
  }
  const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
  if (raw === undefined) {
    return null;
  }
  if (type === "s") {
    return sharedStrings[Number(raw)] ?? null;
  }
  if (type === "str" || type === "e") {
    return decodeXml(raw);
  }
  if (type === "b") {
    return raw === "1";
  }
  const number = Number(raw);
  return Number.isFinite(number) ? number : decodeXml(raw);
}

function readRichText(xml) {
  return matchAll(xml, /<t\b[^>]*>([\s\S]*?)<\/t>/g).map(decodeXml).join("");
}

function columnIndex(reference = "") {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? "";
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}

function attribute(attributes, name) {
  const escaped = name.replace(":", "\\:");
  return new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`).exec(attributes)?.[1] ?? null;
}

function matchAll(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => match[1]);
}

function matchAllPairs(text, pattern) {
  return [...text.matchAll(pattern)].map((match) => [match[1], match[2]]);
}

function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Reads the central directory, which is authoritative: local headers may defer
// their sizes to a data descriptor, the central directory never does.
function unzip(buffer) {
  const end = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map();

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new XlsxReadError("The workbook archive is damaged.");
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      files.set(name, Buffer.from(data));
    } else if (method === 8) {
      files.set(name, inflateRawSync(data));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function findEndOfCentralDirectory(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new XlsxReadError("The file is not an Excel workbook (.xlsx).");
  }
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new XlsxReadError("The file is not an Excel workbook (.xlsx).");
}
