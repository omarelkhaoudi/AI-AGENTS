import { HKIDS_DOCUMENT_TYPES } from "./document-schema.js";
import { HKIDS_FIXED_IDENTITY, documentTitleFor } from "./hkids-template.js";
import { discountRowLabel, formatMoney } from "./pdf-renderer.js";

/**
 * What a quote says, decided once and read by both renderers.
 *
 * The PDF and the Word file must state the same thing. The way to guarantee
 * that is not to be careful twice: it is to give them one view to read. Every
 * amount here is copied from the totals the calculation module already
 * produced, and every installment from the schedule the payment module already
 * approved. Nothing on this page multiplies, adds or takes a percentage.
 *
 * The renderers lay this out. They do not decide what is in it.
 */

export class QuotePresentationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "QuotePresentationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// How a value the file does not hold is shown. A quote that printed an empty
// space where a date belongs reads as an oversight; one that says the date is
// not stated reads as a fact, which is what it is.
export const NOT_PROVIDED_TEXT = "non renseigné";

export const QUOTE_LINE_COLUMNS = Object.freeze([
  "Désignation",
  "Qté",
  "Unité",
  "Pu HT",
  "Remise",
  "Montant HT"
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function shown(value) {
  const given = text(value);
  return given === "" ? NOT_PROVIDED_TEXT : given;
}

function displayDate(value) {
  const given = text(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(given)) {
    const [year, month, day] = given.split("-");
    return `${day}/${month}/${year}`;
  }
  return given;
}

/**
 * Builds the view of a quote.
 *
 * Refuses anything that is not a quote: an invoice rendered through here would
 * lose the reference it must carry, and a delivery note would gain prices.
 */
export function createQuotePresentation(quote) {
  if (quote?.documentType !== HKIDS_DOCUMENT_TYPES.QUOTE) {
    throw new QuotePresentationError(
      "Only a quote can be rendered as a quote.",
      "NOT_A_QUOTE",
      { documentType: quote?.documentType ?? null }
    );
  }
  if (!Array.isArray(quote.items) || quote.items.length === 0) {
    throw new QuotePresentationError("A quote needs at least one line.", "QUOTE_ITEMS_REQUIRED");
  }
  if (!quote.totals) {
    throw new QuotePresentationError("A quote needs the totals its lines produced.", "QUOTE_TOTALS_REQUIRED");
  }

  // A number the register has not given is not replaced by one. The register's
  // own sentence travels onto the document, so a reader knows why it is absent.
  const numberAssigned = text(quote.documentNumber) !== "";
  const numberText = numberAssigned
    ? text(quote.documentNumber)
    : text(quote.numberMessage) || NOT_PROVIDED_TEXT;

  const date = displayDate(quote.date);
  const totals = quote.totals;

  const lines = quote.items.map((item, index) => Object.freeze({
    index,
    designation: shown(item.designation),
    quantity: String(item.quantity),
    unit: shown(item.unit),
    // Read from the line the calculation module produced, formatted once.
    unitPriceHt: formatMoney(item.unitPriceHt),
    discountAmount: Number(item.discountAmount) > 0 ? formatMoney(item.discountAmount) : "",
    netAmountHt: formatMoney(item.netAmountHt ?? item.amountHt),
    cells: Object.freeze([
      shown(item.designation),
      String(item.quantity),
      shown(item.unit),
      formatMoney(item.unitPriceHt),
      Number(item.discountAmount) > 0 ? formatMoney(item.discountAmount) : "",
      formatMoney(item.netAmountHt ?? item.amountHt)
    ])
  }));

  // Gross and rebate are shown only when there is a rebate: three lines saying
  // the same figure would suggest a discount nobody granted.
  const discounted = Number(totals.totalDiscount) > 0;
  const totalRows = [
    ...(discounted
      ? [
        ["TOTAL BRUT HT", formatMoney(totals.totalBrutHt)],
        // Named as the invoice names it: see discountRowLabel.
        [discountRowLabel(quote.discount), formatMoney(totals.totalDiscount)]
      ]
      : []),
    ["TOTAL HT", formatMoney(totals.totalHt)],
    [`TVA ${Math.round(Number(totals.tvaRate) * 100)} %`, formatMoney(totals.tva)],
    ["TOTAL TTC", formatMoney(totals.totalTtc)]
  ];

  const schedule = quote.schedule ?? null;
  const installments = schedule
    ? schedule.installments.map((entry) => Object.freeze({
      percent: entry.percent,
      amountTtc: formatMoney(entry.amountTtc),
      condition: entry.condition,
      cells: Object.freeze([`${entry.percent} %`, entry.condition, formatMoney(entry.amountTtc)])
    }))
    : [];

  return Object.freeze({
    documentType: quote.documentType,
    title: documentTitleFor(quote.documentType),

    issuer: Object.freeze({
      name: HKIDS_FIXED_IDENTITY.companyName,
      addressLines: HKIDS_FIXED_IDENTITY.addressLines,
      email: HKIDS_FIXED_IDENTITY.email,
      phone: HKIDS_FIXED_IDENTITY.phone,
      legalLine: HKIDS_FIXED_IDENTITY.legalLine
    }),

    numberAssigned,
    numberText,
    dateProvided: date !== "",
    dateText: date === "" ? NOT_PROVIDED_TEXT : date,

    client: Object.freeze({
      name: shown(quote.client?.name),
      address: shown(quote.client?.address),
      complete: text(quote.client?.name) !== "" && text(quote.client?.address) !== ""
    }),

    columns: QUOTE_LINE_COLUMNS,
    lines: Object.freeze(lines),
    discounted,
    totalRows: Object.freeze(totalRows.map((row) => Object.freeze([...row]))),

    paymentMethod: shown(quote.payment?.method),
    paymentTerms: shown(quote.payment?.terms),
    scheduleAvailable: schedule !== null,
    installments: Object.freeze(installments),

    footerMention: HKIDS_FIXED_IDENTITY.footerMention,

    // Everything the quote cannot state, listed so a renderer can show it as
    // absent instead of leaving a gap a reader has to interpret.
    absent: Object.freeze([
      ...(numberAssigned ? [] : ["documentNumber"]),
      ...(date === "" ? ["date"] : []),
      ...(text(quote.client?.name) === "" ? ["client.name"] : []),
      ...(text(quote.client?.address) === "" ? ["client.address"] : []),
      ...(schedule ? [] : ["schedule"])
    ])
  });
}
