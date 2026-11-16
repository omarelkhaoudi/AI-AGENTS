import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { accountsFromEnv, buildJournal } from "../src/agent/accounting-export.js";
import { createMemoryCashBook } from "../src/agent/cash-book.js";
import { createDirectorAgent } from "../src/agent/director-agent.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// CDC section 7: the data the accountant needs for the CGNC. One line per
// account; the debit equals the credit; a payment is counted once, from the
// cash book. Invented client and figures only.

const clock = () => new Date("2026-11-16T10:00:00Z");
const client = { name: "Client Exemple", address: "Marrakech" };
const quote = {
  documentType: "quote", documentNumber: "170", date: "02/11/2026", object: "Lit cabane", client,
  items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: 3750, amountHt: 3750 }],
  totals: { totalHt: 3750, tva: 750, totalTtc: 4500 },
  payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
};
const invoice = { ...quote, documentType: "invoice", documentNumber: "80", date: "10/11/2026", object: "Vente de mobilier", quoteReference: "170", items: [{ designation: "Acompte de 60 % sur devis n° 170", unit: "U", quantity: 1, unitPriceHt: 2250, amountHt: 2250 }], totals: { totalHt: 2250, tva: 450, totalTtc: 2700 } };

async function books(t) {
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-accounting-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir });
  for (const input of [quote, invoice]) {
    const preview = await documents.preview(input);
    await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true });
  }
  const cash = createMemoryCashBook({ clock });
  await cash.record({ kind: "entree", amount: 2700, category: "acompte_client", method: "virement", party: "Client Exemple", quoteNumber: "170", day: "12/11/2026" });
  await cash.record({ kind: "sortie", amount: 800, category: "achat_matiere", method: "especes", party: "Fournisseur Exemple", day: "13/11/2026" });
  await cash.record({ kind: "sortie", amount: 5000, category: "salaire", method: "especes", party: "Employé Exemple", day: "14/11/2026" });
  return { documents, cash };
}

test("an invoice is booked on the client, the sales and the VAT; a payment and an expense on the cash or the bank", async (t) => {
  const { documents, cash } = await books(t);
  const journal = await buildJournal({ issued: await documents.listIssued(), readIssued: (type, number) => documents.readIssued(type, number), cashEntries: await cash.entries(), accounts: accountsFromEnv({}) });
  const of = (piece) => journal.lines.filter((line) => line.piece === piece).map((line) => [line.account, line.debit, line.credit]);

  assert.deepEqual(of("FA 80"), [["3421", 2700, 0], ["7121", 0, 2250], ["4455", 0, 450]]);
  assert.deepEqual(of("CAISSE 1"), [["5141", 2700, 0], ["3421", 0, 2700]], "a transfer goes through the bank, and settles the client");
  assert.deepEqual(of("CAISSE 2"), [["6122", 800, 0], ["5161", 0, 800]], "cash paid out, on the account of its category");
  assert.deepEqual(of("CAISSE 3"), [["6171", 5000, 0], ["5161", 0, 5000]]);
  assert.equal(journal.totals.balanced, true);
  assert.equal(journal.totals.debit, 2700 + 2700 + 800 + 5000);
  assert.equal(journal.lines.some((line) => line.piece.startsWith("DV")), false, "a quote is not booked");

  const period = await buildJournal({ issued: await documents.listIssued(), readIssued: (type, number) => documents.readIssued(type, number), cashEntries: await cash.entries(), from: "2026-11-11", to: "2026-11-13" });
  assert.deepEqual([...new Set(period.lines.map((line) => line.piece))], ["CAISSE 1", "CAISSE 2"], "the period limits the entries");

  const hidden = await buildJournal({ issued: [], readIssued: async () => null, cashEntries: await cash.entries(), confidential: false });
  assert.equal(hidden.lines.find((line) => line.piece === "CAISSE 3").label, "Dépense confidentielle", "a salary is not named to someone who may not see it");
  assert.equal(hidden.totals.debit, 8500, "but it is still counted");
});

test("the accounts can be replaced from .env, and a bad value changes nothing", () => {
  const accounts = accountsFromEnv({ HKIDS_ACCOUNTS: JSON.stringify({ sales: ["7111", "Ventes de marchandises"], expense: { loyer: ["6132", "Loyers"] }, bank: ["pas un compte", "x"] }) });
  assert.deepEqual([accounts.sales, accounts.expense.loyer, accounts.bank], [["7111", "Ventes de marchandises"], ["6132", "Loyers"], ["5141", "Banques"]]);
  assert.deepEqual(accountsFromEnv({ HKIDS_ACCOUNTS: "{pas du json" }).sales, ["7121", "Ventes de biens produits"]);
});

test("the journal is downloaded as an Excel file", async (t) => {
  const { documents, cash } = await books(t);
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository(), documentService: documents, cashBook: cash, clock });
  t.after(() => app.close());
  const response = await inject({ method: "GET", url: "/api/accounting/journal.xlsx?from=2026-11-01&to=2026-11-30" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-journal-balanced"], "true");
  assert.match(response.headers["content-disposition"], /ecritures-comptables\.xlsx/);
  assert.equal(response.rawPayload.subarray(0, 2).toString("latin1"), "PK");
});

test("the Director hands the journal over as an Excel file, with its totals and what is left to complete", async (t) => {
  const { documents, cash } = await books(t);
  const turns = [
    { output: [{ type: "function_call", name: "export_comptable", call_id: "e1", arguments: JSON.stringify({ du: "01/11/2026", au: "30/11/2026" }) }] },
    { output: [{ type: "function_call", name: "export_comptable", call_id: "e2", arguments: JSON.stringify({ du: "31/12/2025", au: "01/01/2026" }) }] },
    { output_text: "Le journal est joint.", output: [] }
  ];
  const calls = [];
  const agent = createDirectorAgent({ client: { responses: { create: async (payload) => (calls.push(JSON.parse(JSON.stringify(payload))), turns.shift()) } }, documentService: documents, cashBook: cash, clock });
  const answer = await agent.chat({ message: "Envoie-moi l'export pour le comptable, novembre." });
  const [told, empty] = calls.at(-1).input.filter((item) => item.type === "function_call_output").map((item) => JSON.parse(item.output));
  assert.equal(told.ok, true);
  assert.equal(told.ecritures, 9);
  assert.equal(told.equilibre, true);
  assert.equal(told.total_debit, 11200);
  assert.match(told.note, /à valider par le comptable/);
  assert.equal(empty.ecritures, 0, "a period with nothing says so, and makes no file");
  assert.equal(answer.exports.length, 1);
  assert.equal(answer.exports[0].name, "2026-11-16_ecritures-comptables-01-11-2026-au-30-11-2026.xlsx");
});
