import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DATA_DIR, createFileJsonBook, createMemoryJsonBook } from "./json-book.js";
import { frenchDay, isoDay } from "./sales-book.js";

// The register of the materials in stock (CDC V1 section 1, V2 section 9):
// each material (« MDF 18 mm », in « panneau »), what came in (a supplier's
// delivery), what went out (taken for a purchase order, or lost), and the
// counts of an inventory. What is on hand is the sum of the movements, never
// a figure typed over: an inventory records the difference it found.
//
// A minimum is set by the direction for a material it keeps in stock; none is
// invented. Under it, the material is told to Achats (stockFacts, followed in
// Amélioration), with the supplier's delay when known.

export const DEFAULT_STOCK_PATH = join(DATA_DIR, "stock.json");
export const MOVEMENT_KINDS = Object.freeze({ entree: "Entrée", sortie: "Sortie", inventaire: "Inventaire" });

export class StockBookError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "StockBookError";
    this.code = code;
  }
}

const EMPTY = { items: [], movements: [] };

export function createMemoryStockBook({ clock = () => new Date() } = {}) {
  return stockBook(createMemoryJsonBook(EMPTY), clock);
}

export function createFileStockBook({ path = DEFAULT_STOCK_PATH, clock = () => new Date() } = {}) {
  return stockBook(createFileJsonBook(path, EMPTY), clock);
}

const text = (value) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const normalized = (value) => text(value).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
// Quantities are kept to the thousandth (a kilo of screws, 2,5 m² of veneer).
const round = (value) => Math.round(value * 1000) / 1000;
const money = (value) => Math.round(value * 100) / 100;

function number(value) {
  if (typeof value === "number") {
    return value;
  }
  const raw = text(value).replace(/\s/g, "").replace(",", ".");
  return raw === "" ? Number.NaN : Number(raw);
}

// A value the direction may leave unset: "" or null is none; anything else
// must be a number not below zero.
function optionalAmount(value, label, code) {
  if (value === null || value === undefined || text(value) === "") {
    return null;
  }
  const amount = number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new StockBookError(`${label} : un nombre positif ou nul est attendu (« ${text(value)} »).`, code);
  }
  return round(amount);
}

function stockBook(book, clock) {
  const today = () => isoDay(clock());
  const findItem = (state, reference) => {
    const wanted = normalized(reference);
    if (!wanted) {
      throw new StockBookError("Dire de quelle matière il s'agit.", "STOCK_ITEM_MISSING");
    }
    const active = state.items.filter((item) => item.active);
    const exact = active.filter((item) => item.id === text(reference) || String(item.number) === text(reference) || normalized(item.name) === wanted);
    const found = exact.length > 0 ? exact : active.filter((item) => normalized(item.name).includes(wanted));
    if (found.length === 0) {
      throw new StockBookError(`Aucune matière « ${text(reference)} » au registre de stock : l'ajouter d'abord (nom et unité).`, "STOCK_ITEM_NOT_FOUND");
    }
    if (found.length > 1) {
      throw new StockBookError(`Plusieurs matières répondent à « ${text(reference)} » : ${found.map((item) => item.name).join(", ")}. Donner le nom exact.`, "STOCK_ITEM_AMBIGUOUS");
    }
    return found[0];
  };
  const day = (value) => {
    if (!text(value)) {
      return today();
    }
    const iso = isoDay(text(value));
    if (!iso) {
      throw new StockBookError(`Date illisible « ${text(value)} » : écrire JJ/MM/AAAA.`, "STOCK_DATE_INVALID");
    }
    if (iso > today()) {
      throw new StockBookError(`Le ${frenchDay(iso)} n'est pas encore arrivé : un mouvement de stock se note quand il a eu lieu.`, "STOCK_DATE_FUTURE");
    }
    return iso;
  };

  return Object.freeze({
    async state() {
      return book.load();
    },

    async overview() {
      return stockOverview(await book.load(), today());
    },

    async addItem({ name, unit, minimum = null, supplier = "", leadTimeDays = null, by = "direction" }) {
      if (!text(name)) {
        throw new StockBookError("Donner le nom de la matière (« MDF 18 mm », « charnières invisibles »).", "STOCK_NAME_MISSING");
      }
      if (!text(unit)) {
        throw new StockBookError(`Dans quelle unité compte-t-on « ${text(name)} » (panneau, m², mètre linéaire, kg, litre, pièce) ?`, "STOCK_UNIT_MISSING");
      }
      const values = {
        minimum: optionalAmount(minimum, "Stock minimum", "STOCK_MINIMUM_INVALID"),
        leadTimeDays: optionalAmount(leadTimeDays, "Délai du fournisseur", "STOCK_DELAY_INVALID")
      };
      if (values.leadTimeDays !== null && !Number.isInteger(values.leadTimeDays)) {
        throw new StockBookError("Délai du fournisseur : un nombre entier de jours.", "STOCK_DELAY_INVALID");
      }
      return book.change((state) => {
        if (state.items.some((item) => item.active && normalized(item.name) === normalized(name))) {
          throw new StockBookError(`« ${text(name)} » est déjà au registre de stock.`, "STOCK_ITEM_EXISTS");
        }
        const item = {
          id: randomUUID(),
          number: state.items.reduce((highest, entry) => Math.max(highest, entry.number), 0) + 1,
          name: text(name),
          unit: text(unit),
          ...values,
          supplier: text(supplier),
          active: true,
          createdAt: clock().toISOString(),
          createdBy: text(by) || "direction"
        };
        state.items.push(item);
        return Object.freeze({ ...item });
      });
    },

    // Changes what is given; a value left out (undefined) stays as it was,
    // and "" clears a minimum, a supplier or a delay.
    async updateItem(reference, { minimum, supplier, leadTimeDays, unit, active, by = "direction" } = {}) {
      const changes = {};
      if (minimum !== undefined) {
        changes.minimum = optionalAmount(minimum, "Stock minimum", "STOCK_MINIMUM_INVALID");
      }
      if (leadTimeDays !== undefined) {
        changes.leadTimeDays = optionalAmount(leadTimeDays, "Délai du fournisseur", "STOCK_DELAY_INVALID");
        if (changes.leadTimeDays !== null && !Number.isInteger(changes.leadTimeDays)) {
          throw new StockBookError("Délai du fournisseur : un nombre entier de jours.", "STOCK_DELAY_INVALID");
        }
      }
      if (supplier !== undefined) {
        changes.supplier = text(supplier);
      }
      return book.change((state) => {
        const item = findItem(state, reference);
        if (unit !== undefined && text(unit) && text(unit) !== item.unit) {
          if (state.movements.some((movement) => movement.item === item.id && !movement.cancelled)) {
            throw new StockBookError(`« ${item.name} » a déjà des mouvements en ${item.unit} : son unité ne change plus.`, "STOCK_UNIT_LOCKED");
          }
          changes.unit = text(unit);
        }
        if (active === false) {
          changes.active = false;
        }
        Object.assign(item, changes, { updatedAt: clock().toISOString(), updatedBy: text(by) || "direction" });
        return Object.freeze({ ...item });
      });
    },

    // An entry (a delivery), an exit (taken for a purchase order, or lost) or
    // an inventory (the quantity counted, which records the difference).
    async record({ item: reference, kind, quantity, date = "", orderNumber = "", supplier = "", unitCost = null, note = "", by = "direction" }) {
      if (!MOVEMENT_KINDS[kind]) {
        throw new StockBookError(`Mouvement attendu : ${Object.keys(MOVEMENT_KINDS).join(", ")}.`, "STOCK_KIND_UNKNOWN");
      }
      const amount = number(quantity);
      if (!Number.isFinite(amount) || amount < 0 || (kind !== "inventaire" && amount === 0)) {
        throw new StockBookError(kind === "inventaire" ? "Donner la quantité comptée (0 si plus rien)." : "Donner une quantité plus grande que zéro.", "STOCK_QUANTITY_INVALID");
      }
      const cost = kind === "entree" ? optionalAmount(unitCost, "Prix unitaire HT", "STOCK_COST_INVALID") : null;
      const when = day(date);
      return book.change((state) => {
        const item = findItem(state, reference);
        const onHand = balance(state.movements, item.id);
        let delta = round(amount);
        if (kind === "sortie") {
          if (delta > onHand) {
            throw new StockBookError(`Le registre ne connaît que ${quantityText(onHand, item.unit)} de ${item.name} : une sortie de ${quantityText(delta, item.unit)} le rendrait négatif. Noter d'abord l'entrée manquante, ou compter le stock (inventaire).`, "STOCK_NOT_ENOUGH");
          }
          delta = -delta;
        }
        if (kind === "inventaire") {
          delta = round(amount - onHand);
        }
        const movement = {
          number: state.movements.reduce((highest, entry) => Math.max(highest, entry.number), 0) + 1,
          item: item.id,
          name: item.name,
          unit: item.unit,
          kind,
          day: when,
          quantity: delta,
          ...(kind === "inventaire" ? { counted: round(amount), before: onHand } : {}),
          orderNumber: kind === "sortie" ? text(orderNumber).replace(/^n°\s*/i, "") : "",
          supplier: kind === "entree" ? text(supplier) || item.supplier : "",
          unitCost: cost,
          note: text(note),
          at: clock().toISOString(),
          by: text(by) || "direction",
          cancelled: null
        };
        state.movements.push(movement);
        // The first supplier known to deliver it becomes its usual one.
        if (kind === "entree" && movement.supplier && !item.supplier) {
          item.supplier = movement.supplier;
        }
        return Object.freeze({ ...movement, onHand: round(onHand + delta) });
      });
    },

    // A movement noted by mistake is cancelled, never erased.
    async cancel(reference, { reason = "", by = "direction" } = {}) {
      if (!text(reason)) {
        throw new StockBookError("Dire pourquoi la ligne est annulée.", "STOCK_REASON_MISSING");
      }
      return book.change((state) => {
        const movement = state.movements.find((entry) => String(entry.number) === text(reference).replace(/^n°\s*/i, ""));
        if (!movement) {
          throw new StockBookError(`Aucune ligne n° ${text(reference)} au registre de stock.`, "STOCK_MOVEMENT_NOT_FOUND");
        }
        if (movement.cancelled) {
          throw new StockBookError(`La ligne n° ${movement.number} est déjà annulée.`, "STOCK_MOVEMENT_CANCELLED");
        }
        const after = round(balance(state.movements, movement.item) - movement.quantity);
        if (after < 0) {
          throw new StockBookError(`Annuler la ligne n° ${movement.number} rendrait le stock de ${movement.name} négatif (${quantityText(after, movement.unit)}) : annuler d'abord les sorties qui en dépendent.`, "STOCK_NOT_ENOUGH");
        }
        movement.cancelled = { at: clock().toISOString(), by: text(by) || "direction", reason: text(reason) };
        return Object.freeze({ ...movement, onHand: after });
      });
    }
  });
}

function balance(movements, itemId) {
  return round(movements.filter((movement) => movement.item === itemId && !movement.cancelled).reduce((sum, movement) => sum + movement.quantity, 0));
}

export function quantityText(quantity, unit) {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 3 }).format(quantity)} ${Math.abs(quantity) >= 2 ? pluralUnit(unit) : unit}`;
}

// « 8 panneaux », « 3 mètres linéaires » ; an abbreviation (kg, m², ml) or a
// word already plural stays as it is. French takes the plural from 2.
export function pluralUnit(unit) {
  return String(unit).split(" ").map((word) => {
    if (word.length <= 2 || !/^[\p{L}-]+$/u.test(word) || /[sxz]$/i.test(word)) {
      return word;
    }
    return /(eau|au|eu)$/i.test(word) ? `${word}x` : `${word}s`;
  }).join(" ");
}

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// What the register says today: each material on hand, its average cost of
// purchase when the entries gave a price, those under their minimum, the
// recent movements and what each purchase order took.
export function stockOverview(state, today, { recentDays = 30 } = {}) {
  const live = state.movements.filter((movement) => !movement.cancelled);
  const items = state.items.filter((item) => item.active).map((item) => {
    const own = live.filter((movement) => movement.item === item.id);
    const onHand = balance(state.movements, item.id);
    // Weighted average of the entries that gave a price (coût moyen pondéré).
    const priced = own.filter((movement) => movement.kind === "entree" && movement.unitCost !== null);
    const pricedQuantity = priced.reduce((sum, movement) => sum + movement.quantity, 0);
    const averageCost = pricedQuantity > 0 ? money(priced.reduce((sum, movement) => sum + movement.quantity * movement.unitCost, 0) / pricedQuantity) : null;
    const below = item.minimum !== null && onHand <= item.minimum;
    return {
      id: item.id,
      number: item.number,
      name: item.name,
      unit: item.unit,
      onHand,
      minimum: item.minimum,
      supplier: item.supplier,
      leadTimeDays: item.leadTimeDays,
      averageCost,
      value: averageCost !== null ? money(Math.max(0, onHand) * averageCost) : null,
      status: below ? (onHand <= 0 ? "rupture" : "sous_minimum") : "ok",
      lastMovement: own.reduce((latest, movement) => (!latest || movement.day > latest ? movement.day : latest), null),
      // Ordered today, it arrives after the supplier's delay.
      orderBy: below && item.leadTimeDays !== null ? today : null,
      arrivesBy: below && item.leadTimeDays !== null ? addDays(today, item.leadTimeDays) : null
    };
  }).sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const since = addDays(today, -recentDays);
  const byOrder = new Map();
  for (const movement of live.filter((entry) => entry.kind === "sortie" && entry.orderNumber)) {
    const order = byOrder.get(movement.orderNumber) ?? new Map();
    const key = `${movement.name}|${movement.unit}`;
    order.set(key, round((order.get(key) ?? 0) - movement.quantity));
    byOrder.set(movement.orderNumber, order);
  }
  return {
    today,
    items,
    alerts: items.filter((item) => item.status !== "ok"),
    value: items.some((item) => item.value !== null) ? money(items.reduce((sum, item) => sum + (item.value ?? 0), 0)) : null,
    unpriced: items.filter((item) => item.value === null && item.onHand > 0).length,
    recent: state.movements.filter((movement) => movement.day >= since).sort((a, b) => b.day.localeCompare(a.day) || b.number - a.number),
    consumption: [...byOrder.entries()]
      .map(([orderNumber, lines]) => ({ orderNumber, lines: [...lines.entries()].map(([key, quantity]) => ({ name: key.split("|")[0], unit: key.split("|")[1], quantity })) }))
      .sort((a, b) => Number(b.orderNumber) - Number(a.orderNumber) || b.orderNumber.localeCompare(a.orderNumber))
  };
}

// The materials under their minimum, as facts for Amélioration: told to
// Achats, grave when nothing is left. A material without a minimum is never
// judged.
export function stockFacts(overview) {
  return overview.alerts.map((item) => {
    const empty = item.status === "rupture";
    const delay = item.leadTimeDays !== null ? ` Délai du fournisseur${item.supplier ? ` ${item.supplier}` : ""} : ${item.leadTimeDays} jour(s), commandé aujourd'hui il arrive vers le ${frenchDay(item.arrivesBy)}.` : item.supplier ? ` Fournisseur habituel : ${item.supplier}.` : "";
    return {
      source: "stock",
      key: `stock:${item.id}:${empty ? "rupture" : "minimum"}`,
      kind: empty ? "rupture_stock" : "stock_sous_minimum",
      severity: empty ? "haute" : "moyenne",
      owner: "purchasing",
      client: "",
      orderNumber: "",
      step: null,
      reference: item.name,
      fact: empty
        ? `Rupture de stock : ${item.name} (plus rien au registre, minimum ${quantityText(item.minimum, item.unit)}).${delay}`
        : `${item.name} : ${quantityText(item.onHand, item.unit)} en stock, au niveau ou sous le minimum de ${quantityText(item.minimum, item.unit)}.${delay}`
    };
  });
}
