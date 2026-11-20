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
  marginFloorPercent: Object.freeze({ min: -100, max: 100, label: "Marge minimale d'une commande (%)" })
});

const DAY_MS = 86_400_000;
const TOLERANCE = 0.01;

export function commercialFacts(issued, followUpState, { today = new Date(), rules = {}, margins = null } = {}) {
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
    if (!Number.isFinite(value) || value < limit.min || value > limit.max || (name === "validityDays" && !Number.isInteger(value))) {
      errors.push(`${limit.label} : entre ${limit.min} et ${limit.max}${name === "validityDays" ? ", en jours entiers" : ""}.`);
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

function french(iso) {
  const [year, month, dayOfMonth] = iso.split("-");
  return `${dayOfMonth}/${month}/${year}`;
}
