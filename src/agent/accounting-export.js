import { HKIDS_DOCUMENT_TYPES } from "../documents/document-schema.js";
import { roundMoney } from "../documents/document-calculations.js";

// The accounting export (CDC section 7: « données nécessaires à l'export
// comptable », CGNC): the entries the books of the cockpit imply, one line per
// account, for the accountant to take up. It is a proposal, not the official
// accounts: the accounts below are the usual CGNC ones for a maker of furniture,
// each can be replaced by .env (HKIDS_ACCOUNTS, JSON), and the accountant
// decides what is booked.
//
// - sales journal (VT): an invoice debits the client (3421) of its total, credits
//   the sales (7121) of its amount before tax and the VAT invoiced (4455); a
//   credit note does the opposite;
// - cash and bank journal (CA / BQ): a payment received debits the cash (5161)
//   or the bank (5141) and credits the client (3421); an expense does the
//   opposite, on the account of its category.
// Payments come from the cash book, not from the receipts, so that none is
// counted twice. An invoice issued before its content was kept has no amount
// before tax: it is listed on one line, to complete by hand.

export const DEFAULT_ACCOUNTS = Object.freeze({
  client: Object.freeze(["3421", "Clients"]),
  sales: Object.freeze(["7121", "Ventes de biens produits"]),
  vatDue: Object.freeze(["4455", "État - TVA facturée"]),
  cash: Object.freeze(["5161", "Caisse"]),
  bank: Object.freeze(["5141", "Banques"]),
  expense: Object.freeze({
    achat_matiere: Object.freeze(["6122", "Achats de matières et fournitures consommables"]),
    fournisseur: Object.freeze(["6134", "Sous-traitance"]),
    salaire: Object.freeze(["6171", "Rémunérations du personnel"]),
    loyer: Object.freeze(["6131", "Locations et charges locatives"]),
    transport: Object.freeze(["6143", "Transports"]),
    publicite: Object.freeze(["6144", "Publicité, publications et relations publiques"]),
    charges: Object.freeze(["6125", "Achats non stockés de matières et fournitures"]),
    impots_taxes: Object.freeze(["6165", "Impôts et taxes"]),
    autre_sortie: Object.freeze(["6181", "Charges d'exploitation diverses"])
  }),
  // What is received that is not a client's payment.
  otherIncome: Object.freeze(["7181", "Autres produits d'exploitation"]),
  // The cash on hand the book started from.
  opening: Object.freeze(["1111", "Capital / apport de départ"])
});

export const JOURNAL_COLUMNS = Object.freeze(["Date", "Journal", "Pièce", "Compte", "Intitulé du compte", "Libellé", "Débit", "Crédit"]);

// accounts: the defaults, with the account pairs [number, name] given in
// HKIDS_ACCOUNTS replacing the ones of the same name.
export function accountsFromEnv(env = process.env) {
  let given = {};
  try {
    given = typeof env.HKIDS_ACCOUNTS === "string" && env.HKIDS_ACCOUNTS.trim() !== "" ? JSON.parse(env.HKIDS_ACCOUNTS) : {};
  } catch {
    given = {};
  }
  const pair = (value) => Array.isArray(value) && value.length === 2 && /^\d{3,8}$/.test(String(value[0])) && String(value[1]).trim() !== "" ? [String(value[0]), String(value[1])] : null;
  const merged = { ...DEFAULT_ACCOUNTS, expense: { ...DEFAULT_ACCOUNTS.expense } };
  for (const key of ["client", "sales", "vatDue", "cash", "bank", "otherIncome", "opening"]) {
    merged[key] = pair(given[key]) ?? merged[key];
  }
  for (const [category, value] of Object.entries(given.expense ?? {})) {
    merged.expense[category] = pair(value) ?? merged.expense[category];
  }
  return Object.freeze(merged);
}

// issued: the documents issued (documentService.listIssued); readIssued: reads
// one with its kept content; cashEntries: the cash book. from / to: AAAA-MM-JJ,
// both included, or empty for no limit.
export async function buildJournal({ issued, readIssued, cashEntries, accounts = DEFAULT_ACCOUNTS, from = "", to = "", confidential = true }) {
  const inRange = (day) => Boolean(day) && (!from || day >= from) && (!to || day <= to);
  const lines = [];
  const notes = [];
  const add = (day, journal, piece, [account, name], label, debit, credit) => {
    lines.push(Object.freeze({ day, journal, piece, account, accountName: name, label, debit: roundMoney(debit), credit: roundMoney(credit) }));
  };

  for (const entry of issued.filter((item) => [HKIDS_DOCUMENT_TYPES.INVOICE, HKIDS_DOCUMENT_TYPES.CREDIT_NOTE].includes(item.type))) {
    const day = isoDay(entry.date);
    if (!inRange(day)) {
      continue;
    }
    const credit = entry.type === HKIDS_DOCUMENT_TYPES.CREDIT_NOTE;
    const piece = `${credit ? "AV" : "FA"} ${entry.number}`;
    const label = `${credit ? "Avoir" : "Facture"} n° ${entry.number} — ${entry.client}`;
    const kept = await readIssued(entry.type, entry.number);
    const totals = kept?.source === "content" ? kept.input?.totals : null;
    if (!totals || !Number.isFinite(totals.totalHt) || !Number.isFinite(totals.totalTtc)) {
      notes.push(`${credit ? "L'avoir" : "La facture"} n° ${entry.number} (${entry.client}) a été émis(e) avant la conservation de son contenu : son montant avant taxe et sa TVA sont à compléter à la main.`);
      add(day, "VT", piece, accounts.client, label, credit ? 0 : entry.totalTtc ?? 0, credit ? entry.totalTtc ?? 0 : 0);
      continue;
    }
    const vat = roundMoney(totals.totalTtc - totals.totalHt);
    add(day, "VT", piece, accounts.client, label, credit ? 0 : totals.totalTtc, credit ? totals.totalTtc : 0);
    add(day, "VT", piece, accounts.sales, label, credit ? totals.totalHt : 0, credit ? 0 : totals.totalHt);
    if (vat !== 0) {
      add(day, "VT", piece, accounts.vatDue, label, credit ? vat : 0, credit ? 0 : vat);
    }
  }

  for (const entry of cashEntries.filter((item) => !item.cancelled && inRange(item.day))) {
    const bank = entry.method && entry.method !== "especes";
    const treasury = bank ? accounts.bank : accounts.cash;
    const journal = bank ? "BQ" : "CA";
    const piece = `CAISSE ${entry.number}`;
    const hidden = entry.confidential && !confidential;
    const label = hidden ? "Dépense confidentielle" : `${entry.label}${entry.party ? ` — ${entry.party}` : ""}${entry.quoteNumber ? ` (devis ${entry.quoteNumber})` : ""}`;
    if (entry.kind === "entree") {
      const counterpart = entry.category === "solde_depart" ? accounts.opening : ["acompte_client", "solde_client"].includes(entry.category) || entry.quoteNumber || entry.orderNumber ? accounts.client : accounts.otherIncome;
      add(entry.day, journal, piece, treasury, label, entry.amount, 0);
      add(entry.day, journal, piece, counterpart, label, 0, entry.amount);
    } else {
      const expense = accounts.expense[entry.category] ?? accounts.expense.autre_sortie;
      add(entry.day, journal, piece, expense, label, entry.amount, 0);
      add(entry.day, journal, piece, treasury, label, 0, entry.amount);
    }
  }

  lines.sort((a, b) => a.day.localeCompare(b.day) || a.piece.localeCompare(b.piece, "fr", { numeric: true }));
  const debit = roundMoney(lines.reduce((sum, line) => sum + line.debit, 0));
  const credit = roundMoney(lines.reduce((sum, line) => sum + line.credit, 0));
  return Object.freeze({
    lines: Object.freeze(lines),
    totals: Object.freeze({ debit, credit, balanced: debit === credit }),
    notes: Object.freeze(notes)
  });
}

export function journalRows(journal) {
  return journal.lines.map((line) => [frenchDate(line.day), line.journal, line.piece, line.account, line.accountName, line.label, line.debit > 0 ? money(line.debit) : "", line.credit > 0 ? money(line.credit) : ""]);
}

function money(value) {
  return `${value.toFixed(2).replace(".", ",")} DH`;
}

function frenchDate(day) {
  const [year, month, date] = day.split("-");
  return `${date}/${month}/${year}`;
}

// « 14/11/2026 » or « 2026-11-14 » as AAAA-MM-JJ; empty when unreadable.
function isoDay(value) {
  const text = String(value ?? "").trim();
  const french = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (french) {
    return `${french[3]}-${french[2]}-${french[1]}`;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}
