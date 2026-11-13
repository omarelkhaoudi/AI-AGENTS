import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// The register of the documents H KIDS has issued, kept by the Administratif
// agent (Hiba's request of 10/11/2026). It is read from the documents the
// cockpit generated, never typed: every quote, purchase order, delivery note
// and invoice, with its client, date, number and amount.
//
// The PDF of each one is also filed in a folder per client, on the PC, so
// Hiba opens BARADA from her desktop and finds its quotes and invoices in the
// order of their dates:
//
//   H-KIDS Administratif\BARADA\Devis\2026-11-10_devis_171.pdf
//
// Filing copies, never moves: the documents stay where the numbering reads
// them. Filing again copies only what is new or changed, so it can run after
// each document and on a timer without making duplicates. A register in CSV
// sits beside the folders, for Excel.

export const DEFAULT_ARCHIVE_DIR = join(homedir(), "Documents", "H-KIDS Administratif");
export const REGISTER_FILE = "Registre des documents.csv";

export const DOCUMENT_LABELS = Object.freeze({ quote: "Devis", purchase_order: "Bon de commande", delivery_note: "Bon de livraison", invoice: "Facture", credit_note: "Avoir", payment_receipt: "Reçu de paiement" });
const FOLDERS = Object.freeze({ quote: "Devis", purchase_order: "Bons de commande", delivery_note: "Bons de livraison", invoice: "Factures", credit_note: "Avoirs", payment_receipt: "Reçus de paiement" });
const FILE_WORDS = Object.freeze({ quote: "devis", purchase_order: "bon-de-commande", delivery_note: "bon-de-livraison", invoice: "facture", credit_note: "avoir", payment_receipt: "recu" });
// What the agents and the cockpit may call a type.
const TYPE_ALIASES = Object.freeze({
  devis: "quote", quote: "quote",
  bon_de_commande: "purchase_order", bc: "purchase_order", purchase_order: "purchase_order",
  bon_de_livraison: "delivery_note", bl: "delivery_note", delivery_note: "delivery_note",
  facture: "invoice", invoice: "invoice",
  avoir: "credit_note", credit_note: "credit_note",
  recu: "payment_receipt", recu_paiement: "payment_receipt", "reçu": "payment_receipt", payment_receipt: "payment_receipt"
});
const CIVILITY = /^(mme|madame|mlle|mademoiselle|m|mr|monsieur|dr|docteur|ste|societe|famille)$/;

export function documentType(value) {
  return TYPE_ALIASES[String(value ?? "").trim().toLowerCase()] ?? null;
}

// The folder of a client: the name without its civility, in capitals, with
// what Windows refuses in a folder name taken out.
export function clientFolderName(client) {
  const words = String(client ?? "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").split(/\s+/).filter(Boolean);
  const kept = words.filter((word, index) => !(index < words.length - 1 && CIVILITY.test(plain(word).replace(/\./g, ""))));
  const name = kept.join(" ").replace(/[. ]+$/, "").toUpperCase();
  return name || "CLIENT NON PRÉCISÉ";
}

// The register, from what the document service lists as issued.
export function registerEntries(issued, { archiveDir = null } = {}) {
  const ordered = issued.filter((entry) => DOCUMENT_LABELS[entry.type]);
  const names = new Map();
  return ordered.map((entry) => {
    const date = isoDate(entry.date) ?? isoDate(/(\d{4}-\d{2}-\d{2})|(\d{2}_\d{2}_\d{4})/.exec(entry.stem)?.[0]?.replace(/_/g, "/")) ?? "";
    const folder = clientFolderName(entry.client);
    const base = `${date || "sans-date"}_${FILE_WORDS[entry.type]}_${entry.number}`;
    const key = `${folder}/${entry.type}/${base}`;
    const seen = names.get(key) ?? 0;
    names.set(key, seen + 1);
    const fileName = `${base}${seen > 0 ? `_${seen + 1}` : ""}.pdf`;
    const hasOrder = entry.type === "quote" && issued.some((other) => other.type === "purchase_order" && String(other.quoteReference) === String(entry.number));
    return Object.freeze({
      type: entry.type,
      typeLabel: DOCUMENT_LABELS[entry.type],
      number: String(entry.number),
      date,
      client: entry.client || "",
      clientFolder: folder,
      object: entry.object || "",
      totalTtc: Number.isFinite(entry.totalTtc) ? entry.totalTtc : null,
      quoteReference: entry.quoteReference || "",
      status: entry.type === "quote" ? (hasOrder ? "commandé" : "ouvert") : "émis",
      stem: entry.stem,
      file: archiveDir ? join(archiveDir, folder, FOLDERS[entry.type], fileName) : null
    });
  });
}

// « le devis de Mme Barada », « la facture 165 », « les devis de novembre ».
// Every word of the client asked for must be in the client's name, accents
// and capitals aside; the newest first.
export function searchDocuments(entries, { client = "", number = "", type = "", from = "", to = "" } = {}) {
  const words = plain(client).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word && !CIVILITY.test(word));
  const kind = type ? documentType(type) : null;
  const start = from ? isoDate(from) : null;
  const end = to ? isoDate(to) : null;
  return entries
    .filter((entry) => words.every((word) => plain(entry.client).includes(word)))
    .filter((entry) => !String(number).trim() || entry.number === String(number).trim())
    .filter((entry) => !kind || entry.type === kind)
    .filter((entry) => (!start || entry.date >= start) && (!end || entry.date <= end))
    .sort((a, b) => b.date.localeCompare(a.date) || Number(b.number) - Number(a.number));
}

// The last number used in each series, the one the next document follows.
export function lastNumbers(entries) {
  const last = {};
  for (const entry of entries) {
    const value = Number(entry.number);
    if (Number.isFinite(value) && value > (last[entry.type] ?? 0)) {
      last[entry.type] = value;
    }
  }
  return last;
}

// dir null: the register is read and searched, nothing is filed on the PC.
export function createDocumentArchive({ documentService, dir = null }) {
  let running = Promise.resolve();
  const entries = async () => registerEntries(await documentService.listIssued(), { archiveDir: dir });

  async function fileAll() {
    const all = await entries();
    const report = { dir, copied: [], already: 0, missing: [], total: all.length, series: lastNumbers(all) };
    for (const entry of all) {
      const source = join(documentService.outputDir, `${entry.stem}.pdf`);
      const from = await stat(source).catch(() => null);
      if (!from) {
        report.missing.push({ type: entry.typeLabel, number: entry.number, client: entry.client });
        continue;
      }
      const there = await stat(entry.file).catch(() => null);
      if (there && there.size === from.size && there.mtimeMs >= from.mtimeMs) {
        report.already += 1;
        continue;
      }
      await mkdir(join(entry.file, ".."), { recursive: true });
      await copyFile(source, entry.file);
      report.copied.push({ type: entry.typeLabel, number: entry.number, client: entry.client, file: entry.file });
    }
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, REGISTER_FILE), registerCsv(all), "utf8");
    return Object.freeze(report);
  }

  return Object.freeze({
    dir,
    entries,
    async search(query) {
      return searchDocuments(await entries(), query);
    },
    // One filing at a time: two documents validated together do not copy over
    // each other.
    async sync() {
      if (!dir) {
        return Object.freeze({ dir: null, copied: [], already: 0, missing: [], total: 0, series: {}, disabled: true });
      }
      const next = running.then(fileAll, fileAll);
      running = next.catch(() => {});
      return next;
    },
    // The PDF of a document of the register, never any other file.
    async pdf(stem) {
      const entry = (await entries()).find((other) => other.stem === stem);
      if (!entry) {
        return null;
      }
      const bytes = await readFile(join(documentService.outputDir, `${entry.stem}.pdf`)).catch(() => null);
      return bytes ? { entry, bytes } : null;
    }
  });
}

// Semicolons and a byte-order mark: what Excel set to French opens as columns.
function registerCsv(entries) {
  const cell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [...entries].sort((a, b) => a.clientFolder.localeCompare(b.clientFolder) || a.date.localeCompare(b.date));
  return `﻿${[
    ["Client", "Type", "Numéro", "Date", "Objet", "Montant TTC (DH)", "Statut", "Fichier"],
    ...rows.map((entry) => [entry.client, entry.typeLabel, entry.number, frenchDate(entry.date), entry.object, entry.totalTtc === null ? "" : String(entry.totalTtc).replace(".", ","), entry.status, entry.file ?? ""])
  ].map((row) => row.map(cell).join(";")).join("\r\n")}\r\n`;
}

function plain(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function isoDate(value) {
  const text = String(value ?? "").trim();
  const french = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (french) {
    return `${french[3]}-${french[2]}-${french[1]}`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export function frenchDate(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso ?? "") ? iso.split("-").reverse().join("/") : "";
}
