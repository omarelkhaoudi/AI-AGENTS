// Where the company stands against a figure the direction sets: "100 000 DH de
// chiffre d'affaires ce mois". The Director builds its strategy on this, so the
// figures are computed here from the business records, never estimated by a
// model: what is already signed or collected in the period, the gap, the quotes
// still open that could close it, and the pace needed per remaining day.
//
// A sale is a quote the customer accepted. It is dated by its order when there
// is one (the day the customer committed), otherwise by the quote. A quote with
// no amount is counted apart: it is a sale nobody can value, and adding it as
// zero would make the gap look bigger than it is.

export const OBJECTIVE_INDICATORS = Object.freeze({
  ventes_signees: "Ventes signées (devis acceptés)",
  encaissements: "Encaissements reçus"
});

export const OBJECTIVE_DOMAINS = Object.freeze(["quotes", "orders", "payments"]);

const ACCEPTED_QUOTES = new Set(["accepted", "accepted_pending_deposit", "won"]);
const OPEN_QUOTES = new Set(["sent_pending_reply", "pending_customer_reply"]);
const RECEIVED_PAYMENTS = new Set(["received", "paid", "settled"]);
const FOLLOW_UP_DAYS = 5;

export function currentMonth(today) {
  const day = isoDay(today);
  const [year, month] = day.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${day.slice(0, 7)}-01`, to: `${day.slice(0, 7)}-${String(last).padStart(2, "0")}` };
}

export function measureObjective(recordsByDomain = {}, { indicator = "ventes_signees", amount = 0, from, to, today = new Date() } = {}) {
  const rows = (domain) => (recordsByDomain[domain] ?? []).map((record) => ({
    ...record.data,
    id: record.id,
    status: record.status ?? record.data?.status,
    dates: record.dates ?? {},
    source: record.source ?? null
  }));
  const quotes = rows("quotes");
  const orders = rows("orders");
  const payments = rows("payments");
  const day = isoDay(today);
  const inPeriod = (date) => typeof date === "string" && date.slice(0, 10) >= from && date.slice(0, 10) <= to;

  const orderOf = (quote) => orders.find((order) => order.quoteId === quote.id || order.id === quote.linkedOrderId);
  const saleDate = (quote) => orderOf(quote)?.orderedAt ?? quote.dates.issuedAt ?? quote.issuedAt ?? null;

  const signed = quotes.filter((quote) => ACCEPTED_QUOTES.has(quote.status) && inPeriod(saleDate(quote)));
  const received = payments.filter((payment) => RECEIVED_PAYMENTS.has(payment.status) && inPeriod(payment.paidAt));
  const expected = payments.filter((payment) => !RECEIVED_PAYMENTS.has(payment.status) && inPeriod(payment.expectedPaymentDate));
  const open = quotes.filter((quote) => OPEN_QUOTES.has(quote.status));

  const achieved = indicator === "encaissements" ? sum(received) : sum(signed);
  const target = Number(amount) || 0;
  const gap = Math.max(0, round(target - achieved));
  const daysLeft = Math.max(0, daysBetween(day > from ? day : from, to) + 1);
  const sources = [...new Set([...quotes, ...payments].map((row) => row.source).filter(Boolean))];

  return Object.freeze({
    indicator,
    label: OBJECTIVE_INDICATORS[indicator] ?? indicator,
    currency: "MAD",
    period: Object.freeze({ from, to, daysLeft }),
    target,
    achieved,
    gap,
    percent: target > 0 ? Math.min(100, Math.round((achieved / target) * 100)) : 0,
    reached: target > 0 && achieved >= target,
    pacePerDay: daysLeft > 0 ? round(gap / daysLeft) : gap,
    signedSales: Object.freeze({ count: signed.length, amount: sum(signed), withoutAmount: signed.filter(noAmount).length }),
    collected: Object.freeze({ count: received.length, amount: sum(received) }),
    toCollect: Object.freeze({ count: expected.length, amount: sum(expected) }),
    openQuotes: Object.freeze({
      count: open.length,
      amount: sum(open),
      withoutAmount: open.filter(noAmount).length,
      needFollowUp: open.filter((quote) => (quote.noResponseDays ?? 0) >= FOLLOW_UP_DAYS).length,
      // The open quotes alone could close the gap only if this is true; when it
      // is not, the strategy needs new business, not only follow-ups.
      coverGap: sum(open) >= gap,
      largest: Object.freeze(open
        .filter((quote) => !noAmount(quote))
        .sort((a, b) => Number(b.amount) - Number(a.amount))
        .slice(0, 5)
        .map((quote) => Object.freeze({ id: quote.id, customerId: quote.customerId ?? quote.prospectId ?? null, amount: Number(quote.amount), noResponseDays: quote.noResponseDays ?? null })))
    }),
    demo: sources.length > 0 && sources.every((source) => /demo/i.test(source))
  });
}

function noAmount(row) {
  return !Number.isFinite(Number(row.amount)) || row.amount === null || row.amount === undefined || row.amount === "";
}

function sum(rows) {
  return round(rows.filter((row) => !noAmount(row)).reduce((total, row) => total + Number(row.amount), 0));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function isoDay(date) {
  return (date instanceof Date ? date : new Date(date)).toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400000);
}
