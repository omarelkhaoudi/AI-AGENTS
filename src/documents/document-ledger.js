import { HKIDS_DOCUMENT_TYPES } from "./document-schema.js";
import { normalizeDocumentInput } from "./document-validation.js";

// The chain of one sale, read from the documents actually issued: the quote,
// the purchase order made from it, the delivery notes and the invoices. Each
// document names the one before it (reference devis, reference BL); nothing is
// linked by guesswork, and an absent reference stays absent.
//
// It answers two questions. Where does this sale stand (quote sent, ordered,
// delivered, invoiced in part or in full)? And may this invoice be issued
// without invoicing the sale twice? The second is the guard behind every
// invoice preview: the invoices of one sale never add up to more than the sale.

const { QUOTE, PURCHASE_ORDER, DELIVERY_NOTE, INVOICE, CREDIT_NOTE, PAYMENT_RECEIPT } = HKIDS_DOCUMENT_TYPES;
// A cent of rounding between documents is not an overcharge.
const TOLERANCE = 0.01;

export function summarizeIssuedContent({ type, number, stem }, input) {
  const document = normalizeDocumentInput({ ...input, documentType: type });
  return Object.freeze({
    type,
    number: String(number),
    stem,
    date: document.date,
    client: document.client.name,
    object: document.object ?? "",
    totalTtc: Number.isFinite(document.totals.totalTtc) ? document.totals.totalTtc : null,
    quoteReference: document.quoteReference,
    deliveryNoteReference: bareDeliveryNoteNumber(document.deliveryNoteReference),
    invoiceReference: document.invoiceReference,
    source: "content"
  });
}

// A document issued before its content was kept: what its Word file prints.
export function summarizeIssuedWord({ type, number, stem }, text = "") {
  const lines = text.split("\n").map((line) => line.trim());
  const addressedTo = lines.indexOf("Adressé à :");
  const signedBy = /Le client — Nom : (.+?) —/.exec(text)?.[1] ?? "";
  return Object.freeze({
    type,
    number: String(number),
    stem,
    date: /Date : (\d{2}\/\d{2}\/\d{4})/.exec(text)?.[1] ?? "",
    client: (addressedTo >= 0 ? lines[addressedTo + 1] : "") || signedBy,
    object: /^Objet : (.+)$/m.exec(text)?.[1].trim() ?? "",
    totalTtc: parseAmount(/TOTAL TTC \| ([^|\n]+?) DH/.exec(text)?.[1]),
    quoteReference: /Référence devis\s*:\s*([^\s|]+)/.exec(text)?.[1] ?? "",
    deliveryNoteReference: bareDeliveryNoteNumber(/Référence BL\s*:\s*([^|\n]+)/.exec(text)?.[1] ?? ""),
    invoiceReference: /Référence facture\s*:\s*([^\s|]+)/.exec(text)?.[1] ?? "",
    source: "word"
  });
}

// The sale a document belongs to, and where it stands. Null when the document
// was never issued and is not a quote that others refer to.
export function dossierOf(documents, { type, number }) {
  const wanted = String(number);
  const find = (kind, value) => documents.filter((entry) => entry.type === kind && entry.number === String(value));
  const start = find(type, wanted);
  if (start.length === 0 && !(type === QUOTE && documents.some((entry) => entry.quoteReference === wanted))) {
    return null;
  }

  let quoteNumber = type === QUOTE ? wanted : firstOf(start, "quoteReference");
  let deliveryNoteNumber = type === DELIVERY_NOTE ? wanted : firstOf(start, "deliveryNoteReference");
  // A credit note or a receipt may name only an invoice: the sale is the one
  // that invoice belongs to.
  const settledInvoiceNumber = [CREDIT_NOTE, PAYMENT_RECEIPT].includes(type) ? firstOf(start, "invoiceReference") : "";
  if (!quoteNumber && !deliveryNoteNumber && settledInvoiceNumber) {
    const invoice = find(INVOICE, settledInvoiceNumber);
    quoteNumber = firstOf(invoice, "quoteReference");
    deliveryNoteNumber = firstOf(invoice, "deliveryNoteReference");
  }
  if (!quoteNumber && deliveryNoteNumber) {
    quoteNumber = firstOf(find(DELIVERY_NOTE, deliveryNoteNumber), "quoteReference");
  }

  let quotes = [];
  let orders = [];
  let deliveryNotes = [];
  let invoices = [];
  if (quoteNumber) {
    quotes = find(QUOTE, quoteNumber);
    orders = documents.filter((entry) => entry.type === PURCHASE_ORDER && entry.quoteReference === quoteNumber);
    deliveryNotes = documents.filter((entry) => entry.type === DELIVERY_NOTE && entry.quoteReference === quoteNumber);
    const deliveryNoteNumbers = new Set([...deliveryNotes.map((entry) => entry.number), ...(deliveryNoteNumber ? [deliveryNoteNumber] : [])]);
    invoices = documents.filter((entry) => entry.type === INVOICE
      && (entry.quoteReference === quoteNumber || deliveryNoteNumbers.has(entry.deliveryNoteReference)));
  } else if (deliveryNoteNumber) {
    deliveryNotes = find(DELIVERY_NOTE, deliveryNoteNumber);
    invoices = documents.filter((entry) => entry.type === INVOICE && entry.deliveryNoteReference === deliveryNoteNumber);
  } else {
    // A document that names nothing before it is a sale of its own.
    orders = type === PURCHASE_ORDER ? start : [];
    invoices = type === INVOICE ? start : settledInvoiceNumber ? find(INVOICE, settledInvoiceNumber) : [];
  }

  const anomalies = [];
  const billed = latestPerNumber(invoices, anomalies, "La facture");
  latestPerNumber(orders, anomalies, "Le bon de commande");

  // What was given back on the invoices of the sale, and what the client paid
  // on it: each names an invoice of the sale, or the quote itself.
  const invoiceNumbers = new Set(billed.map((entry) => entry.number));
  const ofThisSale = (entry) => invoiceNumbers.has(entry.invoiceReference) || (Boolean(quoteNumber) && entry.quoteReference === quoteNumber);
  const credits = latestPerNumber(documents.filter((entry) => entry.type === CREDIT_NOTE && ofThisSale(entry)), anomalies, "L'avoir");
  const receipts = latestPerNumber(documents.filter((entry) => entry.type === PAYMENT_RECEIPT && ofThisSale(entry)), anomalies, "Le reçu");
  const ceilingFrom = [
    ["devis", quotes],
    ["bon de commande", orders],
    ["bon de livraison", deliveryNotes]
  ].find(([, entries]) => entries.some((entry) => entry.totalTtc !== null));
  const ceiling = ceilingFrom ? ceilingFrom[1].find((entry) => entry.totalTtc !== null).totalTtc : null;
  const invoicedGross = roundMoney(billed.reduce((sum, entry) => sum + (entry.totalTtc ?? 0), 0));
  const credited = roundMoney(credits.reduce((sum, entry) => sum + (entry.totalTtc ?? 0), 0));
  // What remains invoiced once the credit notes are taken off.
  const invoiced = roundMoney(invoicedGross - credited);
  const received = roundMoney(receipts.reduce((sum, entry) => sum + (entry.totalTtc ?? 0), 0));
  if (billed.some((entry) => entry.totalTtc === null)) {
    anomalies.push("Le montant d'une facture du dossier n'a pas pu être lu : le total facturé est incomplet.");
  }
  if (quoteNumber && quotes.length === 0) {
    anomalies.push(`Le devis n° ${quoteNumber} n'a pas été généré par le cockpit (fait à la main ?) : son montant n'est pas connu.`);
  }

  return Object.freeze({
    quoteNumber: quoteNumber || null,
    quote: quotes.at(-1) ?? null,
    orders: Object.freeze(orders),
    deliveryNotes: Object.freeze(deliveryNotes),
    invoices: Object.freeze(billed),
    creditNotes: Object.freeze(credits),
    receipts: Object.freeze(receipts),
    ceiling,
    ceilingFrom: ceilingFrom?.[0] ?? null,
    invoicedGross,
    credited,
    invoiced,
    remaining: ceiling === null ? null : roundMoney(Math.max(0, ceiling - invoiced)),
    received,
    // What the client still owes on the sale, whatever has been invoiced.
    remainingToPay: ceiling === null ? null : roundMoney(Math.max(0, ceiling - received)),
    stage: stageOf({ quoteNumber, orders, deliveryNotes, invoiced, ceiling, received }),
    anomalies: Object.freeze(anomalies)
  });
}

// The documents of one type, one per number: the latest copy of each.
export function latestIssued(documents, type) {
  return latestPerNumber(documents.filter((entry) => entry.type === type), [], "");
}

// Whether an invoice may be issued: with the invoices already issued for the
// same sale, it must not add up to more than the sale. A correction of an
// invoice under its own number replaces it, so the old version is left out.
export function checkInvoice(documents, document, { replaceExisting = false } = {}) {
  const number = String(document.documentNumber);
  const others = documents.filter((entry) => !(entry.type === INVOICE && entry.number === number && replaceExisting));
  const proposed = Object.freeze({
    type: INVOICE,
    number,
    stem: null,
    date: document.date,
    client: document.client?.name ?? "",
    totalTtc: document.totals?.totalTtc ?? null,
    quoteReference: document.quoteReference ?? "",
    deliveryNoteReference: bareDeliveryNoteNumber(document.deliveryNoteReference ?? ""),
    invoiceReference: "",
    source: "proposed"
  });
  const dossier = dossierOf([...others, proposed], { type: INVOICE, number });
  const previous = dossier.invoices.filter((entry) => entry !== proposed);
  const invoicedBefore = roundMoney(previous.reduce((sum, entry) => sum + (entry.totalTtc ?? 0), 0));
  const exceeds = dossier.ceiling !== null && dossier.invoiced > dossier.ceiling + TOLERANCE;
  return Object.freeze({
    ok: !exceeds,
    dossier,
    previous: Object.freeze(previous),
    invoicedBefore,
    remainingBefore: dossier.ceiling === null ? null : roundMoney(Math.max(0, dossier.ceiling - invoicedBefore))
  });
}

// Whether a credit note may be issued: the invoice it names exists, and the
// credit notes on that invoice, this one with them, never come to more than it.
// A correction of a credit note under its own number replaces it.
export function checkCreditNote(documents, document, { replaceExisting = false } = {}) {
  const number = String(document.documentNumber);
  const invoiceNumber = String(document.invoiceReference ?? "").trim();
  const invoice = latestPerNumber(documents.filter((entry) => entry.type === INVOICE && entry.number === invoiceNumber), [], "").at(0) ?? null;
  const previous = latestPerNumber(documents.filter((entry) => entry.type === CREDIT_NOTE
    && entry.invoiceReference === invoiceNumber
    && !(entry.number === number && replaceExisting)), [], "");
  const creditedBefore = roundMoney(previous.reduce((sum, entry) => sum + (entry.totalTtc ?? 0), 0));
  const invoiceTotal = invoice?.totalTtc ?? null;
  const total = Number(document.totals?.totalTtc ?? 0);
  const fits = invoiceTotal !== null && roundMoney(creditedBefore + total) <= invoiceTotal + TOLERANCE;
  return Object.freeze({
    ok: invoice !== null && fits,
    reason: invoice === null ? "invoice_not_issued" : invoiceTotal === null ? "invoice_amount_unknown" : fits ? null : "exceeds_invoice",
    invoice,
    invoiceTotal,
    previous: Object.freeze(previous),
    creditedBefore,
    creditableBefore: invoiceTotal === null ? null : roundMoney(Math.max(0, invoiceTotal - creditedBefore))
  });
}

// Whether a receipt may be issued: with what the client already paid on the
// sale, it must not come to more than the sale. A sale whose amount is unknown
// cannot be checked, and the card says so.
export function checkReceipt(documents, document, { replaceExisting = false } = {}) {
  const number = String(document.documentNumber);
  const others = documents.filter((entry) => !(entry.type === PAYMENT_RECEIPT && entry.number === number && replaceExisting));
  const proposed = Object.freeze({
    type: PAYMENT_RECEIPT,
    number,
    stem: null,
    date: document.date,
    client: document.client?.name ?? "",
    totalTtc: document.totals?.totalTtc ?? null,
    quoteReference: document.quoteReference ?? "",
    deliveryNoteReference: "",
    invoiceReference: document.invoiceReference ?? "",
    source: "proposed"
  });
  const dossier = dossierOf([...others, proposed], { type: PAYMENT_RECEIPT, number });
  const previous = (dossier?.receipts ?? []).filter((entry) => entry !== proposed);
  const receivedBefore = roundMoney(previous.reduce((sum, entry) => sum + (entry.totalTtc ?? 0), 0));
  const exceeds = dossier !== null && dossier.ceiling !== null && dossier.received > dossier.ceiling + TOLERANCE;
  return Object.freeze({
    ok: !exceeds,
    dossier,
    previous: Object.freeze(previous),
    receivedBefore,
    remainingToPayBefore: dossier === null || dossier.ceiling === null ? null : roundMoney(Math.max(0, dossier.ceiling - receivedBefore))
  });
}

// What the card and the agent say about the sale a document belongs to.
export function dossierNotices(document, { dossier, previous = [], invoicedBefore = 0, remainingBefore = null, invoice = null, creditedBefore = 0, creditableBefore = null, receivedBefore = 0, remainingToPayBefore = null } = {}) {
  const notices = [];
  const numbers = (entries) => entries.map((entry) => entry.number).join(", ");
  if (document.documentType === CREDIT_NOTE && invoice) {
    notices.push(previous.length === 0
      ? `Avoir sur la facture n° ${invoice.number} (${formatAmount(invoice.totalTtc)} TTC, du ${invoice.date}).`
      : `Avoir sur la facture n° ${invoice.number} (${formatAmount(invoice.totalTtc)} TTC) : déjà ${formatAmount(creditedBefore)} en avoir (n° ${numbers(previous)}) ; reste possible avant celui-ci : ${formatAmount(creditableBefore)}.`);
    notices.push("Le reste à facturer de la vente augmente d'autant.");
  }
  if (document.documentType === PAYMENT_RECEIPT && dossier) {
    const total = Number(document.totals?.totalTtc ?? 0);
    const before = previous.length > 0 ? ` (reçu n° ${numbers(previous)})` : "";
    notices.push(dossier.ceiling === null
      ? `Montant de la vente inconnu : vérifiez que ce paiement n'est pas déjà enregistré. Déjà reçu : ${formatAmount(receivedBefore)}${before}.`
      : `Vente de ${formatAmount(dossier.ceiling)} TTC (selon le ${dossier.ceilingFrom}) : déjà reçu ${formatAmount(receivedBefore)}${before} ; après ce reçu, reste à payer ${formatAmount(Math.max(0, roundMoney(remainingToPayBefore - total)))}.`);
  }
  if (document.documentType === PURCHASE_ORDER && document.quoteReference) {
    notices.push(`Issu du devis n° ${document.quoteReference} : à la validation, le devis passe à « accepté ».`);
  }
  if (document.documentType === INVOICE && dossier) {
    const base = dossier.ceiling === null
      ? "montant du dossier inconnu"
      : `${formatAmount(dossier.ceiling)} TTC selon le ${dossier.ceilingFrom}`;
    notices.push(previous.length === 0
      ? `Première facture du dossier (${base}).`
      : `Déjà facturé sur ce dossier : ${formatAmount(invoicedBefore)} (facture${previous.length > 1 ? "s" : ""} n° ${previous.map((entry) => entry.number).join(", ")})${remainingBefore === null ? ` ; ${base} : vérifiez qu'il ne s'agit pas d'un doublon.` : ` ; reste à facturer avant celle-ci : ${formatAmount(remainingBefore)}.`}`);
  }
  return Object.freeze(notices);
}

function stageOf({ quoteNumber, orders, deliveryNotes, invoiced, ceiling, received = 0 }) {
  if (ceiling !== null && received > 0 && received >= ceiling - TOLERANCE) {
    return "payé en totalité";
  }
  if (ceiling !== null && invoiced >= ceiling - TOLERANCE && invoiced > 0) {
    return "facturé en totalité";
  }
  if (invoiced > 0) {
    return ceiling === null ? "facturé (montant de la vente inconnu)" : "facturé en partie";
  }
  if (deliveryNotes.length > 0) {
    return "livré, pas encore facturé";
  }
  if (orders.length > 0) {
    return "accepté : bon de commande fait";
  }
  return quoteNumber ? "devis envoyé, pas encore accepté" : "document isolé";
}

// Several files under one number are one document issued more than once: the
// latest counts, and the repeat is reported rather than counted twice.
// label names the document with its article: « La facture », « L'avoir ».
function latestPerNumber(entries, anomalies, label) {
  const byNumber = new Map();
  for (const entry of entries) {
    byNumber.set(entry.number, [...(byNumber.get(entry.number) ?? []), entry]);
  }
  for (const [number, copies] of byNumber) {
    if (copies.length > 1) {
      anomalies.push(`${label} n° ${number} existe en ${copies.length} exemplaires (dates ${copies.map((entry) => entry.date || "?").join(", ")}) : une seule est comptée.`);
    }
  }
  return [...byNumber.values()].map((copies) => copies.reduce((latest, entry) => (dateKey(entry.date) >= dateKey(latest.date) ? entry : latest)));
}

// JJ/MM/AAAA, comparable as text; an unreadable date sorts first.
function dateKey(date) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(date ?? ""));
  return match ? `${match[3]}${match[2]}${match[1]}` : "";
}

function firstOf(entries, field) {
  return entries.map((entry) => entry[field]).find((value) => value) ?? "";
}

function bareDeliveryNoteNumber(value) {
  return String(value ?? "").trim().replace(/^BL\s*n?°?\s*/i, "");
}

function parseAmount(value) {
  if (!value) {
    return null;
  }
  const number = Number(value.replace(/[^\d,.-]/g, "").replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function formatAmount(value) {
  return `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)} DH`;
}
