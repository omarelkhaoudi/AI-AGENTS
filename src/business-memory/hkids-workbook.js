import { excelSerialToIsoDate } from "./xlsx-reader.js";

// Turns the H-KIDS data workbook (docs/modele-donnees-hkids.xlsx, filled in by
// the company) into business records, one batch per domain, ready for
// ingestBusinessRecords.
//
// The workbook holds facts a person knows: dates, amounts, a step, paid or not.
// The tools read signals: how late, how urgent, whether a decision is due.
// This file is where one becomes the other, and every rule it applies is named
// below so it can be read and changed in one place. The signals are computed
// against referenceDate, the day of the import: the workbook is meant to be
// re-imported whenever it changes, and at least once a day.
//
// Nothing is guessed. A row that names a client, order or supplier that does
// not exist, a date that cannot be read or a value outside its list is reported
// as an issue with its sheet and row, and the importer refuses to write while
// any issue remains.

export const HKIDS_WORKBOOK_CURRENCY = "MAD";

// The example row of the template is recognised by its remark and skipped, so a
// workbook returned with the example still in place does not import a client
// that does not exist.
const EXAMPLE_REMARK = /^exemple fictif/i;

// CDC section 4: a quote is followed up after five days without an answer.
// Twice that is reported as high priority.
export const QUOTE_FOLLOW_UP_DAYS = 5;

// An order whose delivery is this close and that is not ready yet is to watch;
// a payment due this soon is medium priority; a purchase whose order-by date
// (needed date minus supplier lead time) is this close is medium urgency.
export const WATCH_WINDOW_DAYS = 7;

const QUOTE_STATUSES = Object.freeze({
  "envoyé": "sent_pending_reply",
  "accepté - attente acompte": "accepted_pending_deposit",
  "accepté": "accepted",
  "refusé": "rejected",
  "expiré": "expired"
});

const ORDER_STEPS = Object.freeze({
  "attente acompte": { orderStatus: "pending_deposit", productionStatus: "waiting" },
  "fabrication": { orderStatus: "in_production", productionStatus: "in_progress" },
  "prêt à livrer": { orderStatus: "ready", productionStatus: "ready" },
  "livré": { orderStatus: "delivered", productionStatus: "delivered" },
  "installé": { orderStatus: "completed", productionStatus: "completed" },
  "bloqué": { orderStatus: "blocked", productionStatus: "blocked" }
});

// The wording the production schedule uses for the same states.
const PRODUCTION_TIMING = Object.freeze({
  IN_DANGER: "en danger",
  AT_RISK: "a surveiller",
  ON_TIME: "a l'heure"
});

const PAYMENT_TYPES = Object.freeze({
  "acompte": "deposit",
  "solde": "balance",
  "échéance": "instalment",
  "autre": "other"
});

const PURCHASE_STATUSES = Object.freeze({
  "à commander": "to_prepare",
  "commandé": "ordered",
  "reçu": "received"
});

export function convertHkidsWorkbook(sheets, { referenceDate = new Date() } = {}) {
  const today = isoDay(referenceDate);
  const issues = [];
  const skipped = [];
  const context = { today, issues, skipped };

  const customers = rowsOf(sheets, "Clients", context).map((row) => customerRecord(row, context)).filter(Boolean);
  const customerIds = new Set(customers.map((record) => record.id));

  const suppliers = rowsOf(sheets, "Fournisseurs", context).map((row) => supplierRecord(row, context)).filter(Boolean);
  const supplierIdByName = new Map(suppliers.map((record) => [normalizeKey(record.data.name), record.id]));

  const quotes = rowsOf(sheets, "Devis", context).map((row) => quoteRecord(row, context, customerIds)).filter(Boolean);
  const quoteIds = new Set(quotes.map((record) => record.id));

  const orderRows = rowsOf(sheets, "Commandes", context);
  const orders = orderRows.map((row) => orderRecord(row, context, customerIds, quoteIds)).filter(Boolean);
  const orderIds = new Set(orders.map((record) => record.id));
  const production = orderRows.map((row) => productionRecord(row, context, orderIds)).filter(Boolean);

  const payments = rowsOf(sheets, "Paiements", context)
    .map((row) => paymentRecord(row, context, customerIds, orderIds))
    .filter(Boolean);
  const purchaseNeeds = rowsOf(sheets, "Achats", context)
    .map((row, index) => purchaseNeedRecord(row, index, context, orderIds, supplierIdByName))
    .filter(Boolean);

  return Object.freeze({
    referenceDate: today,
    recordsByDomain: Object.freeze({
      customers,
      suppliers,
      quotes,
      orders,
      production,
      payments,
      purchase_needs: purchaseNeeds
    }),
    issues: Object.freeze(issues),
    skipped: Object.freeze(skipped)
  });
}

// ---------- One function per sheet ----------

function customerRecord(row, context) {
  const id = requireText(row, "ID client", context);
  const name = requireText(row, "Nom", context);
  if (!id || !name) {
    return null;
  }
  const lastContactAt = optionalDate(row, "Dernier contact", context);
  return record("customers", "customer", id, "active", {
    data: compact({
      id,
      name,
      city: text(row, "Ville"),
      phone: text(row, "Téléphone"),
      email: text(row, "Email"),
      lastContactAt,
      note: text(row, "Remarque")
    }),
    dates: { createdAt: context.today, updatedAt: context.today }
  });
}

function supplierRecord(row, context) {
  const id = requireText(row, "ID fournisseur", context);
  const name = requireText(row, "Nom", context);
  if (!id || !name) {
    return null;
  }
  return record("suppliers", "supplier", id, "active", {
    data: compact({
      id,
      name,
      phone: text(row, "Téléphone"),
      leadTimeDays: optionalNumber(row, "Délai habituel (jours)", context),
      products: text(row, "Produits")
    }),
    dates: { createdAt: context.today, updatedAt: context.today }
  });
}

function quoteRecord(row, context, customerIds) {
  const id = requireText(row, "N° devis", context);
  const customerId = requireReference(row, "ID client", customerIds, "Clients", context);
  const issuedAt = requireDate(row, "Date du devis", context);
  const status = requireChoice(row, "Statut", QUOTE_STATUSES, context);
  if (!id || !customerId || !issuedAt || !status) {
    return null;
  }

  const lastFollowUpAt = optionalDate(row, "Dernière relance", context);
  const awaitingReply = status === "sent_pending_reply";
  const noResponseDays = awaitingReply ? daysBetween(lastFollowUpAt ?? issuedAt, context.today) : 0;
  const followUpDue = awaitingReply && noResponseDays >= QUOTE_FOLLOW_UP_DAYS;
  const depositPending = status === "accepted_pending_deposit";
  const priority = awaitingReply
    ? noResponseDays >= QUOTE_FOLLOW_UP_DAYS * 2 ? "high" : followUpDue ? "medium" : "low"
    : depositPending ? "medium" : "low";
  const linkedOrderId = text(row, "N° BC lié") || null;

  return record("quotes", "quote", id, status, {
    data: compact({
      id,
      customerId,
      status,
      amount: optionalNumber(row, "Montant TTC (DH)", context),
      currency: HKIDS_WORKBOOK_CURRENCY,
      ageDays: daysBetween(issuedAt, context.today),
      noResponseDays,
      priority,
      followUpReason: followUpDue ? "no_reply" : depositPending ? "deposit_not_received" : null,
      depositRequired: yesNo(row, "Acompte demandé"),
      linkedOrderId,
      requiresDecision: false,
      note: text(row, "Remarque")
    }),
    relations: { customerId, prospectId: null, linkedOrderId },
    dates: { issuedAt, validUntil: null }
  });
}

function orderRecord(row, context, customerIds, quoteIds) {
  const id = requireText(row, "N° BC", context);
  const customerId = requireReference(row, "ID client", customerIds, "Clients", context);
  const step = requireChoice(row, "Étape", ORDER_STEPS, context);
  if (!id || !customerId || !step) {
    return null;
  }
  const quoteId = optionalReference(row, "N° devis", quoteIds, "Devis", context);
  const dueAt = optionalDate(row, "Livraison prévue", context);
  const delayRisk = orderDelayRisk({ step, dueAt, missingMaterial: text(row, "Matière manquante") }, context.today);

  return record("orders", "order", id, step.orderStatus, {
    data: compact({
      id,
      customerId,
      quoteId,
      status: step.orderStatus,
      orderedAt: optionalDate(row, "Date commande", context),
      due: dueAt,
      delayRisk,
      risk: delayRisk,
      commercialAttention: step.orderStatus === "pending_deposit",
      missingMaterial: text(row, "Matière manquante") || null,
      note: text(row, "Remarque")
    }),
    relations: { customerId, quoteId },
    dates: { dueAt }
  });
}

// One production file per order still in the workshop. Delivered and installed
// orders have left it, so they carry no production signal.
function productionRecord(row, context, orderIds) {
  const id = text(row, "N° BC");
  const step = ORDER_STEPS[text(row, "Étape")];
  if (!id || !orderIds.has(id) || !step || ["delivered", "completed"].includes(step.productionStatus)) {
    return null;
  }
  const dueAt = parseDate(row.values["Livraison prévue"]);
  const missingMaterial = text(row, "Matière manquante");
  const delayRisk = orderDelayRisk({ step, dueAt, missingMaterial }, context.today);
  // LATE is not stored: the schedule derives it from the planned date.
  const classification = delayRisk === "high" ? "IN_DANGER" : delayRisk === "medium" ? "AT_RISK" : "ON_TIME";
  const daysLeft = dueAt ? daysBetween(context.today, dueAt) : null;
  const reason = step.productionStatus === "blocked"
    ? `Commande bloquée${missingMaterial ? ` : ${missingMaterial} manquant(e)` : ""}`
    : missingMaterial
      ? `Matière manquante : ${missingMaterial}`
      : daysLeft !== null && daysLeft < 0
        ? `Livraison prévue dépassée de ${-daysLeft} jour(s)`
        : classification === "AT_RISK"
          ? `Livraison dans ${daysLeft} jour(s), commande pas encore prête`
          : step.productionStatus === "waiting"
            ? "En attente de l'acompte avant fabrication"
            : null;

  return record("production", "production_signal", `production-${id}`, step.productionStatus, {
    data: compact({
      id: `production-${id}`,
      orderId: id,
      status: step.productionStatus,
      classification,
      timing: PRODUCTION_TIMING[classification],
      plannedStep: text(row, "Étape"),
      responsible: text(row, "Responsable") || null,
      plannedDate: dueAt,
      delayRisk,
      reason,
      requiresDecision: classification === "IN_DANGER",
      decision: classification === "IN_DANGER"
        ? `Décider comment débloquer la commande ${id} ou revoir sa date de livraison.`
        : null
    }),
    relations: { orderId: id, missingMaterialId: null },
    dates: { dueAt }
  });
}

function paymentRecord(row, context, customerIds, orderIds) {
  const id = requireText(row, "Réf paiement", context);
  const customerId = requireReference(row, "ID client", customerIds, "Clients", context);
  const type = requireChoice(row, "Type", PAYMENT_TYPES, context);
  const amount = requireNumber(row, "Montant (DH)", context);
  const expectedPaymentDate = requireDate(row, "Date prévue", context);
  if (!id || !customerId || !type || amount === null || !expectedPaymentDate) {
    return null;
  }
  const orderId = optionalReference(row, "N° BC", orderIds, "Commandes", context);
  const paid = yesNo(row, "Payé") === true;
  const daysLate = paid ? 0 : Math.max(0, daysBetween(expectedPaymentDate, context.today));
  const daysUntil = daysBetween(context.today, expectedPaymentDate);
  const dueStatus = paid ? "paid" : daysLate > 0 ? "overdue" : daysUntil === 0 ? "due_today" : "upcoming";
  const priority = paid ? "low" : daysLate > 0 ? "high" : daysUntil <= WATCH_WINDOW_DAYS ? "medium" : "low";
  // A late deposit holds the order: whether to keep producing is the
  // management's call, so it is raised as a decision.
  const requiresDecision = !paid && daysLate > 0 && type === "deposit";
  const status = paid ? "received" : "expected";

  return record("payments", "payment", id, status, {
    data: compact({
      id,
      customerId,
      orderId,
      type,
      amount,
      currency: HKIDS_WORKBOOK_CURRENCY,
      expectedPaymentDate,
      paidAt: optionalDate(row, "Date de paiement", context),
      method: text(row, "Moyen") || null,
      status,
      dueStatus,
      daysLate,
      receivable: !paid,
      priority,
      requiresDecision,
      decision: requiresDecision
        ? `Décider si ${orderId ? `la commande ${orderId}` : "la commande"} continue sans l'acompte.`
        : null,
      note: text(row, "Remarque")
    }),
    relations: { customerId, invoiceId: null, quoteId: null, orderId },
    dates: { dueAt: expectedPaymentDate }
  });
}

function purchaseNeedRecord(row, index, context, orderIds, supplierIdByName) {
  const item = requireText(row, "Matière", context);
  const quantity = requireNumber(row, "Quantité nécessaire", context);
  const status = requireChoice(row, "Statut", PURCHASE_STATUSES, context);
  if (!item || quantity === null || !status) {
    return null;
  }
  const stockOnHand = optionalNumber(row, "Stock disponible", context) ?? 0;
  const missingQuantity = Math.max(0, quantity - stockOnHand);
  const neededAt = optionalDate(row, "Date nécessaire", context);
  const leadTime = optionalNumber(row, "Délai fournisseur (jours)", context) ?? 0;
  const supplierName = text(row, "Fournisseur") || null;
  const supplierId = supplierName ? supplierIdByName.get(normalizeKey(supplierName)) ?? null : null;
  const linkedOrderId = optionalReference(row, "N° BC lié", orderIds, "Commandes", context);

  // The order-by date is the needed date minus the supplier's lead time.
  const daysToOrderBy = neededAt ? daysBetween(context.today, neededAt) - leadTime : null;
  const urgency = status !== "to_prepare" || missingQuantity === 0
    ? "low"
    : daysToOrderBy === null || daysToOrderBy <= 0 ? "high" : daysToOrderBy <= WATCH_WINDOW_DAYS ? "medium" : "low";
  const id = `purchase-${row.rowNumber}`;

  return record("purchase_needs", "purchase_need", id, urgency, {
    data: compact({
      id,
      item,
      quantity,
      unit: text(row, "Unité") || null,
      stockOnHand,
      missingQuantity,
      unitPrice: optionalNumber(row, "Prix unitaire (DH)", context),
      currency: HKIDS_WORKBOOK_CURRENCY,
      supplierId,
      supplierName,
      supplierLeadTimeDays: leadTime || null,
      supplierOrderStatus: status,
      linkedOrderId,
      urgency,
      requiresDecision: urgency === "high",
      decision: urgency === "high"
        ? `Commander ${[missingQuantity, text(row, "Unité")].filter(Boolean).join(" ")} de ${item} maintenant.`
        : null,
      note: text(row, "Remarque")
    }),
    relations: { supplierId, linkedOrderId, materialId: null },
    dates: { neededAt }
  });
}

// An order is in danger when it is blocked, misses a material, or is past its
// delivery date without being delivered; to watch when its delivery is within
// the watch window and it is not ready yet.
function orderDelayRisk({ step, dueAt, missingMaterial }, today) {
  if (["delivered", "completed"].includes(step.productionStatus)) {
    return "low";
  }
  if (step.productionStatus === "blocked" || missingMaterial) {
    return "high";
  }
  if (!dueAt) {
    return "low";
  }
  const daysLeft = daysBetween(today, dueAt);
  if (daysLeft < 0) {
    return step.productionStatus === "ready" ? "medium" : "high";
  }
  return daysLeft <= WATCH_WINDOW_DAYS && step.productionStatus !== "ready" ? "medium" : "low";
}

// ---------- Rows and cells ----------

function rowsOf(sheets, name, context) {
  const rows = sheets?.[name];
  if (!Array.isArray(rows)) {
    context.issues.push(issue(name, null, null, "SHEET_MISSING", `L'onglet « ${name} » est absent du fichier.`));
    return [];
  }
  return rows
    .map((row) => ({ ...row, sheet: name }))
    .filter((row) => {
      if (EXAMPLE_REMARK.test(String(row.values.Remarque ?? ""))) {
        context.skipped.push({ sheet: name, row: row.rowNumber, reason: "exemple fictif du modèle" });
        return false;
      }
      return true;
    });
}

function text(row, column) {
  const value = row.values[column];
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "number" && Number.isInteger(value) ? String(value) : String(value).trim();
}

function requireText(row, column, context) {
  const value = text(row, column);
  if (!value) {
    context.issues.push(issue(row.sheet, row.rowNumber, column, "REQUIRED", `« ${column} » est obligatoire.`));
    return null;
  }
  return value;
}

function requireChoice(row, column, choices, context) {
  const value = text(row, column).toLowerCase();
  if (!value) {
    context.issues.push(issue(row.sheet, row.rowNumber, column, "REQUIRED", `« ${column} » est obligatoire.`));
    return null;
  }
  if (!Object.hasOwn(choices, value)) {
    context.issues.push(issue(row.sheet, row.rowNumber, column, "UNKNOWN_VALUE",
      `« ${value} » n'est pas une valeur prévue pour « ${column} » (${Object.keys(choices).join(", ")}).`));
    return null;
  }
  return choices[value];
}

function requireReference(row, column, known, sheet, context) {
  const value = requireText(row, column, context);
  if (value && !known.has(value)) {
    context.issues.push(issue(row.sheet, row.rowNumber, column, "UNKNOWN_REFERENCE",
      `« ${value} » n'existe pas dans l'onglet « ${sheet} ».`));
    return null;
  }
  return value;
}

function optionalReference(row, column, known, sheet, context) {
  const value = text(row, column);
  if (!value) {
    return null;
  }
  if (!known.has(value)) {
    context.issues.push(issue(row.sheet, row.rowNumber, column, "UNKNOWN_REFERENCE",
      `« ${value} » n'existe pas dans l'onglet « ${sheet} ».`));
    return null;
  }
  return value;
}

function requireNumber(row, column, context) {
  const value = optionalNumber(row, column, context);
  if (value === null && !context.issues.some((entry) => entry.sheet === row.sheet && entry.row === row.rowNumber && entry.column === column)) {
    context.issues.push(issue(row.sheet, row.rowNumber, column, "REQUIRED", `« ${column} » est obligatoire.`));
  }
  return value;
}

function optionalNumber(row, column, context) {
  const value = row.values[column];
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = typeof value === "number" ? value : Number(String(value).replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(number)) {
    context.issues.push(issue(row.sheet, row.rowNumber, column, "INVALID_NUMBER", `« ${value} » n'est pas un nombre.`));
    return null;
  }
  return number;
}

function requireDate(row, column, context) {
  const value = optionalDate(row, column, context);
  if (value === null && !context.issues.some((entry) => entry.sheet === row.sheet && entry.row === row.rowNumber && entry.column === column)) {
    context.issues.push(issue(row.sheet, row.rowNumber, column, "REQUIRED", `« ${column} » est obligatoire.`));
  }
  return value;
}

function optionalDate(row, column, context) {
  const value = row.values[column];
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = parseDate(value);
  if (!parsed) {
    context.issues.push(issue(row.sheet, row.rowNumber, column, "INVALID_DATE",
      `« ${value} » n'est pas une date lisible (JJ/MM/AAAA).`));
  }
  return parsed;
}

// Excel stores a date as a serial number; a date typed as text in a cell
// formatted as text arrives as "JJ/MM/AAAA" and is read too.
function parseDate(value) {
  if (typeof value === "number") {
    return value > 0 ? excelSerialToIsoDate(value) : null;
  }
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value ?? "").trim());
  if (!match) {
    return null;
  }
  const [, day, month, year] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 ? date.toISOString().slice(0, 10) : null;
}

function yesNo(row, column) {
  const value = text(row, column).toLowerCase();
  return value === "oui" ? true : value === "non" ? false : null;
}

// ---------- Helpers ----------

function record(domain, recordType, id, status, { data, relations = {}, dates = {} }) {
  return Object.freeze({
    id,
    domain,
    recordType,
    status,
    data,
    relations,
    dates,
    metadata: { companyId: "hkids", importedFrom: "modele-donnees-hkids.xlsx" }
  });
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined && value !== ""));
}

function issue(sheet, row, column, code, message) {
  return Object.freeze({ sheet, row, column, code, message });
}

function isoDay(date) {
  return (date instanceof Date ? date : new Date(date)).toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400000);
}

function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase();
}
