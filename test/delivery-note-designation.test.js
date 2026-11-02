import assert from "node:assert/strict";
import test from "node:test";
import { validateAndPrepareDocument } from "../src/index.js";
import {
  createDocumentBundle,
  designationStatesPrice,
  validateDocumentBundle
} from "../src/documents/document-bundle-service.js";

/**
 * A delivery note carries no price, in its fields or in its words.
 *
 * Some official designations state one: "Deux matelas à 1600 DH". The quote and the
 * invoice keep them word for word. The delivery note is given a designation of its
 * own, written explicitly — never cut out of the official text — and one that
 * states a price is refused.
 *
 * The lines are file 11's; the client and the stand-in data are invented.
 */
const INPUT = Object.freeze({
  client: { name: "MADAME EXEMPLE", address: "Ville Exemple" },
  items: Object.freeze([
    { designation: "Deux lits tapissés de 160 cm", unit: "U", quantity: 1, unitPriceHt: 17000 },
    { designation: "Deux matelas à 1600 DH", deliveryNoteDesignation: "Deux matelas", unit: "U", quantity: 1, unitPriceHt: 3200 },
    { designation: "Table de nuit commune", unit: "U", quantity: 1, unitPriceHt: 1500 }
  ]),
  tvaRate: 0.2,
  discount: { percent: 7, appliesToIndexes: [0], label: "Remise" },
  paymentScheduleRuleId: "hkids-60-20-20-2026",
  paymentMethod: "virement bancaire",
  dates: { quoteDate: "06/09/2026", invoiceDate: "06/09/2026", deliveryNoteDate: "06/09/2026" },
  numbers: { quote: "71", invoice: "45", deliveryNote: "45" }
});

// The same file with no delivery-note designation.
const WITHOUT = Object.freeze({
  ...INPUT,
  items: Object.freeze(INPUT.items.map(({ deliveryNoteDesignation, ...item }) => item))
});

const withDelivered = (deliveryNoteDesignation) => ({
  ...INPUT,
  items: INPUT.items.map((item, index) => (index === 1 ? { ...item, deliveryNoteDesignation } : item))
});

function codeOf(run) {
  try {
    run();
    return "accepted";
  } catch (error) {
    return error.code;
  }
}

// What stops a file being issued, leaving aside the project questions nobody
// answered in these fixtures.
const blockingCodes = (issues) => issues
  .filter((issue) => !["PROJECT_INFORMATION_MISSING", "DELIVERABLE_AUDIENCE_UNCONFIRMED"].includes(issue.code))
  .map((issue) => issue.code);

test("the delivery note uses its own designation; the quote and the invoice keep the official one", () => {
  const bundle = createDocumentBundle(INPUT);
  const { quote, invoice, deliveryNote } = bundle.documents;

  assert.deepEqual(deliveryNote.items.map((item) => item.designation), ["Deux lits tapissés de 160 cm", "Deux matelas", "Table de nuit commune"]);
  assert.equal(quote.items[1].designation, "Deux matelas à 1600 DH");
  assert.equal(invoice.items[1].designation, "Deux matelas à 1600 DH");

  // The quote, the invoice, the totals and the schedule are those of the same file
  // without a delivery-note designation.
  const without = createDocumentBundle(WITHOUT);
  assert.deepEqual(quote, without.documents.quote);
  assert.deepEqual(invoice, without.documents.invoice);
  assert.deepEqual(bundle.totals, without.totals);
  assert.deepEqual(bundle.schedule, without.schedule);

  // The delivery note's lines hold what was delivered and nothing else.
  for (const item of deliveryNote.items) {
    assert.deepEqual(Object.keys(item).sort(), ["designation", "quantity", "unit"]);
  }
});

test("the delivery note still matches the order it delivers, and the validator accepts all three documents", () => {
  const bundle = createDocumentBundle(INPUT);
  assert.deepEqual(blockingCodes(bundle.issues), []);

  const { quote, invoice, deliveryNote } = bundle.documents;
  for (const document of [quote, invoice, deliveryNote]) {
    assert.equal(codeOf(() => validateAndPrepareDocument(document)), "accepted", document.documentType);
  }
});

test("a delivery note that departs from the order is still reported", () => {
  const bundle = createDocumentBundle(INPUT);
  const tamper = (index, patch) => validateDocumentBundle({
    ...bundle,
    documents: {
      ...bundle.documents,
      deliveryNote: {
        ...bundle.documents.deliveryNote,
        items: bundle.documents.deliveryNote.items.map((item, position) => (position === index ? { ...item, ...patch } : item))
      }
    }
  });
  const fieldsOf = (issues) => issues.filter((issue) => issue.code === "ITEM_FIELD_MISMATCH").map((issue) => issue.field);

  // Another designation than the one declared for the delivery note.
  assert.deepEqual(fieldsOf(tamper(1, { designation: "Deux oreillers" })), ["items.1.designation"]);
  // A quantity nobody ordered.
  assert.deepEqual(fieldsOf(tamper(1, { quantity: 2 })), ["items.1.quantity"]);
  // Another designation on a line that has none of its own.
  assert.deepEqual(fieldsOf(tamper(0, { designation: "Un lit" })), ["items.0.designation"]);

  // The official, priced designation printed despite the one declared: a mismatch,
  // and a price on the delivery note.
  const priced = tamper(1, { designation: "Deux matelas à 1600 DH" });
  assert.deepEqual(fieldsOf(priced), ["items.1.designation"]);
  assert.ok(priced.some((issue) => issue.code === "DELIVERY_NOTE_DESIGNATION_PRICED"));
});

test("a delivery-note designation that states a price is refused", () => {
  for (const text of [
    "Deux matelas à 1600 DH",
    "Deux matelas 1 600,00 DH",
    "Matelas 1600DH",
    "Matelas à 1600 MAD",
    "Matelas 250 €",
    "deux matelas à 1600 dh"
  ]) {
    assert.equal(codeOf(() => createDocumentBundle(withDelivered(text))), "DELIVERY_NOTE_DESIGNATION_PRICED", text);
  }
});

test("a blank or non-text delivery-note designation is refused; an absent one is not", () => {
  for (const value of ["", "   ", 12, {}, true]) {
    assert.equal(codeOf(() => createDocumentBundle(withDelivered(value))), "DELIVERY_NOTE_DESIGNATION_INVALID", String(value));
  }
  for (const value of [undefined, null]) {
    const { deliveryNote } = createDocumentBundle(withDelivered(value)).documents;
    assert.equal(deliveryNote.items[1].designation, "Deux matelas à 1600 DH", String(value));
  }
});

test("a designation that states a price, with none given for the delivery note, is reported rather than cut", () => {
  const bundle = createDocumentBundle(WITHOUT);

  // The official text is not touched anywhere.
  assert.equal(bundle.documents.deliveryNote.items[1].designation, "Deux matelas à 1600 DH");
  assert.equal(bundle.documents.quote.items[1].designation, "Deux matelas à 1600 DH");

  // And the file cannot be issued as it stands.
  const priced = bundle.issues.filter((issue) => issue.code === "DELIVERY_NOTE_DESIGNATION_PRICED");
  assert.deepEqual(priced.map((issue) => issue.field), ["documents.deliveryNote.items.1.designation"]);
  assert.deepEqual(blockingCodes(bundle.issues), ["DELIVERY_NOTE_DESIGNATION_PRICED"]);
});

test("designationStatesPrice reads an amount of money, and nothing else", () => {
  for (const text of ["Deux matelas à 1600 DH", "à 6 900 DH", "1 600,00 DH", "1600DH", "250 €", "1200 MAD", "3 dirhams", "12 DHS"]) {
    assert.equal(designationStatesPrice(text), true, text);
  }
  for (const value of ["Lit cabane Montessori 190×90", "Deux matelas", "Deux packs lits cabanes", "Dressings",
    "Lit 2 places 160 cm", "Madame", "Livraison/install", "Mur d’escalade", "", null, undefined, 1600]) {
    assert.equal(designationStatesPrice(value), false, String(value));
  }
});
