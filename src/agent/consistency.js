// Cross-checks between the trades. Each agent sees only its own data, so a
// contradiction between two of them is visible to nobody: production running
// an order whose deposit never arrived, a purchase made for an order that is
// already delivered. These checks read the records of several trades together
// and report what does not hold. They are computed, never guessed by a model,
// and they report facts and the agents concerned — they decide nothing.

const SETTLED = new Set(["received", "paid", "settled", "cancelled"]);
const CLOSED_ORDERS = new Set(["delivered", "completed", "closed", "cancelled"]);
const WORKSHOP_RUNNING = new Set(["in_progress", "in_production", "blocked", "watch", "ready", "on_time"]);
const ACCEPTED_QUOTES = new Set(["accepted", "accepted_pending_deposit", "won"]);

export const CONSISTENCY_DOMAINS = Object.freeze(["quotes", "orders", "production", "payments", "purchase_needs"]);

export function checkConsistency(recordsByDomain = {}) {
  const data = (domain) => (recordsByDomain[domain] ?? []).map((record) => ({ id: record.id, status: record.status, ...record.data }));
  const quotes = data("quotes");
  const orders = data("orders");
  const production = data("production");
  const payments = data("payments");
  const purchases = data("purchase_needs");

  const orderById = new Map(orders.map((order) => [order.id, order]));
  const quoteById = new Map(quotes.map((quote) => [quote.id, quote]));
  const unpaidDeposit = (orderId) => payments.find((payment) => payment.orderId === orderId
    && payment.type === "deposit"
    && !SETTLED.has(payment.status));
  const findings = [];

  // Production is running on an order whose deposit has not arrived.
  for (const file of production) {
    const order = orderById.get(file.orderId);
    const deposit = unpaidDeposit(file.orderId);
    if (order && deposit && WORKSHOP_RUNNING.has(file.status) && !CLOSED_ORDERS.has(order.status)) {
      findings.push(finding({
        severity: deposit.dueStatus === "overdue" ? "high" : "medium",
        code: "PRODUCTION_WITHOUT_DEPOSIT",
        fact: `La commande ${file.orderId} est en atelier (${file.status}) alors que l'acompte ${deposit.id}${amountOf(deposit)} n'est pas encaissé${deposit.dueStatus === "overdue" ? " et en retard" : ""}.`,
        agents: ["production", "finance", "commercial"],
        action: "Décider si la fabrication continue avant l'acompte, et relancer le client."
      }));
    }
  }

  // A workshop file with no registered order behind it.
  for (const file of production) {
    if (file.orderId && !orderById.has(file.orderId)) {
      findings.push(finding({
        severity: "medium",
        code: "PRODUCTION_WITHOUT_ORDER",
        fact: `L'atelier a un dossier ${file.orderId} qui ne correspond à aucune commande enregistrée.`,
        agents: ["production", "commercial"],
        action: "Retrouver la commande ou le devis correspondant, ou clôturer le dossier atelier."
      }));
    }
  }

  // An order whose quote is not accepted.
  for (const order of orders) {
    const quote = order.quoteId ? quoteById.get(order.quoteId) : null;
    if (quote && !ACCEPTED_QUOTES.has(quote.status) && !CLOSED_ORDERS.has(order.status)) {
      findings.push(finding({
        severity: "medium",
        code: "ORDER_WITHOUT_ACCEPTED_QUOTE",
        fact: `La commande ${order.id} existe alors que son devis ${quote.id} est au statut « ${quote.status} ».`,
        agents: ["commercial", "production"],
        action: "Faire confirmer le devis par le client ou mettre la commande en attente."
      }));
    }
  }

  // Material bought for an order that is closed, unknown, or not yet paid for.
  for (const need of purchases) {
    const orderId = need.linkedOrderId;
    if (!orderId) {
      continue;
    }
    const order = orderById.get(orderId);
    if (!order) {
      findings.push(finding({
        severity: "medium",
        code: "PURCHASE_FOR_UNKNOWN_ORDER",
        fact: `L'achat ${need.item ?? need.id} est rattaché à la commande ${orderId}, qui n'existe pas.`,
        agents: ["purchasing", "commercial"],
        action: "Rattacher l'achat à la bonne commande ou l'annuler."
      }));
    } else if (CLOSED_ORDERS.has(order.status)) {
      findings.push(finding({
        severity: "medium",
        code: "PURCHASE_FOR_CLOSED_ORDER",
        fact: `L'achat ${need.item ?? need.id} est prévu pour la commande ${orderId}, déjà ${order.status}.`,
        agents: ["purchasing", "production"],
        action: "Vérifier si cet achat est encore nécessaire."
      }));
    } else if (unpaidDeposit(orderId) && ["high", "medium"].includes(need.urgency ?? need.status)) {
      findings.push(finding({
        severity: "medium",
        code: "PURCHASE_BEFORE_DEPOSIT",
        fact: `L'achat urgent ${need.item ?? need.id} sert la commande ${orderId}, dont l'acompte n'est pas encaissé.`,
        agents: ["purchasing", "finance"],
        action: "Décider si l'achat est engagé avant l'acompte."
      }));
    }
  }

  // Delivered, but the money is still owed and late.
  for (const payment of payments) {
    const order = payment.orderId ? orderById.get(payment.orderId) : null;
    if (order && CLOSED_ORDERS.has(order.status) && !SETTLED.has(payment.status) && payment.dueStatus === "overdue") {
      findings.push(finding({
        severity: "high",
        code: "DELIVERED_NOT_PAID",
        fact: `La commande ${order.id} est ${order.status} mais le paiement ${payment.id}${amountOf(payment)} est en retard.`,
        agents: ["finance", "commercial"],
        action: "Relancer le client pour le solde."
      }));
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return Object.freeze(findings.sort((a, b) => rank[a.severity] - rank[b.severity]));
}

function amountOf(payment) {
  return typeof payment.amount === "number" ? ` (${payment.amount} ${payment.currency ?? "MAD"})` : "";
}

function finding(value) {
  return Object.freeze({ ...value, agents: Object.freeze([...value.agents]) });
}
