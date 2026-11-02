import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readXlsxSheets } from "../business-memory/xlsx-reader.js";

// The H-KIDS product catalogue the Director reads to price a request: the
// company keeps it as a workbook (template: docs/catalogue-hkids.xlsx) under
// data/, which git ignores because the repository is public. It is read again
// whenever the file changes, so an edit is taken into account at the next
// request without a restart.

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const DEFAULT_CATALOGUE_PATH = join(PROJECT_ROOT, "data", "catalogue-hkids.xlsx");
const EXAMPLE_REMARK = /^exemple fictif/i;

export function catalogueFromRows(rows = []) {
  return Object.freeze(rows
    .filter((row) => !EXAMPLE_REMARK.test(String(row.values.Remarque ?? "")))
    .filter((row) => String(row.values.Actif ?? "oui").trim().toLowerCase() !== "non")
    .map((row) => {
      const values = row.values;
      const price = Number(String(values["Prix TTC (DH)"] ?? "").toString().replace(/\s/g, "").replace(",", "."));
      return Object.freeze({
        reference: text(values["Référence"]),
        name: text(values.Produit),
        description: text(values.Description),
        priceTtc: Number.isFinite(price) && price > 0 ? price : null,
        unit: text(values["Unité"]) || "U",
        keywords: text(values["Mots-clés"]).split(",").map((word) => word.trim()).filter(Boolean),
        note: text(values.Remarque)
      });
    })
    .filter((entry) => entry.name !== ""));
}

// Every word of the request that is not filler counts; the product name and its
// keywords weigh more than its description. A product whose whole name appears
// in the request wins outright.
export function searchCatalogue(catalogue, query, { limit = 5 } = {}) {
  const words = tokens(query).filter((word) => !STOP_WORDS.has(word));
  if (words.length === 0) {
    return [];
  }
  const wanted = normalize(query);
  return catalogue
    .map((entry) => {
      const name = tokens(entry.name);
      const keys = entry.keywords.flatMap(tokens);
      const description = tokens(entry.description);
      let score = 0;
      for (const word of words) {
        if (name.includes(word) || keys.includes(word)) {
          score += 3;
        } else if (description.includes(word) || entry.reference.toLowerCase() === word) {
          score += 1;
        }
      }
      if (wanted.includes(normalize(entry.name)) || entry.keywords.some((key) => wanted.includes(normalize(key)))) {
        score += 10;
      }
      return { entry, score };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((match) => match.entry);
}

export function createCatalogueLoader({ path = DEFAULT_CATALOGUE_PATH } = {}) {
  let cache = { mtimeMs: null, catalogue: [] };
  return async function loadCatalogue() {
    let info;
    try {
      info = await stat(path);
    } catch {
      return { available: false, path, catalogue: [] };
    }
    if (cache.mtimeMs !== info.mtimeMs) {
      const sheets = readXlsxSheets(await readFile(path));
      const rows = sheets.Catalogue ?? Object.values(sheets).find((sheet) => sheet[0]?.values?.Produit !== undefined) ?? [];
      cache = { mtimeMs: info.mtimeMs, catalogue: catalogueFromRows(rows) };
    }
    return { available: true, path, catalogue: cache.catalogue };
  };
}

const STOP_WORDS = new Set([
  "un", "une", "des", "le", "la", "les", "de", "du", "pour", "avec", "et", "a", "au", "aux", "en",
  "fais", "faire", "moi", "devis", "bon", "commande", "facture", "livraison", "dh", "dhs", "mad", "prix"
]);

function tokens(value) {
  return normalize(value).split(/[^a-z0-9]+/).filter((word) => word.length > 1);
}

function normalize(value) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function text(value) {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}
