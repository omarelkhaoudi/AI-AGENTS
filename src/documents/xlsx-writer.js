import yazl from "yazl";

// A table as an Excel file (.xlsx), written by hand like the Word documents:
// no library beyond the zip. Hiba, 11/11/2026: « exporte-moi ça en Excel ».
//
// What Excel needs to treat the figures as figures: an amount (« 3 200,00 DH »)
// is written as the number 3200 with a DH format, a date (« 10/11/2026 ») as a
// real date, a percentage (« 60 % ») as 0.6. The total row is a SUM formula,
// so it follows when Hiba corrects a cell. The header is frozen and filtered.

const STYLE = Object.freeze({ text: 0, header: 1, amount: 2, date: 3, totalLabel: 4, totalAmount: 5, title: 6, percent: 7, integer: 8 });

// « 3 200,00 DH », « 62699.99 », « -1 200 », « 60 % »: a figure, or null.
export function parseFigure(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? { value, percent: false } : null;
  }
  const text = String(value ?? "").replace(/\*\*/g, "").replace(/[  ]/g, " ").trim();
  const match = /^([-+]?)\s*(\d{1,3}(?:[ .]\d{3})+|\d+)(?:[,.](\d+))?\s*(DH|MAD|dhs?|%)?$/i.exec(text);
  if (!match) {
    return null;
  }
  const number = Number(`${match[1]}${match[2].replace(/[ .]/g, "")}${match[3] ? `.${match[3]}` : ""}`);
  const percent = match[4] === "%";
  return { value: percent ? number / 100 : number, percent };
}

// « 10/11/2026 » → the day Excel counts from 1900 (serial number), or null.
export function parseDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? "").trim());
  if (!match) {
    return null;
  }
  const day = Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  return Number.isNaN(day) ? null : Math.round(day / 86_400_000) + 25_569;
}

// Numbers that are names, not quantities: never summed, kept as written.
const IDENTIFIER = /^(n°|no|num(é|e)ro|r(é|e)f(\.|(é|e)rence)?|t(é|e)l(\.|(é|e)phone)?|ice|code|ann(é|e)e)(?![a-zà-ÿ])/i;

export async function renderXlsx({ title = "", columns, rows, total = false, sheetName = "Tableau" }) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error("Un tableau Excel a besoin d'au moins une colonne.");
  }
  const width = columns.length;
  const body = (rows ?? []).map((row) => Array.from({ length: width }, (_, index) => row?.[index] ?? ""));
  // A column is summed when every filled cell is an amount and its name is not
  // an identifier (a quote number is a figure nobody adds up).
  const summed = columns.map((name, index) => {
    const filled = body.map((row) => row[index]).filter((cell) => String(cell).trim() !== "");
    return filled.length > 0 && !IDENTIFIER.test(String(name).trim()) && filled.every((cell) => parseFigure(cell) && !parseFigure(cell).percent);
  });

  const titleRows = title ? 2 : 0;
  const headerRow = titleRows + 1;
  const firstData = headerRow + 1;
  const lastData = headerRow + body.length;
  const rowsXml = [];
  if (title) {
    rowsXml.push(`<row r="1"><c r="A1" t="inlineStr" s="${STYLE.title}"><is><t>${xml(title)}</t></is></c></row>`);
  }
  rowsXml.push(`<row r="${headerRow}">${columns.map((name, index) => textCell(ref(index, headerRow), name, STYLE.header)).join("")}</row>`);
  body.forEach((row, offset) => {
    const at = firstData + offset;
    rowsXml.push(`<row r="${at}">${row.map((value, index) => valueCell(ref(index, at), value, IDENTIFIER.test(String(columns[index]).trim()))).join("")}</row>`);
  });
  const totalRow = lastData + 1;
  if (total && body.length > 0 && summed.some(Boolean)) {
    const label = summed[0] ? 1 : 0;
    rowsXml.push(`<row r="${totalRow}">${columns.map((_, index) => {
      const cell = ref(index, totalRow);
      if (summed[index]) {
        return `<c r="${cell}" s="${STYLE.totalAmount}"><f>SUM(${ref(index, firstData)}:${ref(index, lastData)})</f></c>`;
      }
      return index === label ? textCell(cell, "Total", STYLE.totalLabel) : `<c r="${cell}" s="${STYLE.totalLabel}"/>`;
    }).join("")}</row>`);
  }

  // Wide enough for the longest value of each column, within reason.
  const widths = columns.map((name, index) => Math.min(60, Math.max(8, String(name).length + 2, ...body.map((row) => String(row[index]).replace(/\*\*/g, "").length + 2))));
  const lastColumn = letters(width - 1);
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${firstData}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((value, index) => `<col min="${index + 1}" max="${index + 1}" width="${value}" customWidth="1"/>`).join("")}</cols>
<sheetData>${rowsXml.join("")}</sheetData>
${body.length > 0 ? `<autoFilter ref="A${headerRow}:${lastColumn}${lastData}"/>` : ""}
</worksheet>`;

  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(CONTENT_TYPES), "[Content_Types].xml");
  zip.addBuffer(Buffer.from(ROOT_RELS), "_rels/.rels");
  zip.addBuffer(Buffer.from(workbook(sheetName, body.length > 0 ? `'${safeSheetName(sheetName)}'!$A$${headerRow}:$${lastColumn}$${lastData}` : null)), "xl/workbook.xml");
  zip.addBuffer(Buffer.from(WORKBOOK_RELS), "xl/_rels/workbook.xml.rels");
  zip.addBuffer(Buffer.from(STYLES), "xl/styles.xml");
  zip.addBuffer(Buffer.from(sheet), "xl/worksheets/sheet1.xml");
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks = [];
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

// A file name Windows accepts, dated: « 2026-11-11_devis-du-mois.xlsx ».
export function xlsxFileName(title, today = new Date()) {
  const slug = String(title || "tableau").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "tableau";
  return `${today.toISOString().slice(0, 10)}_${slug}.xlsx`;
}

function valueCell(cell, value, identifier) {
  const text = String(value ?? "").replace(/\*\*/g, "").trim();
  if (text === "") {
    return "";
  }
  const day = parseDate(text);
  if (day !== null) {
    return `<c r="${cell}" s="${STYLE.date}"><v>${day}</v></c>`;
  }
  const figure = identifier ? null : parseFigure(value);
  if (figure) {
    const style = figure.percent ? STYLE.percent : Number.isInteger(figure.value) && !/[,.]\d|DH|MAD|dh/i.test(text) ? STYLE.integer : STYLE.amount;
    return `<c r="${cell}" s="${style}"><v>${figure.value}</v></c>`;
  }
  return textCell(cell, text, STYLE.text);
}

function textCell(cell, text, style) {
  return `<c r="${cell}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(String(text).replace(/\*\*/g, ""))}</t></is></c>`;
}

function letters(index) {
  let name = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }
  return name;
}

function ref(column, row) {
  return `${letters(column)}${row}`;
}

function xml(text) {
  return String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeSheetName(name) {
  return String(name).replace(/[\[\]:*?/\\']/g, " ").trim().slice(0, 31) || "Tableau";
}

function workbook(name, filter) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xml(safeSheetName(name))}" sheetId="1" r:id="rId1"/></sheets>
${filter ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${xml(filter)}</definedName></definedNames>` : ""}
</workbook>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

// Arial throughout; the header in the green of the H-KIDS documents.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00&quot; DH&quot;"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/></numFmts>
<fonts count="4">
<font><sz val="10"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="10"/><name val="Arial"/><family val="2"/></font>
<font><b/><sz val="13"/><name val="Arial"/><family val="2"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF24584A"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8F0EC"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF24584A"/></top><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
