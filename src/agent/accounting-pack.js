import yazl from "yazl";
import { HKIDS_DOCUMENT_TYPES } from "../documents/document-schema.js";
import { roundMoney } from "../documents/document-calculations.js";
import { renderXlsx } from "../documents/xlsx-writer.js";
import { buildJournal, JOURNAL_COLUMNS, journalRows } from "./accounting-export.js";

// The month's pack for the accountant (CDC section 7): what he asks for every
// month, in one archive, taken from the books of the cockpit only.
//
// - ecritures.xlsx: the entries proposed on the CGNC accounts (accounting-export);
// - ventes.xlsx: the register of the invoices and credit notes, with the VAT
//   invoiced;
// - caisse-banque.xlsx: every payment received and every expense, with the
//   name of its proof in the pack, or « manquant »;
// - variables-paie.xlsx: the payroll variables of the month, without any amount;
// - pieces/: the PDF of each invoice, credit note and payment receipt of the
//   month; justificatifs/: the proofs joined to the expenses;
// - LISEZ-MOI.txt: the totals, and what the accountant has to check.
//
// Nothing is invented: an invoice whose content was not kept is listed with
// its total only, and said so; a missing PDF or proof is said missing.

export class AccountingPackError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AccountingPackError";
    this.code = code;
  }
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const SALES_COLUMNS = Object.freeze(["Date", "Pièce", "N°", "Client", "Référence", "Montant HT", "TVA facturée", "Montant TTC"]);
export const CASH_COLUMNS = Object.freeze(["Date", "N°", "Sens", "Catégorie", "Libellé", "Tiers", "Mode", "Montant", "Justificatif"]);
export const PAYROLL_COLUMNS = Object.freeze(["Salarié", "Poste", "Jours ouvrables dus", "Jours travaillés", "Absences justifiées", "Absences non justifiées", "Congés (jours)", "Heures de retard", "Heures supplémentaires"]);

const PIECE_FOLDER = Object.freeze({
  [HKIDS_DOCUMENT_TYPES.INVOICE]: "factures",
  [HKIDS_DOCUMENT_TYPES.CREDIT_NOTE]: "avoirs",
  [HKIDS_DOCUMENT_TYPES.PAYMENT_RECEIPT]: "recus"
});

export function monthBounds(month) {
  if (!MONTH.test(String(month ?? ""))) {
    throw new AccountingPackError("Mois illisible : écrire AAAA-MM (2026-11).", "ACCOUNTING_MONTH_INVALID");
  }
  const from = `${month}-01`;
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return { from, to };
}

export function packFileName(month) {
  return `pack-comptable-${month}.zip`;
}

// month: AAAA-MM. issued / readIssued: the document service; readPdf(stem):
// the PDF of an issued document, or null; cashEntries: the cash book;
// readReceipt(entryNumber, receiptId): { bytes } of a proof, or null;
// payroll: the payroll variables of the month, or null; accounts: the CGNC
// accounts; company: its name; at: when the pack is made (ISO).
export async function buildAccountingPack({ month, issued, readIssued, readPdf, cashEntries, readReceipt, payroll = null, accounts, company = "", at = new Date().toISOString() }) {
  const { from, to } = monthBounds(month);
  const inMonth = (day) => Boolean(day) && day >= from && day <= to;
  const zip = new yazl.ZipFile();
  const files = [];
  const add = (name, bytes) => {
    zip.addBuffer(Buffer.from(bytes), name);
    files.push(name);
  };
  const missing = [];

  // The entries, as the existing export makes them.
  const journal = await buildJournal({ issued, readIssued, cashEntries, accounts, from, to, confidential: true });
  const entryRows = [...journalRows(journal), ...journal.notes.map((note) => ["", "NOTE", "", "", "", note, "", ""])];
  add("ecritures.xlsx", await renderXlsx({ title: `${company} — écritures proposées, ${frenchMonth(month)}`, columns: [...JOURNAL_COLUMNS], rows: entryRows, total: true, sheetName: "Journal" }));

  // The sales register and the pieces of the month.
  const sales = [];
  let totalHt = 0;
  let totalVat = 0;
  let totalTtc = 0;
  const pieces = issued.filter((entry) => PIECE_FOLDER[entry.type] && inMonth(isoDay(entry.date)))
    .sort((a, b) => isoDay(a.date).localeCompare(isoDay(b.date)) || String(a.number).localeCompare(String(b.number), "fr", { numeric: true }));
  for (const entry of pieces) {
    const pdf = entry.stem ? await readPdf(entry.stem) : null;
    if (pdf) {
      add(`pieces/${PIECE_FOLDER[entry.type]}/${entry.stem}.pdf`, pdf);
    } else {
      missing.push(`PDF absent : ${pieceLabel(entry.type)} n° ${entry.number}.`);
    }
    if (entry.type === HKIDS_DOCUMENT_TYPES.PAYMENT_RECEIPT) {
      continue;
    }
    const sign = entry.type === HKIDS_DOCUMENT_TYPES.CREDIT_NOTE ? -1 : 1;
    const kept = await readIssued(entry.type, entry.number);
    const totals = kept?.source === "content" ? kept.input?.totals : null;
    const known = totals && Number.isFinite(totals.totalHt) && Number.isFinite(totals.totalTtc);
    const ttc = known ? totals.totalTtc : entry.totalTtc;
    const ht = known ? totals.totalHt : null;
    const vat = known ? roundMoney(totals.totalTtc - totals.totalHt) : null;
    if (Number.isFinite(ttc)) {
      totalTtc += sign * ttc;
    }
    if (ht !== null) {
      totalHt += sign * ht;
      totalVat += sign * vat;
    }
    const reference = entry.type === HKIDS_DOCUMENT_TYPES.CREDIT_NOTE
      ? (entry.invoiceReference ? `facture ${entry.invoiceReference}` : "")
      : [entry.quoteReference ? `devis ${entry.quoteReference}` : "", entry.deliveryNoteReference ? `BL ${entry.deliveryNoteReference}` : ""].filter(Boolean).join(", ");
    sales.push([
      frenchDate(isoDay(entry.date)),
      pieceLabel(entry.type),
      String(entry.number),
      entry.client ?? "",
      reference,
      ht === null ? "à compléter" : money(sign * ht),
      vat === null ? "à compléter" : money(sign * vat),
      Number.isFinite(ttc) ? money(sign * ttc) : "à compléter"
    ]);
  }
  add("ventes.xlsx", await renderXlsx({ title: `${company} — factures et avoirs, ${frenchMonth(month)}`, columns: [...SALES_COLUMNS], rows: sales, total: true, sheetName: "Ventes" }));

  // Cash and bank, with their proofs.
  const movements = cashEntries.filter((entry) => !entry.cancelled && inMonth(entry.day))
    .sort((a, b) => a.day.localeCompare(b.day) || Number(a.number) - Number(b.number));
  const cashRows = [];
  let received = 0;
  let spent = 0;
  for (const entry of movements) {
    const proofs = [];
    for (const receipt of entry.receipts ?? []) {
      const found = await readReceipt(entry.number, receipt.id).catch(() => null);
      if (found?.bytes) {
        const name = `justificatifs/${entry.number}-${safeName(receipt.name || receipt.id)}`;
        add(name, found.bytes);
        proofs.push(name);
      }
    }
    if (entry.kind === "entree") {
      received += entry.amount;
    } else {
      spent += entry.amount;
      if (proofs.length === 0 && entry.category !== "salaire") {
        missing.push(`Sans justificatif : dépense n° ${entry.number} du ${frenchDate(entry.day)}, ${money(entry.amount)} (${entry.label}).`);
      }
    }
    cashRows.push([
      frenchDate(entry.day),
      String(entry.number),
      entry.kind === "entree" ? "Entrée" : "Sortie",
      entry.categoryLabel ?? entry.category ?? "",
      entry.label ?? "",
      entry.party ?? "",
      entry.methodLabel ?? entry.method ?? "",
      money(entry.kind === "entree" ? entry.amount : -entry.amount),
      proofs.length > 0 ? proofs.join(", ") : (entry.kind === "entree" ? "" : "manquant")
    ]);
  }
  add("caisse-banque.xlsx", await renderXlsx({ title: `${company} — encaissements et dépenses, ${frenchMonth(month)}`, columns: [...CASH_COLUMNS], rows: cashRows, total: true, sheetName: "Caisse et banque" }));

  // The payroll variables, when the team is kept in the cockpit.
  const payrollRows = (payroll?.rows ?? []).map((row) => [
    row.name,
    row.role ?? "",
    String(row.workingDays),
    String(row.daysWorked),
    String(row.absencesJustified),
    String(row.absencesUnjustified),
    Object.entries(row.leave ?? {}).map(([kind, days]) => `${kind} : ${days}`).join(", "),
    String(row.hoursLate),
    String(row.overtimeHours)
  ]);
  if (payrollRows.length > 0) {
    add("variables-paie.xlsx", await renderXlsx({ title: `${company} — variables de paie, ${frenchMonth(month)} (${payroll.workingDays} jours ouvrables)`, columns: [...PAYROLL_COLUMNS], rows: payrollRows, sheetName: "Paie" }));
  }

  const summary = Object.freeze({
    month,
    invoicesAndCreditNotes: sales.length,
    totalHt: roundMoney(totalHt),
    vatInvoiced: roundMoney(totalVat),
    totalTtc: roundMoney(totalTtc),
    received: roundMoney(received),
    spent: roundMoney(spent),
    entries: journal.lines.length,
    balanced: journal.totals.balanced,
    employees: payrollRows.length,
    toComplete: Object.freeze([...journal.notes, ...missing])
  });
  // With its BOM, so that every Notepad reads the accents right.
  add("LISEZ-MOI.txt", Buffer.from(`﻿${packReadme(company, summary, at)}`, "utf8"));
  zip.end();
  return { stream: zip.outputStream, files, summary };
}

function packReadme(company, summary, at) {
  const lines = [
    `Pack du comptable — ${company} — ${frenchMonth(summary.month)}`,
    `Préparé le ${frenchDate(at.slice(0, 10))} depuis le cockpit.`,
    "",
    "Contenu",
    "  ecritures.xlsx       écritures proposées sur les comptes du CGNC (ventes, caisse, banque)",
    "  ventes.xlsx          factures et avoirs du mois, HT, TVA facturée, TTC",
    "  caisse-banque.xlsx   encaissements et dépenses, avec le justificatif de chacune",
    ...(summary.employees > 0 ? ["  variables-paie.xlsx  jours, absences, congés, retards et heures supplémentaires, sans montant"] : []),
    "  pieces/              PDF des factures, avoirs et reçus de paiement du mois",
    "  justificatifs/       reçus et factures fournisseurs joints aux dépenses",
    "",
    "Chiffres du mois",
    `  Factures et avoirs : ${summary.invoicesAndCreditNotes}`,
    `  Chiffre d'affaires HT (avoirs déduits) : ${money(summary.totalHt)}`,
    `  TVA facturée (avoirs déduits) : ${money(summary.vatInvoiced)}`,
    `  Total TTC facturé : ${money(summary.totalTtc)}`,
    `  Encaissé (caisse et banque) : ${money(summary.received)}`,
    `  Dépensé (caisse et banque) : ${money(summary.spent)}`,
    `  Écritures : ${summary.entries} — ${summary.balanced ? "débit égal au crédit" : "ATTENTION : débit et crédit différents"}`,
    "",
    summary.toComplete.length > 0 ? "À compléter ou à vérifier" : "Rien à compléter signalé par le cockpit.",
    ...summary.toComplete.map((line) => `  - ${line}`),
    "",
    "À savoir",
    "  - Les comptes sont une proposition : c'est le comptable qui décide de ce qui est passé.",
    "  - La TVA est celle des factures. La TVA due au mois (encaissement ou débit) et la TVA",
    "    récupérable sur les achats se calculent sur les pièces jointes.",
    "  - Les mouvements annulés dans le cockpit ne figurent pas dans ce pack.",
    "  - Pièces comptables à conserver dix ans (loi n° 9-88)."
  ];
  return `${lines.join("\n")}\n`;
}

function pieceLabel(type) {
  return {
    [HKIDS_DOCUMENT_TYPES.INVOICE]: "Facture",
    [HKIDS_DOCUMENT_TYPES.CREDIT_NOTE]: "Avoir",
    [HKIDS_DOCUMENT_TYPES.PAYMENT_RECEIPT]: "Reçu"
  }[type] ?? type;
}

function safeName(name) {
  return String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "justificatif";
}

function money(value) {
  return `${roundMoney(value).toFixed(2).replace(".", ",")} DH`;
}

function frenchDate(day) {
  const [year, month, date] = String(day ?? "").split("-");
  return date ? `${date}/${month}/${year}` : "";
}

function frenchMonth(month) {
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-15T12:00:00Z`));
}

function isoDay(value) {
  const text = String(value ?? "").trim();
  const french = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (french) {
    return `${french[3]}-${french[2]}-${french[1]}`;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}
