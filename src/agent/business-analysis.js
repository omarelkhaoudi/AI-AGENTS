import { roundMoney } from "../documents/document-calculations.js";
import { PAYMENT_SCHEDULE_RULES, STANDARD_PAYMENT_SCHEDULE_RULE_ID } from "../documents/payment-schedule.js";
import { frenchDay, isoDay } from "./sales-book.js";

// The analysis the direction asks of its Director (CDC 10.D): « quels
// produits sont les plus rentables ? », « quelle trésorerie dans quinze
// jours ? ». Both are worked out from what the cockpit holds, never guessed:
// the purchase orders of the workshop book, with their dossier (what was
// invoiced and received), and the cash book.
//
// A margin is measured only for an order whose expenses were recorded against
// it (BC or quote number on the cash line). An order with none has no margin
// the cockpit can tell, and says so, rather than showing 100 %.

const VAT = 0.2;
// The company's standard schedule (60 % at the order, 20 % before delivery,
// 20 % after installation for the pilot): what is due at the order, and by the
// delivery. An order whose client agreed otherwise is told as a hypothesis.
const STANDARD = PAYMENT_SCHEDULE_RULES[STANDARD_PAYMENT_SCHEDULE_RULE_ID];
const share = (conditions) => STANDARD.parts.filter((part) => conditions.includes(part.condition)).reduce((sum, part) => sum + Number(part.percent), 0) / 100;
export const ON_ORDER = share(["à la commande"]);
export const BY_DELIVERY = ON_ORDER + share(["avant livraison", "à la livraison"]);
export const STANDARD_PLAN_LABEL = STANDARD.label;

const live = (entries) => entries.filter((entry) => !entry.cancelled);

// What the client already paid on an order: the receipts issued, or the cash
// recorded against its quote or order, whichever says more.
function paidOn(order, entries) {
  const cash = live(entries).filter((entry) => entry.kind === "entree"
    && ((order.quoteNumber && entry.quoteNumber === String(order.quoteNumber)) || entry.orderNumber === String(order.number)));
  return roundMoney(Math.max(order.received ?? 0, cash.reduce((sum, entry) => sum + entry.amount, 0)));
}

function costsOf(order, entries, confidential) {
  return live(entries).filter((entry) => entry.kind === "sortie"
    && (confidential || !entry.confidential)
    && ((order.quoteNumber && entry.quoteNumber === String(order.quoteNumber)) || entry.orderNumber === String(order.number)));
}

function rate(margin, sales) {
  return sales > 0 ? Math.round((margin / sales) * 1000) / 10 : null;
}

// The margin of each order made in the period, then by what was sold (the
// object of the order: « Lit cabane », « Chambre complète »), then the
// expenses tied to no order (rent, salaries, power) for the same period.
export function orderMargins(orders, entries, { from, to, confidential = true }) {
  const inPeriod = orders.filter((order) => {
    const day = isoDay(order.date);
    return day && day >= from && day <= to && Number.isFinite(order.totalTtc);
  });
  const lines = inPeriod.map((order) => {
    const costs = costsOf(order, entries, confidential);
    const salesHt = roundMoney(order.totalTtc / (1 + VAT));
    const spent = roundMoney(costs.reduce((sum, entry) => sum + entry.amount, 0));
    return Object.freeze({
      number: order.number,
      client: order.client,
      object: order.object || "(sans objet)",
      finished: order.finished === true,
      salesTtc: order.totalTtc,
      salesHt,
      costs: spent,
      costLines: costs.length,
      measurable: costs.length > 0,
      margin: costs.length > 0 ? roundMoney(salesHt - spent) : null,
      rate: costs.length > 0 ? rate(salesHt - spent, salesHt) : null,
      byCategory: Object.freeze(groupAmounts(costs, (entry) => entry.confidential && !confidential ? "confidentiel" : entry.category))
    });
  });

  const products = new Map();
  for (const line of lines.filter((entry) => entry.measurable)) {
    const key = line.object.trim().toLowerCase();
    const product = products.get(key) ?? { object: line.object, orders: [], salesHt: 0, costs: 0 };
    product.orders.push(line.number);
    product.salesHt = roundMoney(product.salesHt + line.salesHt);
    product.costs = roundMoney(product.costs + line.costs);
    products.set(key, product);
  }
  const byProduct = [...products.values()]
    .map((product) => Object.freeze({ ...product, margin: roundMoney(product.salesHt - product.costs), rate: rate(product.salesHt - product.costs, product.salesHt) }))
    .sort((a, b) => (b.rate ?? -Infinity) - (a.rate ?? -Infinity));

  const knownOrders = new Set(orders.flatMap((order) => [`bc:${order.number}`, ...(order.quoteNumber ? [`devis:${order.quoteNumber}`] : [])]));
  const spentInPeriod = live(entries).filter((entry) => entry.kind === "sortie" && entry.day >= from && entry.day <= to);
  const overheads = spentInPeriod.filter((entry) => !entry.orderNumber && !entry.quoteNumber);
  // Tied to a sale the cockpit does not know (a BC made by hand): said, not
  // guessed into a margin or into the overheads.
  const strays = spentInPeriod.filter((entry) => (entry.orderNumber || entry.quoteNumber)
    && !(entry.orderNumber && knownOrders.has(`bc:${entry.orderNumber}`))
    && !(entry.quoteNumber && knownOrders.has(`devis:${entry.quoteNumber}`)));
  const measured = lines.filter((line) => line.measurable);
  const grossMargin = roundMoney(measured.reduce((sum, line) => sum + line.margin, 0));
  const overheadTotal = roundMoney(overheads.reduce((sum, entry) => sum + entry.amount, 0));
  return Object.freeze({
    from,
    to,
    orders: Object.freeze(lines),
    measured: measured.length,
    unmeasured: Object.freeze(lines.filter((line) => !line.measurable).map((line) => line.number)),
    byProduct: Object.freeze(byProduct),
    grossMargin,
    salesHtMeasured: roundMoney(measured.reduce((sum, line) => sum + line.salesHt, 0)),
    overheads: Object.freeze(groupAmounts(overheads, (entry) => (entry.confidential && !confidential ? "confidentiel" : entry.category))),
    overheadTotal,
    strays: Object.freeze(strays.map((entry) => Object.freeze({ number: entry.number, reference: entry.orderNumber ? `BC ${entry.orderNumber}` : `devis ${entry.quoteNumber}`, amount: entry.confidential && !confidential ? null : entry.amount })))
  });
}

function groupAmounts(entries, keyOf) {
  const groups = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    groups.set(key, roundMoney((groups.get(key) ?? 0) + entry.amount));
  }
  return [...groups.entries()].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
}

function addDays(iso, days) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// The cash in hand today, what clients should pay over the next days and
// when, what goes out at the pace of the last 30 days, and the balance day by
// day: its end and its lowest point.
export function cashForecast(orders, entries, { today, days = 15, pastDays = 30 }) {
  const start = isoDay(today);
  const end = addDays(start, days);
  const counted = live(entries).filter((entry) => entry.day <= start);
  const balance = roundMoney(counted.reduce((sum, entry) => sum + (entry.kind === "entree" ? entry.amount : -entry.amount), 0));

  const expected = [];
  const unknown = [];
  for (const order of orders) {
    if (!Number.isFinite(order.totalTtc)) {
      unknown.push(order.number);
      continue;
    }
    const paid = paidOn(order, entries);
    const owed = roundMoney(order.totalTtc - paid);
    if (owed <= 0.01) {
      continue;
    }
    const delivery = order.steps?.find((step) => step.id === "livraison_installation");
    const control = order.steps?.find((step) => step.id === "controle_qualite");
    const push = (amount, day, why, late) => {
      if (amount > 0.01) {
        expected.push(Object.freeze({ order: order.number, client: order.client, amount: roundMoney(amount), day, why, late }));
      }
    };
    if (order.finished) {
      // Installed: everything left is due now.
      push(owed, start, "livrée et installée : le solde est dû", true);
      continue;
    }
    // The deposit, due at the order.
    const deposit = roundMoney(Math.max(0, order.totalTtc * ON_ORDER - paid));
    push(deposit, start, `acompte de ${Math.round(ON_ORDER * 100)} % à la commande, pas encore reçu`, true);
    // By delivery: the share due before or at delivery, on the planned
    // delivery day, or now when the quality check is done and no day is set.
    const beforeDelivery = roundMoney(Math.max(0, order.totalTtc * BY_DELIVERY - Math.max(paid, order.totalTtc * ON_ORDER)));
    const deliveryDay = delivery?.plannedDate ?? (control?.status === "terminee" ? start : null);
    if (beforeDelivery > 0.01) {
      if (deliveryDay && deliveryDay <= end) {
        push(beforeDelivery, deliveryDay < start ? start : deliveryDay, `${Math.round((BY_DELIVERY - ON_ORDER) * 100)} % à la livraison (prévue le ${frenchDay(delivery?.plannedDate ?? start)})`, deliveryDay < start);
      } else if (!deliveryDay) {
        unknown.push(order.number);
      }
    }
  }
  expected.sort((a, b) => a.day.localeCompare(b.day));

  // Spending at the pace of the last days, every expense counted (a salary
  // too, in the total only).
  const since = addDays(start, -pastDays);
  const spentRecently = roundMoney(counted.filter((entry) => entry.kind === "sortie" && entry.day > since).reduce((sum, entry) => sum + entry.amount, 0));
  const perDay = roundMoney(spentRecently / pastDays);

  const timeline = [];
  let running = balance;
  let lowest = { day: start, balance };
  for (let offset = 0; offset <= days; offset += 1) {
    const day = addDays(start, offset);
    const inflow = roundMoney(expected.filter((entry) => entry.day === day).reduce((sum, entry) => sum + entry.amount, 0));
    const outflow = offset === 0 ? 0 : perDay;
    running = roundMoney(running + inflow - outflow);
    timeline.push(Object.freeze({ day, inflow, outflow, balance: running }));
    if (running < lowest.balance) {
      lowest = { day, balance: running };
    }
  }
  const inflows = roundMoney(expected.reduce((sum, entry) => sum + entry.amount, 0));
  return Object.freeze({
    from: start,
    to: end,
    days,
    balance,
    expected: Object.freeze(expected),
    inflows,
    overdue: roundMoney(expected.filter((entry) => entry.late).reduce((sum, entry) => sum + entry.amount, 0)),
    perDay,
    pastDays,
    outflows: roundMoney(perDay * days),
    closing: running,
    lowest: Object.freeze(lowest),
    firstNegative: timeline.find((point) => point.balance < 0)?.day ?? null,
    undated: Object.freeze([...new Set(unknown)]),
    timeline: Object.freeze(timeline),
    hasBook: counted.length > 0
  });
}
