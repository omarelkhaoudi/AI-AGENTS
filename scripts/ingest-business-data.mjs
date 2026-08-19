import { readFile } from "node:fs/promises";
import { createBusinessMemoryRepository } from "../src/business-memory/repository-factory.js";
import { ingestBusinessRecords, listIngestableDomains } from "../src/business-memory/ingestion.js";
import { BUSINESS_DATA_SOURCES } from "../src/business-memory/source.js";

function readOption(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const domain = readOption("domain");
const source = readOption("source");
const file = readOption("file");
// Writing is never the default: a run without --write only reports.
const write = hasFlag("write");

if (!domain || !source || !file) {
  console.error("Usage: npm run data:ingest -- --domain=<domain> --source=<source> --file=<path.json> [--write]");
  console.error(`Domains: ${listIngestableDomains().join(", ")}`);
  console.error(`Sources: ${Object.values(BUSINESS_DATA_SOURCES).join(", ")}`);
  console.error("Without --write the batch is validated and reported, and nothing is persisted.");
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(await readFile(file, "utf8"));
} catch (cause) {
  console.error(`Cannot read ${file}: ${cause.message}`);
  process.exit(1);
}

const records = Array.isArray(parsed) ? parsed : parsed?.records;
if (!Array.isArray(records)) {
  console.error("The input file must contain a JSON array, or an object with a records array.");
  process.exit(1);
}

const memory = createBusinessMemoryRepository();

try {
  const report = await ingestBusinessRecords({
    memory,
    domain,
    source,
    records,
    dryRun: !write
  });

  console.log(`domain:   ${report.domain}`);
  console.log(`source:   ${report.source}`);
  console.log(`mode:     ${report.dryRun ? "dry-run (nothing written)" : "write"}`);
  console.log(`records:  ${report.total} read, ${report.acceptedCount} valid, ${report.rejectedCount} rejected`);
  console.log(`written:  ${report.writtenCount}`);

  for (const rejection of report.rejected) {
    console.error(`  rejected[${rejection.index}] ${rejection.id ?? "<no id>"}: ${rejection.code} - ${rejection.message}`);
  }

  if (report.blocked) {
    console.error("Batch blocked: no record was written because the batch contains invalid records.");
    process.exit(1);
  }

  if (report.dryRun) {
    console.log("Re-run with --write to persist this batch.");
  }
} catch (cause) {
  console.error(`${cause.code ?? cause.name}: ${cause.message}`);
  process.exit(1);
}
