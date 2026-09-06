import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HKIDS_TEMPLATE_VARIABLES } from "../src/index.js";
import { DEV_TEMPLATE_MARK, createBlankTemplate } from "../test-support/hkids-templates.js";

// Writes throwaway H-KIDS templates so the document generator can be exercised
// on a developer machine before the company supplies its own.
//
// These are NOT the H-KIDS templates. They are blank pages of the right count
// and size, stamped on every page with a development mark, and they carry no
// letterhead, no legal line and no branding. A document produced from them is
// structurally correct and visibly unofficial, which is exactly what a local
// test needs and exactly what a real document must never be.
//
// The output directory is git-ignored. Nothing this script writes can be
// committed.
const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT_DIR = join(PROJECT_ROOT, "assets", "documents", "hkids-local");

const TEMPLATES = Object.freeze([
  { documentType: "invoice", file: "facture_reference.pdf" },
  { documentType: "delivery_note", file: "bon_livraison_reference.pdf" }
]);

await mkdir(OUTPUT_DIR, { recursive: true });

const written = [];
for (const template of TEMPLATES) {
  const path = join(OUTPUT_DIR, template.file);
  const bytes = await createBlankTemplate(template.documentType);
  await writeFile(path, bytes);
  written.push({ ...template, path, sizeBytes: bytes.length });
}

console.log("Gabarits de developpement ecrits dans un repertoire ignore par Git :\n");
for (const entry of written) {
  console.log(`  ${entry.documentType.padEnd(14)} ${entry.path}  (${entry.sizeBytes} octets)`);
}

console.log(`\nChaque page porte la mention : "${DEV_TEMPLATE_MARK}"`);
console.log("\nAjoutez ces deux lignes a votre .env local, puis redemarrez le serveur :\n");
for (const entry of written) {
  console.log(`  ${HKIDS_TEMPLATE_VARIABLES[entry.documentType].path}="${entry.path}"`);
}
console.log("\nCes gabarits ne remplacent pas les gabarits officiels H-KIDS.");
