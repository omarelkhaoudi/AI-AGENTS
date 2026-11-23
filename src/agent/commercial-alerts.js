import { HKIDS_DOCUMENT_TYPES } from "../documents/document-schema.js";
import { latestIssued } from "../documents/document-ledger.js";
import { quotePipeline } from "./sales-book.js";

// The commercial alerts of the CDC V2 (section 5) the follow-ups do not
// already give: a quote past its validity, a discount over the ceiling, a sale
// under the margin floor, an order that does not match its quote, and one
// client written several ways. Each is a fact read from the documents issued
// and the cash book, never a guess.
//
// They go to the improvement book as anomalies (source « commercial »), where
// each has an owner, a severity, a task, its WhatsApp notices and its place in
// the pilot's indicators; one that is no longer true is lifted by itself.
//
// The three thresholds are the direction's commercial rules, set in the
// cockpit. A rule not set gives no alert: nothing is assumed in its place.

export const COMMERCIAL_RULE_LIMITS = Object.freeze({
  validityDays: Object.freeze({ min: 1, max: 365, label: "Validité d'un devis (jours)" }),
  maxDiscountPercent: Object.freeze({ min: 0, max: 100, label: "Remise maximale sans accord (%)" }),
  marginFloorPercent: Object.freeze({ min: -100, max: 100, label: "Marge minimale d'une commande (%)" }),
  confirmationDays: Object.freeze({ min: 1, max: 90, label: "Délai de confirmation d'une commande (jours)" })
});

const DAY_MS = 86_400_000;
const TOLERANCE = 0.01;

export function commercialFacts(issued, followUpState, { today = new Date(), rules = {}, margins = null, entries = [], workshopOrders = [] } = {}) {
  const facts = [];
  const pipeline = quotePipeline(issued, followUpState, { today });
  const day = today.toISOString().slice(0, 10);
  const quotes = latestIssued(issued, HKIDS_DOCUMENT_TYPES.QUOTE);
  const orders = latestIssued(issued, HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER);

  // A quote still open past its validity.
  if (Number.isFinite(rules.validityDays)) {
    for (const quote of pipeline.filter((entry) => entry.status === "ouvert" && entry.date)) {
      const until = new Date(Date.parse(`${quote.date}T00:00:00Z`) + rules.validityDays * DAY_MS).toISOString().slice(0, 10);
      if (until < day) {
        facts.push(fact({
          key: `commercial:devis:${quote.number}:expire`,
          kind: "devis_expire",
          severity: "moyenne",
          client: quote.client,
          reference: `devis ${quote.number}`,
          text: `Devis n° ${quote.number} (${quote.client}) expiré depuis le ${french(until)} (validité ${rules.validityDays} jours), toujours sans réponse : le relancer avec un devis à jour, ou le noter perdu.`
        }));
      }
    }
  }

  // A discount over the ceiling, on a quote or an order.
  if (Number.isFinite(rules.maxDiscountPercent)) {
    for (const [label, documents] of [["Devis", quotes], ["BC", orders]]) {
      for (const document of documents.filter((entry) => Number.isFinite(entry.discountPercent) && entry.discountPercent > rules.maxDiscountPercent + TOLERANCE)) {
        facts.push(fact({
          key: `commercial:${label.toLowerCase()}:${document.number}:remise`,
          kind: "remise_hors_plafond",
          severity: "haute",
          client: document.client,
          reference: `${label === "BC" ? "BC" : "devis"} ${document.number}`,
          orderNumber: label === "BC" ? document.number : "",
          text: `${label} n° ${document.number} (${document.client}) : remise de ${percent(document.discountPercent)}, au-delà du plafond de ${percent(rules.maxDiscountPercent)}. La direction doit l'avoir accordée.`
        }));
      }
    }
  }

  // An order finished under the margin floor, measured on its expenses.
  if (Number.isFinite(rules.marginFloorPercent) && margins) {
    for (const line of margins.orders.filter((entry) => entry.finished && entry.measurable && entry.rate !== null && entry.rate < rules.marginFloorPercent)) {
      facts.push(fact({
        key: `commercial:bc:${line.number}:marge`,
        kind: "marge_sous_seuil",
        severity: "haute",
        owner: "finance",
        client: line.client,
        reference: `BC ${line.number}`,
        orderNumber: line.number,
        text: `BC n° ${line.number} (${line.client}) terminé avec une marge de ${percent(line.rate)}, sous le seuil de ${percent(rules.marginFloorPercent)} (${line.costLines} dépense${line.costLines > 1 ? "s" : ""} rattachée${line.costLines > 1 ? "s" : ""}). Revoir le prix ou les coûts de ce produit.`
      }));
    }
  }

  // An order whose amount is not its quote's.
  for (const order of orders.filter((entry) => entry.quoteReference)) {
    const quote = quotes.find((entry) => entry.number === order.quoteReference);
    if (quote && Number.isFinite(quote.totalTtc) && Number.isFinite(order.totalTtc) && Math.abs(quote.totalTtc - order.totalTtc) > TOLERANCE) {
      facts.push(fact({
        key: `commercial:bc:${order.number}:ecart`,
        kind: "ecart_devis_commande",
        severity: "moyenne",
        client: order.client,
        reference: `BC ${order.number}`,
        orderNumber: order.number,
        text: `BC n° ${order.number} (${order.client}) : ${money(order.totalTtc)} TTC, alors que le devis n° ${quote.number} est de ${money(quote.totalTtc)} TTC. Vérifier l'accord du client sur l'écart.`
      }));
    }
  }

  // A delivered order not invoiced for its amount: its invoices, less their
  // credit notes, against the order. An invoice that names no quote cannot be
  // tied to its order and is left out.
  const invoices = latestIssued(issued, HKIDS_DOCUMENT_TYPES.INVOICE);
  const credits = latestIssued(issued, HKIDS_DOCUMENT_TYPES.CREDIT_NOTE);
  const finished = new Set(workshopOrders.filter((order) => order.finished).map((order) => String(order.number)));
  for (const order of orders.filter((entry) => entry.quoteReference && finished.has(String(entry.number)) && Number.isFinite(entry.totalTtc))) {
    const own = invoices.filter((invoice) => invoice.quoteReference === order.quoteReference);
    const numbers = new Set(own.map((invoice) => String(invoice.number)));
    const credited = credits.filter((credit) => numbers.has(String(credit.invoiceReference)));
    const invoiced = round(own.reduce((sum, invoice) => sum + (invoice.totalTtc ?? 0), 0) - credited.reduce((sum, credit) => sum + (credit.totalTtc ?? 0), 0));
    if (Math.abs(invoiced - order.totalTtc) > TOLERANCE) {
      const gap = round(order.totalTtc - invoiced);
      facts.push(fact({
        key: `commercial:bc:${order.number}:facture`,
        kind: "ecart_commande_facture",
        severity: "moyenne",
        owner: "finance",
        client: order.client,
        reference: `BC ${order.number}`,
        orderNumber: order.number,
        text: `BC n° ${order.number} (${order.client}) livré et installé : ${money(order.totalTtc)} TTC commandés, ${money(invoiced)} facturés${own.length > 0 ? ` (facture${own.length > 1 ? "s" : ""} n° ${own.map((invoice) => invoice.number).join(", ")}${credited.length > 0 ? `, avoir n° ${credited.map((credit) => credit.number).join(", ")}` : ""})` : ", aucune facture"}. ${gap > 0 ? `Reste ${money(gap)} à facturer.` : `Facturé ${money(-gap)} de plus que la commande : vérifier.`}`
      }));
    }
  }

  // The same document issued twice under two numbers: same kind, same client,
  // same amount, within a week.
  const KINDS = [[HKIDS_DOCUMENT_TYPES.QUOTE, "Devis", "moyenne"], [HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER, "BC", "moyenne"], [HKIDS_DOCUMENT_TYPES.INVOICE, "Facture", "haute"]];
  for (const [type, label, severity] of KINDS) {
    const documents = latestIssued(issued, type).filter((entry) => Number.isFinite(entry.totalTtc) && clientKey(entry.client) && dayOf(entry.date));
    const groups = new Map();
    for (const document of documents) {
      const key = `${clientKey(document.client)}|${document.totalTtc.toFixed(2)}`;
      groups.set(key, [...(groups.get(key) ?? []), document]);
    }
    for (const group of groups.values()) {
      const sorted = group.sort((a, b) => dayOf(a.date).localeCompare(dayOf(b.date)) || Number(a.number) - Number(b.number));
      const twins = sorted.filter((document, index) => sorted.some((other, j) => j !== index && Math.abs(Date.parse(`${dayOf(document.date)}T00:00:00Z`) - Date.parse(`${dayOf(other.date)}T00:00:00Z`)) <= 7 * DAY_MS));
      if (twins.length > 1) {
        const numbers = twins.map((document) => document.number);
        facts.push(fact({
          key: `commercial:doublon:${type}:${numbers.join("-")}`,
          kind: "doublon_document",
          severity,
          owner: type === HKIDS_DOCUMENT_TYPES.INVOICE ? "finance" : "commercial",
          client: twins[0].client,
          reference: `${label} ${numbers.join(", ")}`,
          orderNumber: type === HKIDS_DOCUMENT_TYPES.PURCHASE_ORDER ? numbers[0] : "",
          text: `${label === "Facture" ? "Factures" : label === "BC" ? "BC" : "Devis"} n° ${numbers.join(" et ")} : même client (${twins[0].client}), même montant (${money(twins[0].totalTtc)} TTC), à ${twins.length > 2 ? "quelques" : "moins de 8"} jours d'écart. ${type === HKIDS_DOCUMENT_TYPES.INVOICE ? "Une double facturation ? Si oui, l'annuler par un avoir." : "Un doublon ? Si oui, n'en garder qu'un."}`
        }));
      }
    }
  }

  // An order in progress whose file lacks what the next steps need. Three
  // days are left to complete it.
  const open = new Map(workshopOrders.filter((order) => !order.finished).map((order) => [String(order.number), order]));
  for (const order of orders.filter((entry) => open.has(String(entry.number)) && dayOf(entry.date) && daysBetween(dayOf(entry.date), day) >= 3)) {
    const book = open.get(String(order.number));
    const missing = [
      order.quoteReference ? "" : "le devis d'origine",
      Number.isFinite(order.totalTtc) ? "" : "un montant lisible",
      book.steps?.find((step) => step.id === "livraison_installation")?.plannedDate ? "" : "la date de livraison promise",
      book.team?.lead ? "" : "un chef de charge"
    ].filter(Boolean);
    if (missing.length > 0) {
      facts.push(fact({
        key: `commercial:bc:${order.number}:incomplet`,
        kind: "dossier_incomplet",
        severity: "moyenne",
        client: order.client,
        reference: `BC ${order.number}`,
        orderNumber: order.number,
        text: `Dossier du BC n° ${order.number} (${order.client}) incomplet depuis le ${french(dayOf(order.date))} : il manque ${listing(missing)}.`
      }));
    }
  }

  // An order no payment confirmed: no deposit in the cash book after the
  // direction's delay. Not set, no alert.
  if (Number.isFinite(rules.confirmationDays)) {
    const paid = entries.filter((entry) => !entry.cancelled && entry.kind === "entree" && ["acompte_client", "solde_client", "vente_comptant"].includes(entry.category));
    for (const order of orders.filter((entry) => !finished.has(String(entry.number)) && dayOf(entry.date))) {
      const since = daysBetween(dayOf(order.date), day);
      const confirmed = paid.some((entry) => String(entry.orderNumber ?? "") === String(order.number) || (order.quoteReference && String(entry.quoteNumber ?? "") === String(order.quoteReference)));
      if (since > rules.confirmationDays && !confirmed) {
        facts.push(fact({
          key: `commercial:bc:${order.number}:non_confirmee`,
          kind: "commande_non_confirmee",
          severity: "haute",
          client: order.client,
          reference: `BC ${order.number}`,
          orderNumber: order.number,
          text: `BC n° ${order.number} (${order.client}) du ${french(dayOf(order.date))} : aucun acompte au journal de caisse depuis ${since} jours (délai de confirmation : ${rules.confirmationDays} jours). Confirmer la commande avec le client avant d'engager la fabrication, ou noter l'acompte reçu.`
        }));
      }
    }
  }

  // One client written several ways across the documents.
  const spellings = new Map();
  for (const document of issued) {
    const name = typeof document.client === "string" ? document.client.trim() : "";
    const key = clientKey(name);
    if (key) {
      spellings.set(key, new Set([...(spellings.get(key) ?? []), name]));
    }
  }
  for (const [key, names] of spellings) {
    if (names.size > 1) {
      const list = [...names].sort();
      facts.push(fact({
        key: `commercial:client:${key}`,
        kind: "client_en_double",
        severity: "faible",
        client: list[0],
        reference: "clients",
        text: `Un même client semble écrit de ${names.size} façons : ${list.map((entry) => `« ${entry} »`).join(", ")}. Garder une seule écriture pour les prochains documents (et vérifier qu'il ne s'agit pas d'homonymes).`
      }));
    }
  }
  return facts;
}

// A name reduced to what tells it: no accents, no civility, words in order.
export function clientKey(name) {
  const words = String(name ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .split(" ")
    .filter((word) => word && !["mme", "mr", "m", "mlle", "madame", "monsieur", "mademoiselle", "ste", "societe", "sarl", "sa"].includes(word));
  return words.length > 0 ? words.sort().join(" ") : "";
}

// The rules as stored, checked: a number within bounds, or none.
export function readCommercialRules(input = {}) {
  const rules = {};
  const errors = [];
  for (const [name, limit] of Object.entries(COMMERCIAL_RULE_LIMITS)) {
    const raw = input[name];
    if (raw === null || raw === undefined || raw === "") {
      continue;
    }
    const value = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(value) || value < limit.min || value > limit.max || (["validityDays", "confirmationDays"].includes(name) && !Number.isInteger(value))) {
      errors.push(`${limit.label} : entre ${limit.min} et ${limit.max}${["validityDays", "confirmationDays"].includes(name) ? ", en jours entiers" : ""}.`);
      continue;
    }
    rules[name] = value;
  }
  return { rules, errors };
}

function fact({ key, kind, severity, owner = "commercial", client = "", reference, orderNumber = "", text }) {
  return { source: "commercial", key, kind, severity, owner, client, orderNumber: String(orderNumber ?? ""), step: null, reference, fact: text };
}

function percent(value) {
  return `${String(Math.round(value * 10) / 10).replace(".", ",")} %`;
}

function money(value) {
  return `${new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value).replace(/ | /g, " ")} DH`;
}

const round = (value) => Math.round(value * 100) / 100;

function dayOf(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? "").trim());
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function listing(items) {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} et ${items.at(-1)}` : items[0];
}

function french(iso) {
  const [year, month, dayOfMonth] = iso.split("-");
  return `${dayOfMonth}/${month}/${year}`;
}
