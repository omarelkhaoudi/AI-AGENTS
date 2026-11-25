import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HkidsDocumentService, InMemoryRepository } from "../src/index.js";
import { accountsFromEnv } from "../src/agent/accounting-export.js";
import { AccountingPackError, buildAccountingPack, monthBounds, packFileName } from "../src/agent/accounting-pack.js";
import { createMemoryCashBook, describeEntry } from "../src/agent/cash-book.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// CDC section 7: the month's pack for the accountant, taken from the books of
// the cockpit only. Invented client, supplier, employee and figures.

const clock = () => new Date("2026-12-02T10:00:00Z");
const client = { name: "Client Exemple", address: "Marrakech" };
const quote = {
  documentType: "quote", documentNumber: "170", date: "02/11/2026", object: "Lit cabane", client,
  items: [{ designation: "Lit cabane 90x190", unit: "U", quantity: 1, unitPriceHt: 3750, amountHt: 3750 }],
  totals: { totalHt: 3750, tva: 750, totalTtc: 4500 },
  payment: { method: "virement bancaire", termsRule: "hkids-60-20-20-2026" }
};
const invoice = { ...quote, documentType: "invoice", documentNumber: "80", date: "10/11/2026", object: "Vente de mobilier", quoteReference: "170", items: [{ designation: "Acompte de 60 % sur devis n° 170", unit: "U", quantity: 1, unitPriceHt: 2250, amountHt: 2250 }], totals: { totalHt: 2250, tva: 450, totalTtc: 2700 } };
const payroll = { month: "2026-11", workingDays: 25, rows: [{ name: "Employé Exemple", role: "Menuisier", workingDays: 25, daysWorked: 23, absencesJustified: 1, absencesUnjustified: 0, leave: { annuel: 1 }, hoursLate: 0.5, overtimeHours: 4 }] };

async function books(t) {
  const outputDir = await mkdtemp(join(tmpdir(), "hkids-accounting-pack-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const documents = new HkidsDocumentService({ repository: new InMemoryRepository(), outputDir });
  for (const input of [quote, invoice]) {
    const preview = await documents.preview(input);
    await documents.generate({ ...input, previewToken: preview.previewToken, userConfirmation: true });
  }
  const cash = createMemoryCashBook({ clock });
  await cash.record({ kind: "entree", amount: 2700, category: "acompte_client", method: "virement", party: "Client Exemple", quoteNumber: "170", day: "12/11/2026" });
  await cash.record({ kind: "sortie", amount: 800, category: "achat_matiere", method: "especes", party: "Fournisseur Exemple", day: "13/11/2026" });
  await cash.attachReceipt("2", { bytes: Buffer.from("%PDF-1.4 facture fournisseur"), mimeType: "application/pdf", name: "Facture fournisseur.pdf" });
  await cash.record({ kind: "sortie", amount: 5000, category: "salaire", method: "especes", party: "Employé Exemple", day: "14/11/2026" });
  await cash.record({ kind: "sortie", amount: 150, category: "transport", method: "especes", label: "Livraison", day: "20/11/2026" });
  await cash.record({ kind: "sortie", amount: 90, category: "transport", method: "especes", day: "01/12/2026" });
  return { documents, cash };
}

function pack(documents, cash, month, extra = {}) {
  return cash.entries().then((entries) => buildAccountingPack({
    month,
    issued: [],
    readIssued: (type, number) => documents.readIssued(type, number),
    readPdf: (stem) => readFile(join(documents.outputDir, `${stem}.pdf`)).catch(() => null),
    cashEntries: entries.map(describeEntry),
    readReceipt: (number, id) => cash.receipt(number, id),
    accounts: accountsFromEnv({}),
    company: "H KIDS",
    at: "2026-12-02T10:00:00Z",
    ...extra
  }));
}

test("the month's pack holds the entries, the sales with their VAT, cash and bank with their proofs, the pay variables and the PDF of the invoices", async (t) => {
  const { documents, cash } = await books(t);
  const { files, summary } = await pack(documents, cash, "2026-11", { issued: await documents.listIssued(), payroll });

  for (const name of ["ecritures.xlsx", "ventes.xlsx", "caisse-banque.xlsx", "variables-paie.xlsx", "LISEZ-MOI.txt"]) {
    assert.ok(files.includes(name), `${name} is in the pack`);
  }
  assert.ok(files.some((name) => /^pieces\/factures\/facture_HKIDS_80_.*\.pdf$/.test(name)), "the invoice's PDF");
  assert.equal(files.some((name) => name.includes("devis")), false, "a quote is not an accounting piece");
  assert.deepEqual(files.filter((name) => name.startsWith("justificatifs/")), ["justificatifs/2-Facture-fournisseur.pdf"]);

  assert.equal(summary.invoicesAndCreditNotes, 1);
  assert.deepEqual([summary.totalHt, summary.vatInvoiced, summary.totalTtc], [2250, 450, 2700]);
  assert.deepEqual([summary.received, summary.spent], [2700, 800 + 5000 + 150], "the movements of November only");
  assert.equal(summary.balanced, true);
  assert.equal(summary.employees, 1);
  assert.deepEqual(summary.toComplete, ["Sans justificatif : dépense n° 4 du 20/11/2026, 150,00 DH (Livraison)."], "a salary needs no receipt; the transport does");
});

test("a month without pay variables leaves their file out; an unreadable month is refused", async (t) => {
  const { documents, cash } = await books(t);
  const { files, summary } = await pack(documents, cash, "2026-12");
  assert.equal(files.includes("variables-paie.xlsx"), false);
  assert.deepEqual([summary.invoicesAndCreditNotes, summary.spent], [0, 90]);
  assert.deepEqual(monthBounds("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
  assert.equal(packFileName("2026-11"), "pack-comptable-2026-11.zip");
  await assert.rejects(pack(documents, cash, "11/2026"), (error) => error instanceof AccountingPackError && error.code === "ACCOUNTING_MONTH_INVALID");
});

test("the direction downloads the pack as a ZIP, recorded in the audit log; nobody else can", async (t) => {
  const { documents, cash } = await books(t);
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository, documentService: documents, cashBook: cash, clock });
  t.after(() => app.close());

  const response = await inject({ method: "GET", url: "/api/accounting/pack?month=2026-11" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["content-type"], "application/zip");
  assert.match(response.headers["content-disposition"], /pack-comptable-2026-11\.zip/);
  assert.equal(response.headers["x-pack-to-complete"], "1");
  const zip = response.rawPayload;
  assert.equal(zip.subarray(0, 2).toString("latin1"), "PK");
  for (const name of ["ecritures.xlsx", "ventes.xlsx", "caisse-banque.xlsx", "LISEZ-MOI.txt", "justificatifs/2-Facture-fournisseur.pdf"]) {
    assert.ok(zip.includes(Buffer.from(name)), `${name} is in the ZIP`);
  }
  assert.ok((await repository.listAuditEvents({})).some((event) => event.type === "accounting_pack_exported"));

  const wrong = await inject({ method: "GET", url: "/api/accounting/pack?month=novembre" });
  assert.equal(wrong.statusCode, 400);
  assert.equal(JSON.parse(wrong.body).details.code, "ACCOUNTING_MONTH_INVALID");

  const operator = await buildAuthenticatedApi({ repository: new InMemoryRepository(), documentService: documents, cashBook: cash, clock, role: "operator" });
  t.after(() => operator.app.close());
  const refused = await operator.inject({ method: "GET", url: "/api/accounting/pack?month=2026-11" });
  assert.equal(refused.statusCode, 403);
  assert.equal(JSON.parse(refused.body).details.code, "ACCOUNTING_DIRECTION_ONLY");
});
