import { readFile } from "node:fs/promises";
import { createBusinessMemoryConfig, createBusinessMemoryRepository } from "../src/business-memory/repository-factory.js";
import { convertHkidsWorkbook } from "../src/business-memory/hkids-workbook.js";
import { ingestBusinessRecords, validateIngestionBatch } from "../src/business-memory/ingestion.js";
import { BUSINESS_DATA_SOURCES } from "../src/business-memory/source.js";
import { readXlsxSheets } from "../src/business-memory/xlsx-reader.js";
import { loadDotEnvIfPresent } from "../src/load-dotenv.js";

// Imports the H-KIDS data workbook (docs/modele-donnees-hkids.xlsx, filled in
// by the company) into the business memory, as real data.
//
//   npm run data:import-hkids -- --file=<chemin.xlsx>           check only, write nothing
//   npm run data:import-hkids -- --file=<chemin.xlsx> --write   check, then write
//
// Nothing is written unless every row of every sheet is valid: one issue
// anywhere blocks the whole import, so the base never holds half a workbook.
// Records are written under the future_real_data source, never under demo, and
// re-importing the same workbook updates them in place.

loadDotEnvIfPresent();

const file = process.argv.find((argument) => argument.startsWith("--file="))?.slice("--file=".length);
const write = process.argv.includes("--write");

if (!file) {
  console.error("Usage: npm run data:import-hkids -- --file=<chemin.xlsx> [--write]");
  process.exit(1);
}

let sheets;
try {
  sheets = readXlsxSheets(await readFile(file));
} catch (cause) {
  console.error(`Impossible de lire ${file} : ${cause.message}`);
  process.exit(1);
}

const source = BUSINESS_DATA_SOURCES.FUTURE_REAL_DATA;
const { recordsByDomain, issues, skipped, referenceDate } = convertHkidsWorkbook(sheets);

console.log(`fichier :      ${file}`);
console.log(`calculé au :   ${referenceDate}`);
console.log(`mode :         ${write ? "écriture" : "vérification (rien n'est écrit)"}`);
console.log("");

for (const entry of skipped) {
  console.log(`ignoré   ${entry.sheet} ligne ${entry.row} : ${entry.reason}`);
}

let blocked = issues.length > 0;
for (const entry of issues) {
  const where = entry.row ? `${entry.sheet} ligne ${entry.row}${entry.column ? `, ${entry.column}` : ""}` : entry.sheet;
  console.error(`problème ${where} : ${entry.message}`);
}

// The contract check runs on every batch before anything is written.
for (const [domain, records] of Object.entries(recordsByDomain)) {
  const batch = validateIngestionBatch({ domain, source, records });
  console.log(`${domain.padEnd(15)} ${String(batch.accepted.length).padStart(4)} valide(s)${batch.rejected.length ? `, ${batch.rejected.length} refusé(s)` : ""}`);
  for (const rejection of batch.rejected) {
    blocked = true;
    console.error(`  refusé ${rejection.id ?? "<sans id>"} : ${rejection.code} - ${rejection.message}`);
  }
}

if (blocked) {
  console.error("\nImport bloqué : corrigez les problèmes ci-dessus dans le fichier, puis relancez.");
  process.exit(1);
}

if (!write) {
  console.log("\nTout est valide. Relancez avec --write pour enregistrer.");
  process.exit(0);
}

// Writing to the in-memory provider would succeed and vanish with the process.
if (createBusinessMemoryConfig().provider !== "postgres") {
  console.error("\nBUSINESS_MEMORY_PROVIDER doit valoir \"postgres\" dans .env pour enregistrer les données.");
  process.exit(1);
}

const memory = createBusinessMemoryRepository();
try {
  let total = 0;
  for (const [domain, records] of Object.entries(recordsByDomain)) {
    const report = await ingestBusinessRecords({ memory, domain, source, records, dryRun: false });
    total += report.writtenCount;
  }
  console.log(`\n${total} enregistrement(s) écrit(s) sous la source ${source}.`);
} finally {
  await memory.prisma?.$disconnect?.();
}
