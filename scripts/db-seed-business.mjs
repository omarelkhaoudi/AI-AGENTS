// Seeds the business memory domains into PostgreSQL from the demo data set.
//
// This writes nothing of its own: the records come from createDemoBusinessRecords,
// the same canonical builder the in-memory provider uses, and they go through
// ingestBusinessRecords, which validates every record against the domain
// contract before any write. Seeding demo data is how the PostgreSQL path is
// proven equivalent to the memory path; real data will later arrive through
// this same ingestion, unchanged.
//
// Dry run by default, like the ingestion contract itself. Pass --apply to write.
//
//   node scripts/db-seed-business.mjs            validate only, write nothing
//   node scripts/db-seed-business.mjs --apply    validate and write
import {
  BUSINESS_DATA_SOURCES,
  BUSINESS_DOMAINS,
  PrismaBusinessMemoryRepository,
  createBusinessMemoryPrismaClient,
  createDemoBusinessRecords,
  hasValidDatabaseUrl,
  ingestBusinessRecords
} from "../src/index.js";
import { loadDotEnvIfPresent } from "../src/load-dotenv.js";

loadDotEnvIfPresent();

const apply = process.argv.includes("--apply");

if (!hasValidDatabaseUrl(process.env.DATABASE_URL)) {
  console.error("DATABASE_URL must be a valid PostgreSQL URL before running db:seed:business.");
  process.exit(1);
}

const prisma = createBusinessMemoryPrismaClient(process.env.DATABASE_URL);
const memory = new PrismaBusinessMemoryRepository({ prisma });

// One bucket per declared domain, so a domain with no demo record is reported
// as empty rather than silently missing from the run.
const recordsByDomain = new Map(BUSINESS_DOMAINS.map((domain) => [domain, []]));
const undeclared = [];

for (const record of createDemoBusinessRecords()) {
  if (recordsByDomain.has(record.domain)) {
    recordsByDomain.get(record.domain).push(record);
  } else {
    undeclared.push(record.domain);
  }
}

if (undeclared.length > 0) {
  console.error(`Demo records declare domains outside BUSINESS_DOMAINS: ${[...new Set(undeclared)].join(", ")}`);
  await prisma.$disconnect();
  process.exit(1);
}

const results = [];
let failed = false;

try {
  for (const [domain, records] of recordsByDomain) {
    if (records.length === 0) {
      results.push({ domain, total: 0, written: 0, rejected: 0, empty: true });
      continue;
    }

    const outcome = await ingestBusinessRecords({
      memory,
      domain,
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      records,
      dryRun: !apply,
      stopOnError: true
    });

    results.push({
      domain,
      total: outcome.total,
      written: outcome.writtenCount,
      rejected: outcome.rejectedCount,
      blocked: outcome.blocked,
      empty: false
    });

    if (outcome.rejectedCount > 0) {
      failed = true;
      for (const rejection of outcome.rejected) {
        console.error(`  rejected ${domain} id=${rejection.id} code=${rejection.code}: ${rejection.message}`);
      }
    }
  }
} finally {
  await prisma.$disconnect();
}

const mode = apply ? "applied" : "dry run";
console.log(`Business memory seed (${mode}), source ${BUSINESS_DATA_SOURCES.DEMO_MOCK}:`);
for (const result of results) {
  const detail = result.empty
    ? "no demo record for this domain"
    : `${result.total} record(s), ${result.written} written, ${result.rejected} rejected`;
  console.log(`  ${result.domain.padEnd(22)} ${detail}`);
}

const totals = results.reduce(
  (accumulator, result) => ({
    records: accumulator.records + result.total,
    written: accumulator.written + result.written,
    rejected: accumulator.rejected + result.rejected
  }),
  { records: 0, written: 0, rejected: 0 }
);
const populated = results.filter((result) => !result.empty).length;

console.log(
  `${populated}/${BUSINESS_DOMAINS.length} domain(s) carry demo data: ` +
    `${totals.records} record(s), ${totals.written} written, ${totals.rejected} rejected.`
);

if (!apply) {
  console.log("Nothing was written. Re-run with --apply to seed.");
}

if (failed) {
  process.exit(1);
}
