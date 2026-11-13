import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { checkInvoice, dossierOf } from "../src/documents/document-ledger.js";

// The chain of one sale: the quote, the purchase order that accepts it, the
// invoices that bill it. Each document names the one before it, and the
// invoices of a sale never add up to more than the sale. Invented clients and
// figures only.

async function service(t) {
  const dir = await mkdtemp(join(tmpdir(), "hkids-chain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, documents: new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir: dir }) };
}

const client = { name: "Client Exemple", address: "Marrakech" };

function quote(overrides = {}) {
  return {
    documentType: "quote",
    documentNumber: "170",
    date: "02/11/2026",
    object: "Lit cabane",
    client,
    items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: 3750, amountHt: 3750 }],
    totals: { totalHt: 3750, tva: 750, totalTtc: 4500 },
    payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" },
    ...overrides
  };
}

function order(overrides = {}) {
  return {
    ...quote({ documentType: "purchase_order", documentNumber: "171", date: "03/11/2026", payment: { termsRule: "hkids-po-50-50" } }),
    specifications: ["Bois clair"],
    quoteReference: "170",
    ...overrides
  };
}

// An invoice of `ttc` dirhams on quote 170.
function invoice(number, ttc, overrides = {}) {
  const ht = Math.round((ttc / 1.2) * 100) / 100;
  return {
    documentType: "invoice",
    documentNumber: number,
    date: "04/11/2026",
    object: "Vente de mobilier",
    client,
    quoteReference: "170",
    items: [{ designation: "Acompte sur devis n° 170", unit: "U", quantity: 1, unitPriceHt: ht, amountHt: ht }],
    totals: { totalHt: ht, tva: Math.round((ttc - ht) * 100) / 100, totalTtc: ttc },
    payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" },
    ...overrides
  };
}

async function issue(documents, input, options = {}) {
  const preview = await documents.preview(input, options);
  await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true }, options);
  return preview;
}

test("a sale moves from quote sent to accepted, then invoiced in part and in full", async (t) => {
  const { documents } = await service(t);
  await issue(documents, quote());
  assert.equal((await documents.dossier("quote", "170")).stage, "devis envoyé, pas encore accepté");

  const orderPreview = await issue(documents, order());
  assert.deepEqual(orderPreview.notices, ["Issu du devis n° 170 : à la validation, le devis passe à « accepté »."]);
  assert.equal((await documents.dossier("quote", "170")).stage, "accepté : bon de commande fait");

  const deposit = await issue(documents, invoice("166", 2250));
  assert.match(deposit.notices[0], /^Première facture du dossier \(4\s500,00 DH TTC selon le devis\)\.$/);
  const half = await documents.dossier("purchase_order", "171");
  assert.equal(half.stage, "facturé en partie");
  assert.equal(half.invoiced, 2250);
  assert.equal(half.remaining, 2250);

  const balance = await issue(documents, invoice("167", 2250));
  assert.match(balance.notices[0], /Déjà facturé sur ce dossier : 2\s250,00 DH \(facture n° 166\) ; reste à facturer avant celle-ci : 2\s250,00 DH\./);
  const full = await documents.dossier("invoice", "167");
  assert.equal(full.stage, "facturé en totalité");
  assert.equal(full.quoteNumber, "170");
  assert.deepEqual(full.invoices.map((entry) => entry.number), ["166", "167"]);
  assert.equal(full.remaining, 0);
});

test("an invoice that would bill the sale twice is refused, at the preview and at generation", async (t) => {
  const { documents } = await service(t);
  await issue(documents, quote());
  await issue(documents, invoice("166", 4500));

  await assert.rejects(documents.preview(invoice("167", 4500)), (error) => {
    assert.equal(error.code, "INVOICE_EXCEEDS_SALE");
    assert.equal(error.details.ceiling, 4500);
    assert.equal(error.details.ceilingFrom, "devis");
    assert.equal(error.details.remainingBefore, 0);
    assert.deepEqual(error.details.previousInvoices.map((entry) => entry.number), ["166"]);
    return true;
  });
  // A cent of rounding is not an overcharge.
  await assert.rejects(documents.preview(invoice("167", 1)), { code: "INVOICE_EXCEEDS_SALE" });
});

test("an invoice previewed before another one took the rest is refused when it is generated", async (t) => {
  const { documents } = await service(t);
  await issue(documents, quote());
  const first = await documents.preview(invoice("166", 4500));
  await issue(documents, invoice("167", 4500));

  await assert.rejects(
    documents.generate({ ...invoice("166", 4500), previewToken: first.previewToken, userConfirmation: true }),
    { code: "INVOICE_EXCEEDS_SALE" }
  );
});

test("correcting an invoice under its own number replaces it in the total instead of adding to it", async (t) => {
  const { documents } = await service(t);
  await issue(documents, quote());
  await issue(documents, invoice("166", 4500));

  const corrected = await issue(documents, invoice("166", 4500, { date: "05/11/2026" }), { replaceExisting: true });

  assert.match(corrected.notices[0], /^Première facture du dossier/);
  const dossier = await documents.dossier("quote", "170");
  assert.equal(dossier.invoiced, 4500);
  assert.equal(dossier.invoices[0].date, "05/11/2026", "the corrected version is the one read back");
  assert.deepEqual(dossier.anomalies, []);
});

test("documents issued before their content was kept are read from their Word file", async (t) => {
  const { dir, documents } = await service(t);
  await issue(documents, quote());
  await issue(documents, order());
  await issue(documents, invoice("166", 8760, { quoteReference: undefined, deliveryNoteReference: "98", date: "05/09/2026" }));
  await unlink(join(dir, "bon_commande_HKIDS_171_03_11_2026.json"));
  await unlink(join(dir, "facture_HKIDS_166_05_09_2026.json"));

  const issued = await documents.listIssued();
  const orderLine = issued.find((entry) => entry.type === "purchase_order");
  assert.equal(orderLine.source, "word");
  assert.equal(orderLine.quoteReference, "170", "the purchase order prints the quote it comes from");
  assert.equal(orderLine.client, "Client Exemple");
  assert.equal(orderLine.totalTtc, 4500);
  const invoiceLine = issued.find((entry) => entry.type === "invoice");
  assert.equal(invoiceLine.deliveryNoteReference, "98");
  assert.equal(invoiceLine.totalTtc, 8760);
  assert.equal(invoiceLine.date, "05/09/2026");
  assert.equal((await documents.dossier("invoice", "166")).stage, "facturé (montant de la vente inconnu)");
});

test("the next number of each series follows the documents already issued", async (t) => {
  const { documents } = await service(t);
  assert.equal(await documents.nextDocumentNumber("quote"), "164", "quotes 160 to 163 were written by hand");
  assert.equal(await documents.nextDocumentNumber("invoice"), null, "no invoice series is invented");

  await issue(documents, quote());
  await issue(documents, invoice("166", 2250));

  assert.equal(await documents.nextDocumentNumber("quote"), "171");
  assert.equal(await documents.nextDocumentNumber("invoice"), "167");
  assert.equal(await documents.nextDocumentNumber("delivery_note"), null);
});

test("one number issued several times is counted once, its latest copy, and reported", () => {
  const line = (number, date, totalTtc) => ({ type: "invoice", number, stem: `facture_${date}`, date, client: "Client Exemple", totalTtc, quoteReference: "", deliveryNoteReference: "98", invoiceReference: "" });
  const documents = [line("165", "05/09/2026", 8760), line("165", "12/10/2026", 8760), line("165", "01/10/2026", 8760)];

  const dossier = dossierOf(documents, { type: "invoice", number: "165" });

  assert.equal(dossier.invoiced, 8760);
  assert.equal(dossier.invoices[0].date, "12/10/2026");
  assert.match(dossier.anomalies[0], /La facture n° 165 existe en 3 exemplaires/);
  assert.equal(dossier.ceiling, null, "delivery note 98 was not issued by the cockpit");
  assert.equal(checkInvoice(documents, { documentNumber: "166", deliveryNoteReference: "98", totals: { totalTtc: 8760 } }).ok, true, "without the sale's amount nothing is refused");
});

test("a quote nobody issued is no sale: there is no dossier to follow", () => {
  assert.equal(dossierOf([], { type: "quote", number: "999" }), null);
});

// The agents, with the model's answers written in advance.
function agentWith(documents, scripts) {
  const calls = [];
  const agent = createDirectorAgent({
    client: { responses: { create: async (payload) => {
      calls.push(JSON.parse(JSON.stringify(payload)));
      const who = Object.keys(scripts).find((key) => payload.instructions.includes(key));
      return scripts[who].shift();
    } } },
    documentService: documents,
    toolRegistry: { list: () => [] },
    executeTool: async () => ({ ok: true, donnees: null }),
    clock: () => new Date("2026-11-05T10:00:00Z")
  });
  return { agent, calls };
}
const call = (name, args, id) => ({ output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] });
const say = (text) => ({ output_text: text, output: [] });
const outputOf = (payload) => JSON.parse(payload.input.at(-1).output);

test("asked for the order of an accepted quote, the Commercial reads the quote and names it on the order", async (t) => {
  const { documents } = await service(t);
  await issue(documents, quote());
  const { agent, calls } = agentWith(documents, {
    "Tu es le Director IA": [
      call("deleguer_a_un_agent", { agent: "commercial", mission: "Le client a accepté le devis 170 : bon de commande en 50/50." }, "d1"),
      say("Le bon de commande est prêt.")
    ],
    "Tu es l'agent Commercial": [
      call("consulter_document", { type: "devis", numero: "170" }, "c1"),
      call("preparer_document", {
        type: "bon_de_commande", client_nom: "Client Exemple", client_adresse: "Marrakech", objet: "Lit cabane",
        lignes: [{ designation: "Lit cabane 90x190", quantite: 1, prix_unitaire: 3750, prix_ttc: false }],
        caracteristiques: [], conditions_paiement: "50/50", reference_devis: "170", reference_bl: "",
        numero: "", photo: 0, date: "", remplace: false
      }, "c2"),
      say("BC prêt, issu du devis 170.")
    ]
  });

  const result = await agent.chat({ message: "Le client a accepté le devis 170, fais le BC en 50/50" });

  const commercial = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Commercial"));
  assert.ok(commercial[0].tools.some((tool) => tool.name === "suivre_dossier"));
  assert.match(commercial[0].instructions, /reference_devis = 170/);
  assert.equal(outputOf(commercial[1]).total_ttc, 4500);
  const prepared = outputOf(commercial[2]);
  assert.deepEqual(prepared.dossier, ["Issu du devis n° 170 : à la validation, le devis passe à « accepté »."]);
  const [document] = result.documents;
  assert.equal(document.preview.document.quoteReference, "170");
  assert.equal(document.preview.document.totals.totalTtc, 4500);
});

test("before an invoice, Finance follows the sale, and is stopped from billing more than what remains", async (t) => {
  const { documents } = await service(t);
  await issue(documents, quote());
  await issue(documents, invoice("166", 2250));
  const invoiceArgs = (ttc) => ({
    type: "facture", client_nom: "Client Exemple", client_adresse: "Marrakech", objet: "Vente de mobilier",
    lignes: [{ designation: "Solde sur devis n° 170", quantite: 1, prix_unitaire: ttc, prix_ttc: true }],
    caracteristiques: [], conditions_paiement: "60/20/20", reference_devis: "170", reference_bl: "",
    reference_facture: "", mode_paiement: "", numero: "", photo: 0, date: "", remplace: false
  });
  const { agent, calls } = agentWith(documents, {
    "Tu es le Director IA": [
      call("deleguer_a_un_agent", { agent: "finance", mission: "Facture du solde du devis 170." }, "d1"),
      say("La facture de solde est prête.")
    ],
    "Tu es l'agent Administration / Finance": [
      call("suivre_dossier", { type: "devis", numero: "170" }, "f1"),
      call("preparer_document", invoiceArgs(4500), "f2"),
      call("preparer_document", invoiceArgs(2250), "f3"),
      say("Facture de solde prête : 2 250 DH.")
    ]
  });

  const result = await agent.chat({ message: "Fais la facture du solde du devis 170" });

  const finance = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Administration / Finance"));
  const consult = finance[0].tools.find((tool) => tool.name === "consulter_document");
  assert.deepEqual(consult.parameters.properties.type.enum, ["facture", "avoir", "recu_paiement", "devis", "bon_de_commande", "bon_de_livraison"], "Finance reads the documents an invoice comes from");
  const prepare = finance[0].tools.find((tool) => tool.name === "preparer_document");
  assert.deepEqual(prepare.parameters.properties.type.enum, ["facture", "avoir", "recu_paiement"], "but prepares only invoices, credit notes and receipts");

  const followed = outputOf(finance[1]);
  assert.equal(followed.etape, "facturé en partie");
  assert.equal(followed.montant_de_la_vente, "4500 DH TTC (selon le devis)");
  assert.equal(followed.reste_a_facturer, 2250);
  assert.deepEqual(followed.factures.map((entry) => entry.numero), ["166"]);

  const refused = outputOf(finance[2]);
  assert.equal(refused.ok, false);
  assert.match(refused.erreur, /^Facture refusée : .+reste à facturer : 2250 DH/);

  const accepted = outputOf(finance[3]);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.numero, "167");
  assert.equal(result.documents.length, 1, "only the invoice within the rest reaches the cockpit");
  assert.equal(result.documents[0].preview.document.totals.totalTtc, 2250);
});

test("Finance prepares a receipt for a payment and a credit note on an invoice, within what the sale allows", async (t) => {
  const { documents } = await service(t);
  await issue(documents, quote());
  await issue(documents, invoice("166", 4500));
  const base = {
    client_nom: "Client Exemple", client_adresse: "Marrakech", caracteristiques: [], conditions_paiement: "60/20/20",
    reference_bl: "", photo: 0, date: "", remplace: false
  };
  const receiptArgs = (amount, mode) => ({
    ...base, type: "recu_paiement", objet: "Acompte", reference_devis: "170", reference_facture: "166", mode_paiement: mode, numero: "1",
    lignes: [{ designation: "Acompte de 60 % sur le devis n° 170", quantite: 1, prix_unitaire: amount, prix_ttc: true }]
  });
  const creditArgs = (amount) => ({
    ...base, type: "avoir", objet: "Remise commerciale", reference_devis: "170", reference_facture: "166", mode_paiement: "déduit du reste à payer", numero: "1",
    lignes: [{ designation: "Remise commerciale sur la facture n° 166", quantite: 1, prix_unitaire: amount, prix_ttc: true }]
  });
  const { agent, calls } = agentWith(documents, {
    "Tu es le Director IA": [
      call("deleguer_a_un_agent", { agent: "finance", mission: "Reçu de l'acompte de 2 700 DH par chèque sur le devis 170, et avoir de 600 DH sur la facture 166." }, "d1"),
      say("Le reçu et l'avoir sont prêts.")
    ],
    "Tu es l'agent Administration / Finance": [
      call("preparer_document", receiptArgs(2700, ""), "f1"),
      call("preparer_document", receiptArgs(5000, "chèque"), "f2"),
      call("preparer_document", receiptArgs(2700, "chèque"), "f3"),
      call("preparer_document", creditArgs(600), "f4"),
      say("Reçu n° 1 et avoir n° 1 prêts.")
    ]
  });

  const result = await agent.chat({ message: "Fais le reçu de l'acompte et l'avoir" });
  const finance = calls.filter((payload) => payload.instructions.includes("Tu es l'agent Administration / Finance"));

  assert.match(outputOf(finance[1]).erreur, /^Préciser mode_paiement parmi : espèces, virement bancaire, chèque/);
  assert.match(outputOf(finance[2]).erreur, /^Reçu refusé : .+reste à payer : 4500 DH/);
  const receipt = outputOf(finance[3]);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.tva, 0);
  assert.equal(receipt.total_ttc, 2700, "a receipt states the amount received, with no tax taken out");
  assert.equal(receipt.mode_paiement, "chèque");
  const credit = outputOf(finance[4]);
  assert.equal(credit.ok, true);
  assert.equal(credit.total_ttc, 600);

  assert.deepEqual(result.documents.map((entry) => entry.input.documentType), ["payment_receipt", "credit_note"]);
  assert.equal(result.documents[1].input.invoiceReference, "166");
});
