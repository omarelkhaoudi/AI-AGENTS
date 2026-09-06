import { readFile } from "node:fs/promises";
import yazl from "yazl";
import { HKIDS_DOCUMENT_TYPES } from "./document-schema.js";
import { HKIDS_FIXED_IDENTITY, HKIDS_LOGO_PATH, assertHkidsTemplateAvailable, documentTitleFor, referenceLabelFor } from "./hkids-template.js";
import { formatMoney } from "./pdf-renderer.js";

export async function renderHkidsDocx(document) {
  await assertHkidsTemplateAvailable(document.documentType);
  const zip = new yazl.ZipFile();
  const logoBytes = await extractLogoBytes();
  const documentXml = createDocumentXml(document);

  zip.addBuffer(Buffer.from(contentTypes()), "[Content_Types].xml");
  zip.addBuffer(Buffer.from(rootRels()), "_rels/.rels");
  zip.addBuffer(Buffer.from(documentRels()), "word/_rels/document.xml.rels");
  zip.addBuffer(Buffer.from(stylesXml()), "word/styles.xml");
  zip.addBuffer(Buffer.from(documentXml), "word/document.xml");
  if (logoBytes) {
    zip.addBuffer(logoBytes, "word/media/hkids-logo.jpg");
  }
  zip.end();

  return new Promise((resolve, reject) => {
    const chunks = [];
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
}

function createDocumentXml(document) {
  const invoice = document.documentType === HKIDS_DOCUMENT_TYPES.INVOICE;
  const headers = invoice
    ? ["Désignation", "Qté", "Unité", "Pu Brut", "TVA", "Pu TTC", "Total HT", "Total TTC"]
    : ["Désignation", "Qté", "Prix unitaire HT", "Montant HT"];
  const rows = document.items.map((item) => tr(invoice
    ? [
      item.designation,
      String(item.quantity),
      item.unit,
      formatMoney(item.unitPriceHt),
      formatMoney(item.tva),
      formatMoney(item.unitPriceTtc),
      formatMoney(item.amountHt),
      formatMoney(item.totalTtc)
    ]
    : [
      item.designation,
      String(item.quantity),
      formatMoney(item.unitPriceHt),
      formatMoney(item.amountHt)
    ])).join("");

  const totals = [
    ["TOTAL HT", formatMoney(document.totals.totalHt)],
    ["TOTAL TVA 20 %", formatMoney(document.totals.tva)],
    ["TOTAL TTC", formatMoney(document.totals.totalTtc)]
  ].map((row, index) => tr(row, { bold: index === 2 })).join("");

  const objectLine = document.object ? p(`Objet : ${document.object}`) : "";
  const noteLine = document.note ? p(`Note : ${document.note}`) : "";
  const body = [
    p(HKIDS_FIXED_IDENTITY.legalLine, { align: "center", size: 15 }),
    logo(),
    p(HKIDS_FIXED_IDENTITY.companyName, { bold: true, align: "right" }),
    p(HKIDS_FIXED_IDENTITY.addressLines.join(" "), { align: "right" }),
    p(`E-mail : ${HKIDS_FIXED_IDENTITY.email}`, { align: "right" }),
    p(`Tél : ${HKIDS_FIXED_IDENTITY.phone}`, { align: "right" }),
    p(documentTitleFor(document.documentType), { bold: true, size: 34 }),
    p(`N° : ${document.documentNumber}`, { bold: true }),
    p(`Date : ${displayDate(document.date)}`),
    referenceLabelFor(document) ? p(referenceLabelFor(document)) : "",
    p("Adressé à :", { bold: true }),
    p(document.client.name),
    p(document.client.address),
    objectLine,
    table(tr(headers, { bold: true, shade: "7FA696", white: true }) + rows),
    p(""),
    table(totals),
    p("MENTIONS", { bold: true }),
    noteLine,
    p(`Moyen de paiement : ${document.payment.method}`),
    p(`Conditions de règlement : ${document.payment.terms}`),
    p(HKIDS_FIXED_IDENTITY.footerMention, { size: 17 })
  ].join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`;
}

function p(text = "", { bold = false, align = null, size = 20 } = {}) {
  const b = bold ? "<w:b/>" : "";
  const jc = align ? `<w:pPr><w:jc w:val="${align}"/></w:pPr>` : "";
  return `<w:p>${jc}<w:r><w:rPr>${b}<w:sz w:val="${size}"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr><w:t>${escapeXml(text)}</w:t></w:r></w:p>`;
}

function table(rows) {
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="6" w:space="0" w:color="D9D9D9"/><w:left w:val="single" w:sz="6" w:space="0" w:color="D9D9D9"/><w:bottom w:val="single" w:sz="6" w:space="0" w:color="D9D9D9"/><w:right w:val="single" w:sz="6" w:space="0" w:color="D9D9D9"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="E7E7E7"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="E7E7E7"/></w:tblBorders></w:tblPr>${rows}</w:tbl>`;
}

function tr(values, { bold = false, shade = null, white = false } = {}) {
  return `<w:tr>${values.map((value, index) => tc(value, { bold, shade, white, align: index === 0 ? "left" : "center" })).join("")}</w:tr>`;
}

function tc(value, { bold = false, shade = null, white = false, align = "left" } = {}) {
  const b = bold ? "<w:b/>" : "";
  const shd = shade ? `<w:shd w:fill="${shade}"/>` : "";
  const color = white ? '<w:color w:val="FFFFFF"/>' : "";
  return `<w:tc><w:tcPr><w:tcW w:w="2300" w:type="dxa"/>${shd}</w:tcPr><w:p><w:pPr><w:jc w:val="${align}"/></w:pPr><w:r><w:rPr>${b}${color}<w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr><w:t>${escapeXml(value)}</w:t></w:r></w:p></w:tc>`;
}

function logo() {
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1944000" cy="1260000"/><wp:docPr id="1" name="Hkids logo"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="hkids-logo.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdLogo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1944000" cy="1260000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

// An override that is set to an empty string is not an override. `??` alone let
// HKIDS_LOGO_PATH="" through, and readFile("") fails: a variable left blank in a
// copied .env would have broken every Word document.
async function extractLogoBytes() {
  const configured = typeof process.env.HKIDS_LOGO_PATH === "string" ? process.env.HKIDS_LOGO_PATH.trim() : "";
  return readFile(configured === "" ? HKIDS_LOGO_PATH : configured);
}

function contentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
}

function rootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
}

function documentRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/hkids-logo.jpg"/></Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="20"/></w:rPr></w:style></w:styles>`;
}

function displayDate(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${day}/${month}/${year}`;
  }
  return value;
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    "\"": "&quot;"
  })[char]);
}
