import { HKIDS_DOCUMENT_TYPES } from "../documents/document-schema.js";
import { latestIssued } from "../documents/document-ledger.js";
import { SALE_CHANNELS, isoDay, quotePipeline } from "./sales-book.js";

// The complete commercial report (CDC V2 section 5, « Bilans interactifs »):
// prospects, quotes issued, transformation, CA commandé, facturé and encaissé
// as three separate figures, analysed by product, channel, client, seller and
// campaign, against the period before and the direction's target.
//
// Every figure is read from the books and carries the documents it is made of:
// a quote is dated by its issue, a sale by its purchase order, CA facturé by
// the invoices (less their credit notes), CA encaissé by the client payments of
// the cash book. An invoice or a payment that names no quote of the cockpit is
// counted apart, « non rattaché »; a quote whose channel, seller or campaign
// nobody said is counted under « non renseigné », never guessed.

export const REPORT_AXES = Object.freeze({ produit: "Produit", canal: "Canal", client: "Client", vendeur: "Vendeur", campagne: "Campagne" });
export const UNSET = "non renseigné";
export const UNLINKED = "non rattaché";
const PAID_CATEGORIES = Object.freeze(["acompte_client", "solde_client", "vente_comptant"]);
const NETWORK_CHANNELS = Object.freeze({ instagram: "instagram", facebook: "facebook", messenger: "facebook", whatsapp: "whatsapp" });

const round = (value) => Math.round(value * 100) / 100;
const dayOf = (value) => isoDay(value) ?? (typeof value === "string" ? isoDay(value.slice(0, 10)) : null);

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// The period of the same length just before.
export function previousPeriod(from, to) {
  const length = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return { from: addDays(from, -length), to: addDays(from, -1) };
}

// Product: the object of the quote, the same whatever its case or spaces.
const productKey = (quote) => String(quote.object ?? "").trim().replace(/\s+/g, " ");
const keyOf = (value) => String(value ?? "").trim().toLocaleLowerCase("fr");

function figures(issued, state, entries, prospects, { from, to, today, days }) {
  const inPeriod = (iso) => Boolean(iso) && iso >= from && iso <= to;
  const pipeline = quotePipeline(issued, state, { today, days });
  const quotes = new Map(pipeline.map((quote) => [quote.number, quote]));
  const orders = latestIssued(issued, HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER);
  const invoices = latestIssued(issued, HKIDS_DOCUMENT_TYPES.INVOICE);
  const credits = latestIssued(issued, HKIDS_DOCUMENT_TYPES.CREDIT_NOTE);
  const quoteOfOrder = new Map(orders.filter((order) => order.quoteReference).map((order) => [String(order.number), String(order.quoteReference)]));
  const quoteOfInvoice = new Map(invoices.map((invoice) => [String(invoice.number), invoice.quoteReference && quotes.has(String(invoice.quoteReference)) ? String(invoice.quoteReference) : null]));

  // One line per fact, each with the quote it belongs to (null: not linked).
  const facts = [];
  for (const quote of pipeline) {
    if (inPeriod(quote.date)) facts.push({ quote: quote.number, kind: "issued", amount: quote.totalTtc, ref: `devis ${quote.number}` });
    if (quote.order && inPeriod(quote.order.date)) facts.push({ quote: quote.number, kind: "signed", amount: quote.order.totalTtc ?? quote.totalTtc, ref: `devis ${quote.number} → BC ${quote.order.number}` });
    if (quote.lost && inPeriod(quote.lost.day)) facts.push({ quote: quote.number, kind: "lost", amount: quote.totalTtc, ref: `devis ${quote.number}` });
  }
  for (const invoice of invoices.filter((entry) => inPeriod(dayOf(entry.date)))) {
    facts.push({ quote: quoteOfInvoice.get(String(invoice.number)) ?? null, kind: "invoiced", amount: invoice.totalTtc, ref: `facture ${invoice.number}` });
  }
  for (const credit of credits.filter((entry) => inPeriod(dayOf(entry.date)))) {
    facts.push({ quote: quoteOfInvoice.get(String(credit.invoiceReference)) ?? null, kind: "invoiced", amount: -(credit.totalTtc ?? 0), ref: `avoir ${credit.number}` });
  }
  for (const entry of entries.filter((candidate) => !candidate.cancelled && candidate.kind === "entree" && PAID_CATEGORIES.includes(candidate.category) && inPeriod(candidate.day))) {
    const byQuote = entry.quoteNumber && quotes.has(String(entry.quoteNumber)) ? String(entry.quoteNumber) : null;
    const byOrder = entry.orderNumber ? quoteOfOrder.get(String(entry.orderNumber)) : null;
    const quote = byQuote ?? (byOrder && quotes.has(byOrder) ? byOrder : null);
    facts.push({ quote, kind: "paid", amount: entry.amount, ref: `caisse n° ${entry.number ?? "?"}` });
  }
  const leads = prospects.filter((prospect) => inPeriod(dayOf(prospect.createdAt)));
  return { pipeline, quotes, facts, leads };
}

function emptyRow(key, label) {
  return { key, label, prospects: 0, issued: { count: 0, totalTtc: 0, refs: [] }, signed: { count: 0, totalTtc: 0, refs: [] }, lost: { count: 0, totalTtc: 0, refs: [] }, invoiced: { totalTtc: 0, refs: [] }, paid: { total: 0, refs: [] }, unknownAmounts: [] };
}

function add(row, fact) {
  const bucket = row[fact.kind];
  if (fact.amount === null || fact.amount === undefined) {
    row.unknownAmounts.push(fact.ref);
  }
  const amount = Number(fact.amount) || 0;
  if (bucket.count !== undefined) bucket.count += 1;
  if (bucket.totalTtc !== undefined) bucket.totalTtc = round(bucket.totalTtc + amount);
  else bucket.total = round(bucket.total + amount);
  bucket.refs.push(fact.ref);
}

function finish(row) {
  // Transformation: the quotes of the period already ordered, among those issued.
  return Object.freeze({ ...row, conversion: row.issued.count > 0 ? Math.round((row.converted ?? 0) / row.issued.count * 100) : null });
}

// The value of a quote along an axis: [key, label].
function axisValue(axis, quote) {
  if (!quote) return [UNLINKED, UNLINKED];
  const attribution = quote.attribution ?? {};
  if (axis === "produit") {
    const product = productKey(quote);
    return product ? [keyOf(product), product] : [UNSET, UNSET];
  }
  if (axis === "client") return quote.client ? [keyOf(quote.client), quote.client] : [UNSET, UNSET];
  if (axis === "canal") return attribution.channel ? [attribution.channel, SALE_CHANNELS[attribution.channel] ?? attribution.channel] : [UNSET, UNSET];
  if (axis === "vendeur") return attribution.seller ? [keyOf(attribution.seller), attribution.seller] : [UNSET, UNSET];
  if (axis === "campagne") return attribution.campaign ? [keyOf(attribution.campaign), attribution.campaign] : [UNSET, UNSET];
  return [UNSET, UNSET];
}

function totalsOf(found) {
  const row = emptyRow("total", "Total");
  row.converted = found.pipeline.filter((quote) => found.facts.some((fact) => fact.kind === "issued" && fact.quote === quote.number) && quote.order).length;
  for (const fact of found.facts) add(row, fact);
  row.prospects = found.leads.length;
  return finish(row);
}

export function commercialReport({ issued = [], followUps = { quotes: {} }, entries = [], prospects = [], from, to, today = new Date(), days = 5 }) {
  const state = followUps ?? { quotes: {} };
  const found = figures(issued, state, entries, prospects, { from, to, today, days });
  const before = previousPeriod(from, to);
  const previous = figures(issued, state, entries, prospects, { ...before, today, days });
  const attributed = (number) => {
    const quote = found.quotes.get(number);
    return quote ? { ...quote, attribution: state.quotes?.[number]?.attribution ?? null } : null;
  };

  const axes = {};
  for (const axis of Object.keys(REPORT_AXES)) {
    const rows = new Map();
    // A value written several ways is shown as it is written most often,
    // then as on the oldest quote.
    const spellings = new Map();
    const rowFor = ([key, label], order = Number.MAX_SAFE_INTEGER) => {
      if (!rows.has(key)) rows.set(key, { ...emptyRow(key, label), converted: 0 });
      const seen = spellings.get(key) ?? new Map();
      const entry = seen.get(label) ?? { count: 0, first: order };
      seen.set(label, { count: entry.count + 1, first: Math.min(entry.first, order) });
      spellings.set(key, seen);
      return rows.get(key);
    };
    for (const fact of found.facts) {
      const row = rowFor(axisValue(axis, attributed(fact.quote)), Number(fact.quote) || Number.MAX_SAFE_INTEGER);
      add(row, fact);
      if (fact.kind === "issued" && found.quotes.get(fact.quote)?.order) row.converted += 1;
    }
    // A prospect counts on its channel; on the other axes it is not a sale yet.
    if (axis === "canal") {
      for (const lead of found.leads) {
        const channel = NETWORK_CHANNELS[String(lead.reseau ?? "").toLowerCase()];
        rowFor(channel ? [channel, SALE_CHANNELS[channel]] : [UNSET, UNSET]).prospects += 1;
      }
    }
    if (axis === "produit") {
      for (const lead of found.leads.filter((candidate) => String(candidate.produit ?? "").trim())) {
        const product = String(lead.produit).trim().replace(/\s+/g, " ");
        rowFor([keyOf(product), product]).prospects += 1;
      }
    }
    for (const row of rows.values()) {
      const [best] = [...(spellings.get(row.key) ?? new Map()).entries()].sort(([, a], [, b]) => b.count - a.count || a.first - b.first);
      if (best) row.label = best[0];
    }
    axes[axis] = [...rows.values()]
      .map(finish)
      .sort((a, b) => (a.key === UNLINKED) - (b.key === UNLINKED) || (a.key === UNSET) - (b.key === UNSET) || b.signed.totalTtc - a.signed.totalTtc || b.issued.totalTtc - a.issued.totalTtc || b.prospects - a.prospects || a.label.localeCompare(b.label, "fr"));
  }

  // The target of the month, when the period lies within one month.
  const month = from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : null;
  const target = month ? state.targets?.[month]?.amount ?? null : null;
  const totals = totalsOf(found);
  const leadStatuses = found.leads.reduce((counts, lead) => ({ ...counts, [lead.status]: (counts[lead.status] ?? 0) + 1 }), {});

  return Object.freeze({
    from,
    to,
    previous: Object.freeze({ ...before, totals: totalsOf(previous) }),
    totals,
    objective: target ? Object.freeze({ month, target, achieved: totals.signed.totalTtc, percent: Math.round((totals.signed.totalTtc / target) * 100) }) : null,
    prospects: Object.freeze({ count: found.leads.length, byStatus: Object.freeze(leadStatuses), refs: found.leads.map((lead) => lead.id) }),
    axes: Object.freeze(axes),
    unattributed: Object.freeze({
      quotes: found.pipeline.filter((quote) => found.facts.some((fact) => fact.quote === quote.number) && !state.quotes?.[quote.number]?.attribution?.channel).map((quote) => quote.number)
    })
  });
}

// The figure of a row as words, for the agents and for WhatsApp.
export function describeRow(row) {
  const dh = (value) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(value).replace(/\s/g, " ")} DH`;
  return [
    row.prospects > 0 ? `${row.prospects} prospect(s)` : "",
    `${row.issued.count} devis émis (${dh(row.issued.totalTtc)})`,
    `CA commandé ${dh(row.signed.totalTtc)} (${row.signed.count} BC)`,
    `CA facturé ${dh(row.invoiced.totalTtc)}`,
    `CA encaissé ${dh(row.paid.total)}`,
    row.conversion === null ? "" : `transformation ${row.conversion} %`
  ].filter(Boolean).join(", ");
}
