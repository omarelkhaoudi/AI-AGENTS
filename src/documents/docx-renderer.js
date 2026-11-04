import { readFile } from "node:fs/promises";
import yazl from "yazl";
import { DELIVERY_NOTE_PROFILES, HKIDS_DOCUMENT_TYPES } from "./document-schema.js";
import {
  HKIDS_FIXED_IDENTITY,
  HKIDS_LOGO_PATH,
  deliveryNoteReferences,
  documentTitleFor,
  referenceLabelFor
} from "./hkids-template.js";
import { formatMoney, invoiceDiscountLabel, invoiceShowsLineTaxes } from "./pdf-renderer.js";
import { createQuotePresentation } from "./quote-presentation.js";

export async function renderHkidsDocx(document) {
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

function isGoodsOnlyDeliveryNote(document) {
  return document.documentType === HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE
    && document.deliveryNoteProfile === DELIVERY_NOTE_PROFILES.GOODS_ONLY;
}

function createDocumentXml(document) {
  if (document.documentType === HKIDS_DOCUMENT_TYPES.QUOTE) {
    return wrapDocument(createQuoteBody(document));
  }
  if (isGoodsOnlyDeliveryNote(document)) {
    return wrapDocument(createGoodsOnlyDeliveryNoteBody(document));
  }

  const invoice = document.documentType === HKIDS_DOCUMENT_TYPES.INVOICE;
  // An invoice discounted by a fixed amount states its lines in HT only, as its
  // PDF does: invoiceShowsLineTaxes says why.
  const htOnly = invoice && !invoiceShowsLineTaxes(document);
  const headers = htOnly
    ? ["Désignation", "Qté", "Unité", "PU HT", "Total HT"]
    : invoice
      ? HKIDS_FIXED_IDENTITY.invoiceColumns
      : ["Désignation", "Qté", "Prix unitaire HT", "Montant HT"];
  const rows = document.items.map((item) => tr(htOnly
    ? [
      item.designation,
      String(item.quantity),
      item.unit,
      formatMoney(item.unitPriceHt),
      formatMoney(item.netAmountHt)
    ]
    : invoice
    ? [
      item.designation,
      String(item.quantity),
      item.unit,
      formatMoney(item.unitPriceHt),
      formatMoney(item.tva),
      formatMoney(item.unitPriceTtc),
      // The net line amount: on a discounted line the gross stays readable in
      // "Pu Brut", and the rebate is stated in the totals below.
      formatMoney(item.netAmountHt),
      formatMoney(item.totalTtc)
    ]
    : [
      item.designation,
      String(item.quantity),
      formatMoney(item.unitPriceHt),
      formatMoney(item.amountHt)
    ])).join("");

  // A discounted invoice states the gross, the rebate and the net, as the quote
  // does. Every figure is the engine's; an invoice without a rebate keeps its
  // three usual rows.
  const discountLabel = invoiceDiscountLabel(document);
  const totalRows = discountLabel
    ? [
      ["TOTAL BRUT HT", formatMoney(document.totals.totalBrutHt)],
      [discountLabel, formatMoney(document.totals.totalDiscount)],
      ["TOTAL NET HT", formatMoney(document.totals.totalHt)],
      ["TOTAL TVA 20 %", formatMoney(document.totals.tva)],
      ["TOTAL TTC", formatMoney(document.totals.totalTtc)]
    ]
    : [
      ["TOTAL HT", formatMoney(document.totals.totalHt)],
      ["TOTAL TVA 20 %", formatMoney(document.totals.tva)],
      ["TOTAL TTC", formatMoney(document.totals.totalTtc)]
    ];
  const totals = totalRows.map((row, index) => tr(row, { bold: index === totalRows.length - 1 })).join("");

  const objectLine = document.object ? p(`Objet : ${document.object}`) : "";
  const noteLine = document.note ? p(`Note : ${document.note}`) : "";
  if (document.documentType === HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER) {
    return wrapDocument(purchaseOrderBody(document, { headers, rows, totals, objectLine, noteLine }));
  }
  const body = [
    p(HKIDS_FIXED_IDENTITY.legalLine, { align: "center", size: 15 }),
    logo(),
    p(HKIDS_FIXED_IDENTITY.companyName, { bold: true, align: "right" }),
    p(HKIDS_FIXED_IDENTITY.addressLines.join(" "), { align: "right" }),
    p(`E-mail : ${HKIDS_FIXED_IDENTITY.email}`, { align: "right" }),
    p(`Tél : ${HKIDS_FIXED_IDENTITY.phone}`, { align: "right" }),
    p(`${documentTitleFor(document.documentType)} N° ${document.documentNumber}`, { bold: true, size: 34 }),
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

  return wrapDocument(body);
}

// The Word copy of a purchase order carries the same text as the PDF. The
// reference visual is left to the PDF.
function purchaseOrderBody(document, { headers, rows, totals, objectLine, noteLine }) {
  const specifications = document.specifications ?? [];
  const instalments = document.payment.instalments ?? [];
  return [
    logo(),
    p(HKIDS_FIXED_IDENTITY.companyName, { bold: true, align: "right" }),
    ...HKIDS_FIXED_IDENTITY.addressLines.map((line) => p(line, { align: "right" })),
    p(`E-mail : ${HKIDS_FIXED_IDENTITY.email}`, { align: "right" }),
    p(`Tél : ${HKIDS_FIXED_IDENTITY.phone}`, { align: "right" }),
    p(`${documentTitleFor(document.documentType)} N° ${document.documentNumber}`, { bold: true, size: 34 }),
    objectLine,
    p(`Date : ${displayDate(document.date)}`),
    referenceLabelFor(document) ? p(referenceLabelFor(document)) : "",
    p("Adressé à :", { bold: true }),
    p(document.client.name),
    p(document.client.address),
    table(tr(headers, { bold: true, shade: "7FA696", white: true }) + rows),
    p(""),
    table(totals),
    ...(specifications.length > 0
      ? [p("CARACTÉRISTIQUES ET FINITIONS", { bold: true }), ...specifications.map((line) => p(`• ${line}`))]
      : []),
    p("CONDITIONS DE RÈGLEMENT", { bold: true }),
    ...instalments.map((instalment) => p(`${instalment.percent} % ${instalment.due} : ${formatMoney(instalment.amount)}.`)),
    document.payment.method ? p(`Moyen de paiement : ${document.payment.method}`) : "",
    noteLine,
    p("BON POUR ACCORD", { bold: true }),
    p("Pour H KIDS — Nom, signature et cachet :"),
    p(`Le client — Nom : ${document.client.name} — Signature :`),
    p(HKIDS_FIXED_IDENTITY.footerMention, { size: 17 }),
    p(HKIDS_FIXED_IDENTITY.legalLine, { size: 15 })
  ].join("");
}

function wrapDocument(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`;
}

/**
 * The editable quote. It reads the same view as the PDF renderer, so the two
 * files state the same thing by construction rather than by inspection, and
 * neither of them computes an amount.
 */
function createQuoteBody(document) {
  const view = createQuotePresentation(document);

  const rows = view.lines.map((item) => tr([...item.cells])).join("");
  const totals = view.totalRows
    .map((row, index) => tr([...row], { bold: index === view.totalRows.length - 1 }))
    .join("");

  const scheduleBlock = view.scheduleAvailable
    ? table(
      tr(["Part", "Condition", "Montant TTC"], { bold: true, shade: "7FA696", white: true })
      + view.installments.map((installment) => tr([...installment.cells])).join("")
    )
    // Not filled in with the standard plan: a schedule nobody chose is not a
    // schedule.
    : p("Échéancier : non défini.");

  return [
    p(view.issuer.legalLine, { align: "center", size: 15 }),
    logo(),
    p(view.issuer.name, { bold: true, align: "right" }),
    p(view.issuer.addressLines.join(" "), { align: "right" }),
    p(`E-mail : ${view.issuer.email}`, { align: "right" }),
    p(`Tél : ${view.issuer.phone}`, { align: "right" }),
    // An assigned number is part of the title; the register's sentence for a
    // number not given yet keeps a line of its own.
    p(view.numberAssigned ? `${view.title} N° ${view.numberText}` : view.title, { bold: true, size: 34 }),
    view.numberAssigned ? "" : p(`N° : ${view.numberText}`),
    p(`Date : ${view.dateText}`),
    p("Adressé à :", { bold: true }),
    p(view.client.name),
    p(view.client.address),
    table(tr([...view.columns], { bold: true, shade: "7FA696", white: true }) + rows),
    p(""),
    table(totals),
    p(""),
    p("CONDITIONS DE RÈGLEMENT", { bold: true }),
    p(`Moyen de paiement : ${view.paymentMethod}`),
    p(view.paymentTerms),
    scheduleBlock,
    p(view.footerMention, { size: 17 })
  ].join("");
}

/**
 * The delivery note of a commercial file: what is delivered, and nothing about
 * what it costs.
 *
 * No total, no VAT, no payment block and no price column — not hidden, absent.
 * The document itself carries no amount, so there is none to read here: this
 * function never touches document.totals or document.payment.
 */
function createGoodsOnlyDeliveryNoteBody(document) {
  const rows = document.items
    .map((item) => tr([item.designation ?? "", String(item.quantity), item.unit ?? ""]))
    .join("");

  // Only the references the document holds. None is invented, and a missing one
  // prints nothing rather than an empty label.
  const references = deliveryNoteReferences(document)
    .map((reference) => p(`${reference.label} : ${reference.value}`))
    .join("");

  return [
    p(HKIDS_FIXED_IDENTITY.legalLine, { align: "center", size: 15 }),
    logo(),
    p(HKIDS_FIXED_IDENTITY.companyName, { bold: true, align: "right" }),
    p(HKIDS_FIXED_IDENTITY.addressLines.join(" "), { align: "right" }),
    p(`E-mail : ${HKIDS_FIXED_IDENTITY.email}`, { align: "right" }),
    p(`Tél : ${HKIDS_FIXED_IDENTITY.phone}`, { align: "right" }),
    p(`${documentTitleFor(document.documentType)} N° ${document.documentNumber}`, { bold: true, size: 34 }),
    p("Adressé à :", { bold: true }),
    p(document.client.name),
    p(document.client.address),
    references,
    table(tr(["Désignation", "Qté", "Unité"], { bold: true, shade: "7FA696", white: true }) + rows),
    p(""),
    // Written exactly as the document carries it: a delivery nobody has
    // scheduled reads "Date de livraison : à définir".
    p(document.deliveryDateText, { bold: true }),
    p(HKIDS_FIXED_IDENTITY.footerMention, { size: 17 })
  ].join("");
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
