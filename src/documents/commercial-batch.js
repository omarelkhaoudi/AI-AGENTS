import { DocumentCalculationError } from "./document-calculations.js";
import { createDocumentBundle } from "./document-bundle-service.js";
import { HKIDS_DOCUMENT_TYPES } from "./document-schema.js";
import { DocumentValidationError, validateAndPrepareDocument } from "./document-validation.js";

/**
 * The twenty commercial files of the official H-KIDS test, and the separate
 * Salma quote.
 *
 * Each file is one quote, one invoice and one delivery note of the same order —
 * sixty documents. They are not built here: they are built by
 * createDocumentBundle, from one set of lines and one calculation, exactly like
 * every other commercial file. This module holds what the test says and nothing
 * else, and reports what the test does not say.
 *
 * What the official test gives, and what it does not
 * --------------------------------------------------
 * It gives, for each of the twenty files: the customer, the city, the three
 * document numbers, every line — its designation, its quantity and its price —,
 * the rebate and the lines it applies to, the VAT, the totals, the payment plan,
 * and, for most files, the project and the children the room is for.
 *
 * It gives no unit for any line, no date for any document, no payment method, and
 * no postal address beyond the city. None is written here. The city is what the
 * documents carry as the customer's address; the validator refuses a document
 * without a date or a payment method, and an invoice line without a unit, so those
 * documents cannot be issued until the data is supplied.
 *
 * File 7's rebate is a fixed 2 333,33 taken on the document as a whole — not a
 * percentage, and not a share of any line. It is written as `rebate.fixedAmount`,
 * and the engine takes it off the total once the lines are computed, so every
 * line keeps its own amounts.
 *
 * Ready for review, ready to issue
 * --------------------------------
 * Two states, and neither stands for the other. A file is ready for review when
 * it is built and every line is named: it can be shown and checked. It is ready
 * to issue only when its three documents are accepted by the validator, as they
 * would be at generation, and nothing the bundle reports holds it back. Being
 * ready to issue is not being approved: generating a document still asks a
 * person to confirm it.
 */

// The numbers the official test imposes. They are read as written — "61", "35" —
// and not reformatted: the register is what names a document, not this module.
export const BATCH_NUMBER_RANGES = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.QUOTE]: Object.freeze({ first: 61, last: 80 }),
  [HKIDS_DOCUMENT_TYPES.INVOICE]: Object.freeze({ first: 35, last: 54 }),
  [HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE]: Object.freeze({ first: 35, last: 54 })
});

export const BATCH_TVA_RATE = 0.2;

export const BATCH_MISSING_REASONS = Object.freeze({
  LINE_DESIGNATION: "Désignation d'article absente du test officiel H-KIDS : à fournir avant émission.",
  LINES_UNAVAILABLE: "Dossier non constructible en l'état : ses lignes ne sont pas disponibles."
});

export class CommercialBatchError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "CommercialBatchError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// A line of the official test: its designation, its price and its quantity,
// exactly as the test writes them. No unit: the test states none.
function line(designation, unitPriceHt, quantity = 1) {
  return Object.freeze({ designation, quantity, unitPriceHt });
}

function lines(...entries) {
  return Object.freeze(entries);
}

// A line whose official designation states a price, and the words the delivery
// note repeats instead: the test's own, in its order, with only the price left
// out. They are written here, never cut out of the official text by a pattern,
// and the quote and the invoice keep the official designation. To be confirmed
// by H-KIDS.
function deliveredAs(entry, deliveryNoteDesignation) {
  return Object.freeze({ ...entry, deliveryNoteDesignation });
}

/**
 * The twenty files, in the order the official test numbers them.
 *
 * The lines are in the test's own order, each designation on the line of its
 * amount. `rebate` carries the percentage and the lines it applies to, both
 * stated by the test: file 3 takes its 5 % on the mezzanine bed alone, file 17
 * takes its 5 % on the play areas and not on the delivery. Nothing here chooses a
 * target; the test does. File 7's rebate is not a percentage: it is a fixed
 * amount taken on the document as a whole, and names no line.
 *
 * `brief` holds the project and the children the room is for, where the test
 * states them. `excluded`, `note` and `constraint` hold what the test says about
 * the file in its own words. None of them is ever turned into a line: file 1's rug
 * is visible in the room and is not part of the order.
 */
export const HKIDS_BATCH_SCENARIOS = Object.freeze([
  Object.freeze({
    index: 1,
    client: Object.freeze({ name: "Lina Berrada", city: "Marrakech" }),
    brief: Object.freeze({ project: "Chambre cabane Montessori", children: "fille, 4 ans" }),
    numbers: Object.freeze({ quote: "61", invoice: "35", deliveryNote: "35" }),
    lines: lines(
      line("Lit cabane Montessori 190×90", 4500),
      line("Matelas 190×90", 1600),
      line("Tour de lit tressé quatre brins", 1500),
      line("Voile de lit", 750),
      line("Deux attaches murales papillon", 200)
    ),
    paymentScheduleRuleId: "hkids-60-20-20-2026",
    excluded: Object.freeze(["Un tapis est visible mais ne doit PAS être inclus dans les lignes."])
  }),
  Object.freeze({
    index: 2,
    client: Object.freeze({ name: "Youssef Alaoui", city: "Casablanca" }),
    brief: Object.freeze({ project: "chambre pour deux garçons", children: "garçons, 6 ans et 9 ans" }),
    numbers: Object.freeze({ quote: "62", invoice: "36", deliveryNote: "36" }),
    lines: lines(
      line("Lit superposé cabane avec toboggan", 18000),
      line("Mur d’escalade", 3200),
      line("Livraison/install", 2500)
    ),
    paymentScheduleRuleId: "hkids-60-20-20-2026",
    excluded: Object.freeze(["Les matelas sont exclus."])
  }),
  Object.freeze({
    index: 3,
    client: Object.freeze({ name: "Ghita Amrani", city: "Rabat" }),
    brief: Object.freeze({ children: "garçon, 10 ans" }),
    numbers: Object.freeze({ quote: "63", invoice: "37", deliveryNote: "37" }),
    lines: lines(
      line("Lit mezzanine avec couchage 190×140", 24000),
      line("Escalier rangements", 4800),
      line("Éclairage LED", 4500),
      line("Livraison/install", 2000)
    ),
    // "Remise : 5 % uniquement sur le lit mezzanine" — the first line, and no other.
    rebate: Object.freeze({ percent: 5, appliesToIndexes: Object.freeze([0]), label: "Remise" }),
    paymentScheduleRuleId: "hkids-60-20-20-2026"
  }),
  Object.freeze({
    index: 4,
    client: Object.freeze({ name: "Sara El Idrissi", city: "Agadir" }),
    brief: Object.freeze({ children: "fille, 8 ans" }),
    numbers: Object.freeze({ quote: "64", invoice: "38", deliveryNote: "38" }),
    lines: lines(
      line("Armoire trois portes", 14000),
      line("Coin bureau mural évolutif", 8500),
      line("Table d’activité", 3800),
      line("Papier peint floral", 2300)
    ),
    paymentScheduleRuleId: "hkids-60-20-20-2026",
    note: Object.freeze(["Livraison gratuite / aucune ligne de livraison payante."])
  }),
  Object.freeze({
    index: 5,
    client: Object.freeze({ name: "Mehdi Tazi", city: "Marrakech" }),
    brief: Object.freeze({ project: "chambre pour deux garçons", children: "deux garçons" }),
    numbers: Object.freeze({ quote: "65", invoice: "39", deliveryNote: "39" }),
    lines: lines(
      line("Lit inférieur 190×120 et lit supérieur 190×90", 26500),
      line("Bibliothèque murale", 2800),
      line("Papier peint thème espace", 3500),
      line("Livraison/install", 1500)
    ),
    paymentScheduleRuleId: "hkids-60-20-20-2026",
    constraint: Object.freeze(["Largeur disponible limitée à 2,50 m."])
  }),
  Object.freeze({
    index: 6,
    client: Object.freeze({ name: "Meryem Benjelloun", city: "Casablanca" }),
    numbers: Object.freeze({ quote: "66", invoice: "40", deliveryNote: "40" }),
    lines: lines(
      line("Réaménagement placard n°1", 6500),
      line("Réaménagement placard n°2", 6500),
      line("Habillage extérieur et nouvelles portes", 38000),
      line("Livraison/install", 2500)
    ),
    // "Remise : 10 % uniquement sur les deux placards" — nothing on the outer
    // cladding, nothing on the delivery.
    rebate: Object.freeze({ percent: 10, appliesToIndexes: Object.freeze([0, 1]), label: "Remise" }),
    paymentScheduleRuleId: "hkids-60-20-20-2026"
  }),
  Object.freeze({
    index: 7,
    client: Object.freeze({ name: "École Les Petits Explorateurs", city: "Marrakech" }),
    numbers: Object.freeze({ quote: "67", invoice: "41", deliveryNote: "41" }),
    lines: lines(
      line("Meuble TV et espace créatif", 19500),
      line("Banquette de lecture", 14500),
      line("Tableau noir mural", 5500),
      line("Éclairage LED", 2500),
      line("Livraison/install", 2000)
    ),
    // "Remise exceptionnelle fixe : 2 333,33 DH" — an amount taken off the document
    // as a whole: not a percentage, and no line carries any of it.
    rebate: Object.freeze({ fixedAmount: 2333.33, label: "Remise exceptionnelle" }),
    paymentScheduleRuleId: "hkids-60-20-20-2026"
  }),
  Object.freeze({
    index: 8,
    client: Object.freeze({ name: "Crèche Happy Kids SARL", city: "Tanger" }),
    numbers: Object.freeze({ quote: "68", invoice: "42", deliveryNote: "42" }),
    lines: lines(
      line("Maison immersive", 10500),
      line("Supermarché enfants", 13000),
      line("Salon coiffure", 14000),
      line("Espace vétérinaire", 9500),
      line("Espace restaurant", 12000),
      line("Livraison/install", 3000)
    ),
    paymentScheduleRuleId: "hkids-60-20-20-2026",
    // Stated by the first summary of the test, not repeated by the full request.
    note: Object.freeze(["Client professionnel."])
  }),
  Object.freeze({
    index: 9,
    client: Object.freeze({ name: "Fun Garden SARL", city: "Fès" }),
    numbers: Object.freeze({ quote: "69", invoice: "43", deliveryNote: "43" }),
    lines: lines(
      line("Mezzanine centrale", 28000),
      line("Piscine à balles", 24000),
      line("Zone bébés", 18000),
      line("Lanceur de balles", 14000),
      line("Papier peint personnalisé", 3500)
    ),
    // Exception stated by the test. It is never replaced by the standard plan.
    paymentScheduleRuleId: "hkids-50-30-20-exception"
  }),
  Object.freeze({
    index: 10,
    client: Object.freeze({ name: "Imane Chraïbi", city: "Marrakech" }),
    brief: Object.freeze({ project: "chambre bébé", children: "fille" }),
    numbers: Object.freeze({ quote: "70", invoice: "44", deliveryNote: "44" }),
    lines: lines(
      line("Lit tapissé 140 cm", 7500),
      line("Matelas", 1600),
      line("Tour de lit tressé", 1500),
      line("Voile", 750),
      line("Tapis tressé", 2300),
      line("Livraison/install", 1200)
    ),
    paymentScheduleRuleId: "hkids-60-20-20-2026"
  }),
  Object.freeze({
    index: 11,
    client: Object.freeze({ name: "Lamia Kadiri", city: "El Jadida" }),
    brief: Object.freeze({ project: "chambre pour deux filles", children: "jumelles" }),
    numbers: Object.freeze({ quote: "71", invoice: "45", deliveryNote: "45" }),
    lines: lines(
      // One line for the two beds, and one for the two mattresses: the test
      // writes 1 × 17 000 and 1 × 3 200, and no quantity 2 is made of them.
      line("Deux lits tapissés de 160 cm", 17000),
      deliveredAs(line("Deux matelas à 1600 DH", 3200), "Deux matelas"),
      line("Table de nuit commune", 1500)
    ),
    // "Remise : 7 % uniquement sur les deux lits" — the first line.
    rebate: Object.freeze({ percent: 7, appliesToIndexes: Object.freeze([0]), label: "Remise" }),
    paymentScheduleRuleId: "hkids-60-20-20-2026"
  }),
  Object.freeze({
    index: 12,
    client: Object.freeze({ name: "Amine Ouazzani", city: "Rabat" }),
    brief: Object.freeze({ children: "garçon, 6 ans" }),
    numbers: Object.freeze({ quote: "72", invoice: "46", deliveryNote: "46" }),
    lines: lines(
      line("Lit cabane dinosaure", 9000),
      line("Bureau bibliothèque", 6800),
      line("Papier peint dinosaure", 3200),
      line("Éclairage intégré", 4500),
      line("Livraison/install", 1800)
    ),
    paymentScheduleRuleId: "hkids-60-20-20-2026"
  }),
  Object.freeze({
    index: 13,
    client: Object.freeze({ name: "Sofia Lahlou", city: "Casablanca" }),
    brief: Object.freeze({ children: "fille, 7 ans" }),
    numbers: Object.freeze({ quote: "73", invoice: "47", deliveryNote: "47" }),
    lines: lines(
      line("Lit château avec deux tours", 16500),
      line("Toboggan et escalier rangement", 14000),
      line("Bureau mural", 8500),
      line("Papier peint château", 3500),
      line("Livraison/install", 2500)
    ),
    paymentScheduleRuleId: "hkids-60-20-20-2026",
    constraint: Object.freeze(["Couleurs : crème / violet / rose poudré."])
  }),
  Object.freeze({
    index: 14,
    client: Object.freeze({ name: "Résidence Familiale Ennakhil", city: "Marrakech" }),
    numbers: Object.freeze({ quote: "74", invoice: "48", deliveryNote: "48" }),
    // The only quantity above one in the twenty files: three dressings at 4 800.
    // The quantity travels to the three documents.
    lines: lines(
      line("Dressings", 4800, 3),
      line("Livraison/install", 1200)
    ),
    paymentScheduleRuleId: "hkids-60-20-20-2026"
  }),
  Object.freeze({
    index: 15,
    client: Object.freeze({ name: "Kenza Bennani", city: "Tanger" }),
    brief: Object.freeze({ children: "garçon, 9 ans" }),
    numbers: Object.freeze({ quote: "75", invoice: "49", deliveryNote: "49" }),
    lines: lines(
      line("Mezzanine bibliothèque éclairage", 32000),
      line("Échelle suédoise", 3800),
      line("Mur escalade", 2800),
      line("Papier peint", 2300)
    ),
    paymentScheduleRuleId: "hkids-60-20-20-2026"
  }),
  Object.freeze({
    index: 16,
    client: Object.freeze({ name: "Hanane El Fassi", city: "Marrakech" }),
    brief: Object.freeze({ project: "chambre pour deux enfants" }),
    numbers: Object.freeze({ quote: "76", invoice: "50", deliveryNote: "50" }),
    lines: lines(
      // One line for the two packs, as the test writes it: 1 × 13 800.
      deliveredAs(line("Deux packs lits cabanes à 6 900 DH", 13800), "Deux packs lits cabanes"),
      line("Tapis tressé", 2300),
      line("Livraison", 1500)
    ),
    // Exception stated by the test: the whole amount on order, and no 60 %.
    paymentScheduleRuleId: "hkids-100-exception"
  }),
  Object.freeze({
    index: 17,
    client: Object.freeze({ name: "Crèche Les Mini-Mondes SARL", city: "Agadir" }),
    numbers: Object.freeze({ quote: "77", invoice: "51", deliveryNote: "51" }),
    lines: lines(
      line("Espace restaurant", 12000),
      line("Vétérinaire", 9500),
      line("Hôpital", 9500),
      line("Zone bébé", 18000),
      line("Livraison/install", 2500)
    ),
    // "Remise : 5 % uniquement sur les espaces de jeu, hors livraison" — the four
    // play areas, and not the delivery.
    rebate: Object.freeze({ percent: 5, appliesToIndexes: Object.freeze([0, 1, 2, 3]), label: "Remise" }),
    paymentScheduleRuleId: "hkids-60-20-20-2026"
  }),
  Object.freeze({
    index: 18,
    client: Object.freeze({ name: "Nadia Filali", city: "Marrakech" }),
    brief: Object.freeze({ project: "chambre fille + garçon" }),
    numbers: Object.freeze({ quote: "78", invoice: "52", deliveryNote: "52" }),
    lines: lines(
      line("Lit Montessori bleu pastel", 8500),
      line("Lit Montessori rose poudré", 8500),
      line("Armoire partagée", 6500),
      line("Papier peint personnalisé", 3400),
      line("Livraison/install", 2000)
    ),
    paymentScheduleRuleId: "hkids-60-20-20-2026"
  }),
  Object.freeze({
    index: 19,
    client: Object.freeze({ name: "Karim Bennis", city: "Casablanca" }),
    brief: Object.freeze({ children: "garçon, 11 ans" }),
    numbers: Object.freeze({ quote: "79", invoice: "53", deliveryNote: "53" }),
    lines: lines(
      line("Lit mezzanine", 24000),
      line("Éclairage LED", 4500),
      line("Échelle suédoise", 3800),
      line("Livraison/install", 2500)
    ),
    // Exception stated by the test.
    paymentScheduleRuleId: "hkids-40-40-20-exception",
    // The file is urgent, and no delivery date is written: the delivery note says
    // "à définir" like every other.
    note: Object.freeze(["Le dossier est urgent.", "NE PAS inventer ni promettre une date de livraison."])
  }),
  Object.freeze({
    index: 20,
    client: Object.freeze({ name: "Asmae Naciri", city: "Safi" }),
    brief: Object.freeze({ children: "fille, 5 ans" }),
    numbers: Object.freeze({ quote: "80", invoice: "54", deliveryNote: "54" }),
    lines: lines(
      line("Dressing compact", 6500),
      line("Bureau évolutif", 4800),
      line("Papier peint floral", 2300),
      line("Livraison/install", 1000)
    ),
    paymentScheduleRuleId: "hkids-60-20-20-2026",
    excluded: Object.freeze(["Ne pas ajouter de lit."])
  })
]);

// A line of the Salma quote: the short designation the line is known by, and the
// complete designation the request gives, line by line and word for word.
function salmaLine(designation, unitPriceHt, fullDesignation) {
  return Object.freeze({ designation, quantity: 1, unitPriceHt, fullDesignation: Object.freeze(fullDesignation) });
}

/**
 * The Salma El Mansouri quote: a separate file, never one of the twenty.
 *
 * It carries no number. A quote number comes from the official register, and
 * without one the bundle marks the quote as waiting for it; nothing here assigns
 * one, and nothing here touches the 61–80 run.
 *
 * `toConfirm` is the request's own list of what is still to be confirmed with the
 * customer. It is the same list the missing-information review asks for, so the
 * bundle's project information is left empty and reported missing.
 */
export const HKIDS_SALMA_QUOTE = Object.freeze({
  client: Object.freeze({
    name: "Salma El Mansouri",
    address: "Résidence Les Jardins d’Anfa, immeuble B, appartement 12, Casablanca",
    phone: "06 45 32 18 70",
    email: "salma.elmansouri@example.com"
  }),
  brief: Object.freeze({ project: "Aménagement complet d’une chambre pour deux enfants" }),
  deliveryCity: "Casablanca",
  lines: lines(
    salmaLine("Lit mezzanine sur mesure", 24000, [
      "Conception et fabrication d’un lit mezzanine sur mesure comprenant :",
      "* un couchage supérieur de 190 × 90 cm ;",
      "* un couchage inférieur de 190 × 140 cm ;",
      "* une structure en bois et panneaux de qualité adaptés au mobilier pour enfants ;",
      "* un escalier latéral avec rangements intégrés ;",
      "* un garde-corps de sécurité ;",
      "* un portillon de sécurité en partie haute ;",
      "* un petit toboggan latéral ;",
      "* une finition en peinture blanc cassé et vert pastel ;",
      "* des poignées adaptées au thème de la chambre."
    ]),
    salmaLine("Matelas enfant", 1600, [
      "Fourniture d’un matelas pour le couchage supérieur :",
      "* dimensions : 190 × 90 cm ;",
      "* épaisseur adaptée à la hauteur du garde-corps ;",
      "* housse déhoussable ;",
      "* densité adaptée à un usage quotidien."
    ]),
    salmaLine("Bureau évolutif", 6800, [
      "Conception et fabrication d’un bureau évolutif comprenant :",
      "* un plateau de travail ;",
      "* des rangements latéraux ;",
      "* deux tiroirs ;",
      "* une petite bibliothèque supérieure ;",
      "* des passe-câbles ;",
      "* une finition blanc cassé, vert pastel et chêne clair."
    ]),
    salmaLine("Armoire trois portes", 8900, [
      "Conception et fabrication d’une armoire sur mesure comprenant :",
      "* trois portes battantes ;",
      "* une partie penderie ;",
      "* une partie avec étagères ;",
      "* trois tiroirs en partie basse ;",
      "* un espace inférieur destiné au rangement des chaussures ;",
      "* des poignées décoratives ;",
      "* une finition blanc cassé et vert pastel."
    ]),
    salmaLine("Papier peint personnalisé", 3400, [
      "Création graphique, impression et pose d’un papier peint personnalisé sur le mur principal de la chambre.",
      "Dimensions du mur : 4,00 × 3,00 mètres",
      "Thème : Forêt douce et animaux",
      "Couleurs : Vert pastel, beige, blanc cassé et touches de rose poudré",
      "Exigence : Impression en haute définition et pose en lés verticaux"
    ]),
    salmaLine("Éclairage LED indirect", 4500, [
      "Fourniture et intégration d’un système d’éclairage LED indirect dans la mezzanine et le bureau.",
      "Le prix comprend :",
      "* les rubans LED ;",
      "* les profilés ;",
      "* les alimentations ;",
      "* le câblage ;",
      "* l’intégration dans le mobilier ;",
      "* les tests de fonctionnement."
    ]),
    salmaLine("Livraison et installation", 2500, [
      "Livraison à Casablanca, montage, installation, réglage et contrôle final de l’ensemble du mobilier."
    ])
  ),
  // "Remise commerciale : 5 % uniquement sur les articles 1, 3 et 4."
  rebate: Object.freeze({ percent: 5, appliesToIndexes: Object.freeze([0, 2, 3]), label: "Remise commerciale" }),
  paymentScheduleRuleId: "hkids-60-20-20-2026",
  leadTime: "8 à 10 semaines",
  conditions: Object.freeze([
    "mobilier sur mesure ;",
    "ferme après signature + acompte ;",
    "produits personnalisés/non annulables et non remboursables après lancement de production ;",
    "validation finale des couleurs ;",
    "dimensions confirmées avant production ;",
    "garantie d’accès ;",
    "raccordements électriques muraux et maçonnerie exclus ;",
    "objets décoratifs présents dans les visuels 3D exclus sauf mention contraire ;",
    "matelas du couchage inférieur exclu ;",
    "tout service non mentionné = devis complémentaire ;",
    "livraison uniquement à l’adresse indiquée ;",
    "garantie de 12 mois contre les défauts de fabrication ;",
    "garantie excluant chocs, humidité, mauvaise utilisation et modifications par des tiers ;",
    "devis valable 15 jours à compter de sa date d’émission."
  ]),
  toConfirm: Object.freeze([
    "date exacte de livraison souhaitée ;",
    "adresse complète avec étage/ascenseur ;",
    "dimensions définitives sur site ;",
    "position exacte du toboggan ;",
    "emplacement des prises électriques ;",
    "couleurs finales ;",
    "modèle final des poignées ;",
    "visuel final du papier peint ;",
    "accès camion ;",
    "identité de la personne présente lors de l’installation."
  ])
});

// A line the official test does not name. A blank designation is an absent one:
// a line called " " is not named either.
//
// The unit is deliberately not checked. The official test states none, and
// holding a file back from review for it would be inventing a rule nobody asked
// for. The validator does require a unit on an invoice line, and that is where
// it counts: in readyToIssue, which reads the validator, not in this review.
function designationMissing(line) {
  return typeof line.designation !== "string" || line.designation.trim() === "";
}

/**
 * What a file's lines do not say. One entry per line with no designation, and one
 * for a file that cannot be built at all.
 *
 * This is the batch's own review: the bundle carries a line with no designation
 * without complaining, because a designation is checked when a document is
 * validated for issue, not when the amounts are computed. A batch that is
 * prepared and not yet issued would therefore look complete, and it is not.
 *
 * A line that has been named is not reported. The review reads the lines it is
 * given, so a name that goes missing is reported again.
 */
export function reviewBatchLines(scenario) {
  if (!scenario.lines) {
    return Object.freeze([Object.freeze({
      file: scenario.index,
      field: "lines",
      status: "missing",
      critical: true,
      message: BATCH_MISSING_REASONS.LINES_UNAVAILABLE
    })]);
  }

  const missing = [];
  scenario.lines.forEach((line, index) => {
    if (!designationMissing(line)) {
      return;
    }
    missing.push(Object.freeze({
      file: scenario.index,
      // The real index of the line, so a report names the line that is short.
      field: `lines.${index}.designation`,
      status: "missing",
      critical: true,
      message: BATCH_MISSING_REASONS.LINE_DESIGNATION
    }));
  });

  return Object.freeze(missing);
}

function bundleInputFor(scenario) {
  return {
    client: { name: scenario.client.name, address: scenario.client.city },
    items: scenario.lines.map((entry) => ({ ...entry })),
    tvaRate: BATCH_TVA_RATE,
    // The rebate is written as the test names it: a percentage with its lines, or
    // file 7's fixed amount, which names none.
    discount: scenario.rebate
      ? {
        ...scenario.rebate,
        ...(scenario.rebate.appliesToIndexes ? { appliesToIndexes: [...scenario.rebate.appliesToIndexes] } : {})
      }
      : null,
    paymentScheduleRuleId: scenario.paymentScheduleRuleId,
    // The dates and the payment method travel exactly as the file states them.
    // The official test gives neither, so both stay absent: the bundle writes an
    // empty date and an empty method, which the validator refuses, and the
    // delivery date reads "à définir". Nothing is filled in here.
    dates: { ...scenario.dates },
    paymentMethod: scenario.paymentMethod,
    numbers: { ...scenario.numbers }
  };
}

// What the bundle reports without it stopping the three documents being issued.
// Every other code stops them, a code added later that this list does not know
// included: an unknown reason to hold a file back is a reason to hold it back.
//
// PROJECT_INFORMATION_MISSING is what the installation needs: the floor, the
// lift, the truck access, the delivery date the customer wants. None of it is
// printed on the quote, the invoice or the delivery note, and the delivery note
// has to read "à définir" while the date is unknown. Holding the documents back
// for it would turn an installation question into an issuing rule. It stays in
// the review's `reported`, so it still reaches whoever asks the customer.
//
// DELIVERABLE_AUDIENCE_UNCONFIRMED asks whether three annexes — the order
// summary, the calculation sheet, the missing-information list — go to the
// customer. It is a question about the annexes, not about the three documents.
//
// This is why isBundleReadyToIssue is not read here: it holds a file back for
// both, so no file of the official test could ever be ready.
export const ISSUE_CODES_NOT_BLOCKING_ISSUE = Object.freeze([
  "PROJECT_INFORMATION_MISSING",
  "DELIVERABLE_AUDIENCE_UNCONFIRMED"
]);

// What the validator refuses a document for, as it words it. It reports a
// document it can read as a list of errors, and throws on a rebate it cannot
// compute: both are refusals of the document. Anything else is a fault in the
// code, and is not passed off as a refusal.
function refusalsOf(document, options) {
  try {
    validateAndPrepareDocument(document, options);
    return Object.freeze([]);
  } catch (error) {
    if (error instanceof DocumentValidationError) {
      return error.errors;
    }
    if (error instanceof DocumentCalculationError) {
      return Object.freeze([Object.freeze({
        field: null,
        code: error.code,
        message: error.message,
        details: error.details
      })]);
    }
    throw error;
  }
}

/**
 * What stands between a built file and its issue.
 *
 * Its three documents, each read by validateAndPrepareDocument as it would be at
 * generation — the invoice checked against this file's quote number — and the
 * bundle's own issues: the documents agreeing with one another, every number
 * assigned, a payment schedule chosen.
 *
 * No rule is added and nothing is computed here: every refusal is the
 * validator's or the bundle's, reported as they word it. Nothing is rendered
 * either; a document is read, never generated.
 */
export function reviewFileIssue(bundle) {
  const { quote, invoice, deliveryNote } = bundle.documents;
  const documents = Object.freeze({
    quote: refusalsOf(quote),
    invoice: refusalsOf(invoice, { relatedDocuments: { quoteNumber: quote.documentNumber } }),
    deliveryNote: refusalsOf(deliveryNote)
  });
  const blocking = bundle.issues.filter((issue) => !ISSUE_CODES_NOT_BLOCKING_ISSUE.includes(issue.code));
  const reported = bundle.issues.filter((issue) => ISSUE_CODES_NOT_BLOCKING_ISSUE.includes(issue.code));

  return Object.freeze({
    documents,
    blocking: Object.freeze(blocking),
    reported: Object.freeze(reported),
    ready: Object.values(documents).every((errors) => errors.length === 0) && blocking.length === 0
  });
}

/**
 * Prepares the twenty files.
 *
 * A file that cannot be built is reported as blocked rather than built from part
 * of what it needs: it keeps its numbers and its stated totals so it can be
 * completed, and it carries no document.
 */
export function createCommercialBatch({ scenarios = HKIDS_BATCH_SCENARIOS } = {}) {
  const files = scenarios.map((scenario) => {
    const missing = reviewBatchLines(scenario);
    if (!scenario.lines) {
      return Object.freeze({
        file: scenario.index,
        scenario,
        numbers: scenario.numbers,
        bundle: null,
        blocked: true,
        missing,
        readyForReview: false,
        issueReview: null,
        readyToIssue: false
      });
    }

    const bundle = createDocumentBundle(bundleInputFor(scenario));
    // Ready for review: built, and every line named. It says nothing of the
    // unit, the date or the payment method.
    const readyForReview = missing.length === 0;
    // Ready to issue: that, and the validator accepts the three documents.
    // Both flags are computed, never asserted.
    const issueReview = reviewFileIssue(bundle);
    return Object.freeze({
      file: scenario.index,
      scenario,
      numbers: scenario.numbers,
      bundle,
      blocked: false,
      missing,
      readyForReview,
      issueReview,
      readyToIssue: readyForReview && issueReview.ready
    });
  });

  return Object.freeze({
    files: Object.freeze(files),
    numbering: reviewBatchNumbering(files),
    missing: Object.freeze(files.flatMap((entry) => entry.missing)),
    readyForReview: files.every((entry) => entry.readyForReview),
    readyToIssue: files.every((entry) => entry.readyToIssue)
  });
}

/**
 * The numbers of the batch, read as a register would read them: a continuous
 * run with no hole and no number used twice.
 */
export function reviewBatchNumbering(files) {
  const review = {};

  for (const [documentType, range] of Object.entries(BATCH_NUMBER_RANGES)) {
    const key = documentType === HKIDS_DOCUMENT_TYPES.DELIVERY_NOTE ? "deliveryNote" : documentType;
    const numbers = files.map((entry) => Number(entry.numbers[key]));
    const expected = [];
    for (let value = range.first; value <= range.last; value += 1) {
      expected.push(value);
    }

    const seen = new Set();
    const duplicates = [];
    for (const number of numbers) {
      if (seen.has(number)) {
        duplicates.push(number);
      }
      seen.add(number);
    }

    review[key] = Object.freeze({
      first: range.first,
      last: range.last,
      numbers: Object.freeze([...numbers]),
      gaps: Object.freeze(expected.filter((value) => !seen.has(value))),
      duplicates: Object.freeze(duplicates),
      outOfRange: Object.freeze(numbers.filter((value) => value < range.first || value > range.last)),
      continuous: expected.length === seen.size && duplicates.length === 0
    });
  }

  return Object.freeze(review);
}

/**
 * The three documents of one file, checked against each other on the facts a
 * reader compares: who it is for, what is on it, and what it refers to.
 */
export function reviewFileCoherence(entry) {
  if (entry.blocked) {
    throw new CommercialBatchError(
      `File ${entry.file} has no documents: it is blocked.`,
      "FILE_BLOCKED",
      { file: entry.file }
    );
  }

  const { quote, invoice, deliveryNote } = entry.bundle.documents;
  return Object.freeze({
    sameClient: quote.client.name === invoice.client.name
      && invoice.client.name === deliveryNote.client.name
      && quote.client.address === invoice.client.address
      && invoice.client.address === deliveryNote.client.address,
    sameLineCount: quote.items.length === invoice.items.length
      && invoice.items.length === deliveryNote.items.length,
    sameQuantities: quote.items.every((item, index) => item.quantity === deliveryNote.items[index].quantity),
    invoiceReferencesQuote: invoice.quoteReference === quote.documentNumber,
    deliveryNoteReferencesQuote: deliveryNote.quoteReference === quote.documentNumber,
    deliveryNoteReferencesInvoice: deliveryNote.invoiceReference === invoice.documentNumber,
    deliveryNoteCarriesNoPrice: deliveryNote.items.every(
      (item) => item.unitPriceHt === undefined && item.amountHt === undefined && item.totalTtc === undefined
    ) && deliveryNote.totals === undefined
  });
}
