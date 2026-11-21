import { MOVEMENT_KINDS, StockBookError, quantityText } from "./stock-book.js";
import { frenchDay } from "./sales-book.js";

// The agents' tools on the register of stock (stock-book.js). Achats keeps
// it; Production notes what it takes for a purchase order; the Director does
// all. Each answers in the agents' words and never throws the book's error.

const REGISTER_TOOL = Object.freeze({
  type: "function",
  name: "registre_stock",
  description: "Le registre de stock réel : chaque matière avec la quantité en stock, le minimum fixé par la direction, le fournisseur et son délai, le coût moyen d'achat ; les matières sous leur minimum ou en rupture ; les mouvements des 30 derniers jours ; ce que chaque bon de commande a consommé. À lire avant toute réponse sur le stock ou les achats.",
  parameters: { type: "object", additionalProperties: false, properties: {}, required: [] }
});

const ITEM_TOOL = Object.freeze({
  type: "function",
  name: "matiere_stock",
  description: "Ajoute une matière au registre de stock, ou change son minimum, son fournisseur ou son délai, sur ce que la direction dit (« on garde toujours 10 panneaux de MDF 18 mm », « les charnières viennent de chez X en 5 jours »). Jamais de minimum, de fournisseur ou de délai supposé.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["ajouter", "modifier", "retirer"], description: "retirer : la matière n'est plus suivie (ses mouvements restent)." },
      matiere: { type: "string", description: "Nom de la matière (« MDF 18 mm »)." },
      unite: { type: "string", description: "ajouter : l'unité de comptage (panneau, m², mètre linéaire, kg, litre, pièce) ; la demander si elle manque. Chaîne vide sinon." },
      minimum: { type: "string", description: "Stock minimum dit par la direction, dans l'unité ; « aucun » pour l'enlever ; chaîne vide si non dit." },
      fournisseur: { type: "string", description: "Fournisseur habituel s'il est dit ; chaîne vide sinon." },
      delai_jours: { type: "string", description: "Délai de livraison du fournisseur en jours s'il est dit ; chaîne vide sinon." }
    },
    required: ["action", "matiere", "unite", "minimum", "fournisseur", "delai_jours"]
  }
});

const MOVEMENT_TOOL = Object.freeze({
  type: "function",
  name: "mouvement_stock",
  description: "Note UN mouvement de stock qui a eu lieu : une entrée (livraison d'un fournisseur), une sortie (matière prise pour un bon de commande, ou perdue/abîmée) ou un inventaire (la quantité comptée ; le registre note l'écart). Une sortie ne peut pas dépasser le stock connu.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      matiere: { type: "string" },
      type: { type: "string", enum: Object.keys(MOVEMENT_KINDS) },
      quantite: { type: "number", description: "Entrée ou sortie : la quantité, dans l'unité de la matière. Inventaire : la quantité comptée (0 si plus rien)." },
      date: { type: "string", description: "JJ/MM/AAAA, ou chaîne vide pour aujourd'hui." },
      bon_commande: { type: "string", description: "Sortie : le numéro du BC pour lequel la matière est prise ; chaîne vide si perte ou casse." },
      fournisseur: { type: "string", description: "Entrée : le fournisseur s'il est dit ; chaîne vide sinon." },
      prix_unitaire_ht: { type: "string", description: "Entrée : prix unitaire HT en DH s'il est dit ; chaîne vide sinon, jamais supposé." },
      note: { type: "string", description: "Ce qui a été précisé (n° de bon de livraison, casse…) ; chaîne vide sinon." }
    },
    required: ["matiere", "type", "quantite", "date", "bon_commande", "fournisseur", "prix_unitaire_ht", "note"]
  }
});

const CANCEL_TOOL = Object.freeze({
  type: "function",
  name: "annuler_mouvement_stock",
  description: "Annule une ligne du registre de stock notée par erreur (numéro de ligne lu dans registre_stock). La ligne reste visible, barrée.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      numero: { type: "integer" },
      raison: { type: "string" }
    },
    required: ["numero", "raison"]
  }
});

export const DIRECTOR_STOCK_TOOLS = Object.freeze([REGISTER_TOOL, ITEM_TOOL, MOVEMENT_TOOL, CANCEL_TOOL]);
export const STOCK_TOOL_NAMES = Object.freeze(DIRECTOR_STOCK_TOOLS.map((tool) => tool.name));
const AGENT_TOOLS = Object.freeze({
  purchasing: DIRECTOR_STOCK_TOOLS,
  production: [REGISTER_TOOL, MOVEMENT_TOOL]
});

export function stockTools(context, agentId) {
  return (AGENT_TOOLS[agentId] ?? []).map((tool) => ({ tool, run: (args) => runStockTool(tool.name, args, context, agentId) }));
}

const text = (value) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
// "" is not said; « aucun » clears.
const said = (value) => {
  const raw = text(value);
  if (raw === "") {
    return undefined;
  }
  return /^(aucun|aucune|non|-)$/i.test(raw) ? "" : raw;
};

export async function runStockTool(name, args, { books }, by) {
  const stock = books?.stock;
  if (!stock) {
    return { ok: false, erreur: "Le registre de stock n'est pas disponible : je n'ai pas l'information." };
  }
  try {
    switch (name) {
      case REGISTER_TOOL.name:
        return describeOverview(await stock.overview());
      case ITEM_TOOL.name: {
        if (args.action === "ajouter") {
          const item = await stock.addItem({ name: args.matiere, unit: args.unite, minimum: said(args.minimum) ?? null, supplier: text(args.fournisseur), leadTimeDays: said(args.delai_jours) ?? null, by });
          return { ok: true, ajoutee: describeItem(item), suite: item.minimum === null ? "Pas de minimum : aucune alerte de stock pour cette matière tant que la direction n'en fixe pas." : undefined, stock_initial: "0 : noter le stock réel par un inventaire (mouvement_stock, type inventaire)." };
        }
        const item = await stock.updateItem(args.matiere, args.action === "retirer"
          ? { active: false, by }
          : { minimum: said(args.minimum), supplier: said(args.fournisseur), leadTimeDays: said(args.delai_jours), unit: said(args.unite), by });
        return { ok: true, [args.action === "retirer" ? "retiree" : "modifiee"]: describeItem(item) };
      }
      case MOVEMENT_TOOL.name: {
        const movement = await stock.record({ item: args.matiere, kind: args.type, quantity: args.quantite, date: args.date, orderNumber: args.bon_commande, supplier: args.fournisseur, unitCost: said(args.prix_unitaire_ht) ?? null, note: args.note, by });
        await books.team?.log({ agent: by in AGENT_TOOLS ? by : "purchasing", kind: "stock", text: `${movementLine(movement)}.`, ref: `stock:${movement.number}`, by }).catch(() => {});
        return { ok: true, ligne: movementLine(movement), en_stock: quantityText(movement.onHand, movement.unit) };
      }
      case CANCEL_TOOL.name: {
        const movement = await stock.cancel(args.numero, { reason: args.raison, by });
        return { ok: true, annulee: `ligne n° ${movement.number} (${MOVEMENT_KINDS[movement.kind]} de ${movement.name} du ${frenchDay(movement.day)})`, en_stock: quantityText(movement.onHand, movement.unit) };
      }
      default:
        return { ok: false, erreur: `Outil de stock inconnu : ${name}.` };
    }
  } catch (error) {
    if (error instanceof StockBookError) {
      return { ok: false, erreur: error.message };
    }
    throw error;
  }
}

function describeItem(item) {
  return [
    `${item.name} (en ${item.unit})`,
    item.minimum !== null ? `minimum ${quantityText(item.minimum, item.unit)}` : "sans minimum",
    item.supplier ? `fournisseur ${item.supplier}` : "",
    item.leadTimeDays !== null ? `délai ${item.leadTimeDays} j` : ""
  ].filter(Boolean).join(", ");
}

export function movementLine(movement) {
  const what = movement.kind === "inventaire"
    ? `Inventaire de ${movement.name} : ${quantityText(movement.counted, movement.unit)} comptés (écart ${movement.quantity > 0 ? "+" : ""}${quantityText(movement.quantity, movement.unit)})`
    : `${MOVEMENT_KINDS[movement.kind]} de ${quantityText(Math.abs(movement.quantity), movement.unit)} de ${movement.name}`;
  return [
    `n° ${movement.number} ${frenchDay(movement.day)} : ${what}`,
    movement.orderNumber ? `pour le BC n° ${movement.orderNumber}` : movement.kind === "sortie" ? "hors commande" : "",
    movement.supplier ? `de ${movement.supplier}` : "",
    movement.unitCost !== null && movement.unitCost !== undefined ? `à ${movement.unitCost} DH HT l'unité` : "",
    movement.note ? `(${movement.note})` : "",
    movement.cancelled ? `— ANNULÉE : ${movement.cancelled.reason}` : ""
  ].filter(Boolean).join(" ");
}

function describeOverview(overview) {
  if (overview.items.length === 0) {
    return { ok: true, info: "Le registre de stock est vide : aucune matière n'est encore suivie. Demande à la direction quelles matières elle garde en stock (nom, unité, minimum, fournisseur), puis note le stock réel par un inventaire." };
  }
  return {
    ok: true,
    source: "registre de stock du cockpit (données réelles)",
    matieres: overview.items.map((item) => [
      `${item.name} : ${quantityText(item.onHand, item.unit)}`,
      item.minimum !== null ? `minimum ${quantityText(item.minimum, item.unit)}` : "sans minimum",
      item.status === "rupture" ? "RUPTURE" : item.status === "sous_minimum" ? "SOUS LE MINIMUM" : "",
      item.supplier ? `fournisseur ${item.supplier}` : "",
      item.leadTimeDays !== null ? `délai ${item.leadTimeDays} j` : "",
      item.averageCost !== null ? `coût moyen ${item.averageCost} DH HT` : ""
    ].filter(Boolean).join(", ")),
    a_commander: overview.alerts.map((item) => `${item.name} : ${quantityText(item.onHand, item.unit)} pour un minimum de ${quantityText(item.minimum, item.unit)}${item.arrivesBy ? ` ; commandé aujourd'hui, arrive vers le ${frenchDay(item.arrivesBy)}` : " ; délai du fournisseur inconnu"}`),
    valeur_du_stock_ht: overview.value !== null ? `${overview.value} DH${overview.unpriced > 0 ? ` (sans ${overview.unpriced} matière(s) dont aucune entrée n'a de prix)` : ""}` : "inconnue : aucune entrée n'a de prix",
    mouvements_30_jours: overview.recent.slice(0, 40).map(movementLine),
    consommation_par_bc: overview.consumption.slice(0, 15).map((order) => `BC n° ${order.orderNumber} : ${order.lines.map((line) => quantityText(line.quantity, line.unit) + " de " + line.name).join(", ")}`)
  };
}
