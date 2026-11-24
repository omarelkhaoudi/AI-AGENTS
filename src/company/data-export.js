import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import yazl from "yazl";

// The company's data, in one archive it can take away (CDC section 11:
// « export des données et suppression encadrée »). Its books (data/), every
// document issued with its PDF, Word and content, the classified copies, and
// the audit log: what is needed to leave the service or to keep its records,
// as ordinary JSON, PDF and Word files.
//
// Keys and passwords never live in these folders: they are in .env and in the
// database (password hashes, two-step secrets), and neither goes in the
// archive. A file that looks like a key is left out all the same.

const SKIPPED = [/^\.env/i, /\.(key|pem|p12|pfx)$/i, /^\.git$/, /^node_modules$/];

export const EXPORT_README = (company, at) => `Export des données — ${company}
Fait le ${at.slice(0, 10)} à ${at.slice(11, 16)} (UTC) depuis le cockpit.

donnees/     les registres de l'entreprise, en JSON : caisse, atelier, amélioration,
             équipe, RH, administratif, stock, budgets, relances, WhatsApp,
             réseaux sociaux, agents, automatisations, conversations… et les
             fichiers qui les accompagnent (photos, signatures, justificatifs,
             fichiers CNC).
documents/   chaque document émis : PDF, Word et son contenu en JSON
             (devis, bons de commande, bons de livraison, factures, avoirs, reçus).
classement/  les copies classées par client, quand le classement est tenu.
journal-d-audit.json   les connexions et les actions sensibles.

Ne sont pas dans l'archive : les mots de passe, les codes de connexion en deux
étapes et les clés des services (WhatsApp, Meta, OpenAI, e-mail).

Pièces comptables : la loi n° 9-88 impose de les conserver dix ans. Gardez
cette archive en lieu sûr.
`;

// roots: [{ dir, as }]. Returns { stream, files } once every file is listed:
// the archive is written as it is read, photos included.
export async function buildDataExport({ roots, extras = [] }) {
  const zip = new yazl.ZipFile();
  const files = [];
  for (const { dir, as } of roots) {
    for (const path of await listFiles(dir)) {
      const name = `${as}/${relative(dir, path).split(sep).join("/")}`;
      zip.addFile(path, name);
      files.push(name);
    }
  }
  for (const { name, content } of extras) {
    zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8"), name);
    files.push(name);
  }
  zip.end();
  return { stream: zip.outputStream, files };
}

async function listFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIPPED.some((pattern) => pattern.test(entry.name))) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await listFiles(path));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

export function exportFileName(slug, at) {
  return `export-${String(slug || "entreprise").toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${at.slice(0, 10)}.zip`;
}
