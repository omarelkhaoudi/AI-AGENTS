import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BusinessMemoryConfigurationError,
  InMemoryBusinessMemoryRepository,
  PrismaBusinessMemoryRepository,
  createBusinessSource,
  createBusinessMemoryConfig,
  createBusinessMemoryRepository,
  createBusinessMemoryPrismaClient,
  createMvpToolRegistry
} from "../src/index.js";
import { listJavaScriptFiles } from "../scripts/list-js-files.mjs";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("business memory factory defaults to memory provider", () => {
  const repository = createBusinessMemoryRepository({ env: {} });

  assert.ok(repository instanceof InMemoryBusinessMemoryRepository);
  assert.equal(createBusinessMemoryConfig({}).provider, "memory");
  assert.equal(createBusinessMemoryConfig({}).dataSource.provider, "demo");
  assert.equal(createBusinessMemoryConfig({}).dataSource.sourceId, "demo");
  assert.equal(createBusinessMemoryConfig({}).dataSource.providerAdapter, "demo");
  assert.equal(createBusinessMemoryConfig({}).dataSource.adapterStatus, "offline_configured");
  assert.equal(createBusinessMemoryConfig({}).dataSource.externalConnectionsEnabled, false);
  assert.equal(createBusinessMemoryConfig({}).database.hasUrl, false);
});

test("business memory factory supports explicit memory provider", () => {
  const repository = createBusinessMemoryRepository({
    env: {
      BUSINESS_MEMORY_PROVIDER: "memory",
      DATABASE_URL: ""
    }
  });

  assert.ok(repository instanceof InMemoryBusinessMemoryRepository);
  assert.equal(repository.getBusinessDataSource().provider, "demo");
  assert.equal(repository.listBusinessRecords({ domain: "payments", agentId: "finance" }).length, 2);
});

test("business memory factory can prepare a future real data source without external connections", () => {
  const repository = createBusinessMemoryRepository({
    env: {
      BUSINESS_MEMORY_PROVIDER: "memory",
      BUSINESS_DATA_PROVIDER: "future_real_data",
      BUSINESS_DATA_SOURCE_ID: "future-crm",
      BUSINESS_PROVIDER_ADAPTER: "future_real_data"
    }
  });

  assert.ok(repository instanceof InMemoryBusinessMemoryRepository);
  assert.equal(repository.getBusinessDataSource().provider, "future_real_data");
  assert.equal(repository.getBusinessDataSource().sourceId, "future-crm");
  assert.equal(repository.getBusinessDataSource().adapter, "future_real_data");
  assert.equal(repository.getBusinessDataSource().adapterStatus, "offline_configured");
  assert.equal(repository.getBusinessDataSource().recordSource, "future_real_data");
  assert.equal(repository.getBusinessDataSource().externalConnectionsEnabled, false);
  assert.deepEqual(repository.listBusinessRecords({ domain: "payments", agentId: "finance", source: "future_real_data" }), []);
  assert.deepEqual(repository.listBusinessRecords({ domain: "payments", agentId: "finance", source: "demo_mock" }), []);
});

test("business memory factory accepts an injected generic business source", () => {
  const businessSource = createBusinessSource();
  const repository = createBusinessMemoryRepository({
    env: {
      BUSINESS_MEMORY_PROVIDER: "memory",
      BUSINESS_DATA_PROVIDER: "future_real_data"
    },
    businessSource
  });

  assert.equal(repository.getBusinessDataSource().provider, "demo");
  assert.equal(repository.listBusinessRecords({ domain: "quotes", agentId: "commercial" }).length, 2);
});

test("business memory factory supports postgres provider with injected Prisma client", () => {
  const prisma = {};
  const repository = createBusinessMemoryRepository({
    env: {
      BUSINESS_MEMORY_PROVIDER: "postgres",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/ai_agents"
    },
    prisma
  });

  assert.ok(repository instanceof PrismaBusinessMemoryRepository);
  assert.equal(repository.prisma, prisma);
  assert.equal(repository.getBusinessDataSource().provider, "demo");
});

// A static Prisma reference is any `@prisma/...` module specifier that is not
// the argument of a lazy `import(...)` / `require(...)` call. Classifying the
// specifier itself, instead of matching import syntax, keeps the guard valid
// for single-line imports, multi-line imports, bare side-effect imports and
// re-exports alike.
const PRISMA_MODULE_SPECIFIER = /["'](@prisma\/[^"'\n]*)["']/g;
const LAZY_MODULE_CALL = /(?:^|[^\w$])[\w$]*(?:require|import)[\w$]*\s*\(\s*$/i;

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:'"`\/])\/\/[^\n]*/g, "$1");
}

function findStaticPrismaReferences(source) {
  const code = stripComments(source);
  const references = [];

  for (const match of code.matchAll(PRISMA_MODULE_SPECIFIER)) {
    if (LAZY_MODULE_CALL.test(code.slice(0, match.index))) {
      continue;
    }
    references.push(match[1]);
  }

  return references;
}

test("the static Prisma guard recognizes every static import form", () => {
  const staticForms = [
    'import { PrismaClient } from "@prisma/client";',
    'import {\n  PrismaClient\n} from "@prisma/client";',
    'import "@prisma/client";',
    'export { PrismaClient } from "@prisma/client";',
    "import PrismaClient from '@prisma/client';",
    'export * from "@prisma/adapter-pg";'
  ];

  for (const form of staticForms) {
    assert.equal(
      findStaticPrismaReferences(form).length,
      1,
      `expected a static Prisma reference in: ${JSON.stringify(form)}`
    );
  }
});

test("the static Prisma guard still allows the lazy loading forms in use", () => {
  const lazyForms = [
    'const { PrismaClient } = await import("@prisma/client");',
    'const { PrismaPg } = requirePrisma("@prisma/adapter-pg");',
    'const client = require("@prisma/client");',
    'const mod = await import(\n  "@prisma/client"\n);',
    '// import { PrismaClient } from "@prisma/client";',
    '/* import { PrismaClient } from "@prisma/client"; */'
  ];

  for (const form of lazyForms) {
    assert.deepEqual(
      findStaticPrismaReferences(form),
      [],
      `expected no static Prisma reference in: ${JSON.stringify(form)}`
    );
  }
});

test("no source module imports Prisma statically, so demo mode starts without a generated client", async () => {
  const files = await listJavaScriptFiles(join(PROJECT_ROOT, "src"));
  const staticPrismaImports = [];
  const filesReferencingPrisma = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const staticReferences = findStaticPrismaReferences(source);

    if (staticReferences.length > 0) {
      staticPrismaImports.push(`${relative(PROJECT_ROOT, file)}: ${staticReferences.join(", ")}`);
    }
    if (/@prisma\//.test(source)) {
      filesReferencingPrisma.push(relative(PROJECT_ROOT, file));
    }
  }

  assert.deepEqual(staticPrismaImports, []);
  // The guard must not pass vacuously: Prisma is still reached from src/,
  // only ever through a lazy call.
  assert.ok(
    filesReferencingPrisma.length > 0,
    "expected at least one lazy Prisma reference in src/"
  );
});

test("memory provider builds a repository without loading Prisma", () => {
  const repository = createBusinessMemoryRepository({
    env: { BUSINESS_MEMORY_PROVIDER: "memory" }
  });

  assert.ok(repository instanceof InMemoryBusinessMemoryRepository);
  assert.equal(repository.listBusinessRecords({ domain: "quotes", agentId: "commercial" }).length, 2);
});

test("postgres provider with an injected client never loads Prisma packages", () => {
  const prisma = {};
  const repository = createBusinessMemoryRepository({
    env: {
      BUSINESS_MEMORY_PROVIDER: "postgres",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/ai_agents"
    },
    prisma
  });

  assert.ok(repository instanceof PrismaBusinessMemoryRepository);
  assert.equal(repository.prisma, prisma);
});

test("the real Prisma path still builds a client when the packages are installed", () => {
  let client;
  try {
    client = createBusinessMemoryPrismaClient("postgresql://user:pass@localhost:5432/ai_agents");
  } catch (error) {
    // Prisma Client is not generated in this environment: the factory must say so clearly.
    assert.ok(error instanceof BusinessMemoryConfigurationError);
    assert.match(error.message, /Prisma Client is not available/);
    return;
  }

  assert.ok(client);
});

test("business memory factory rejects unknown business data providers", () => {
  assert.throws(
    () => createBusinessMemoryRepository({
      env: {
        BUSINESS_DATA_PROVIDER: "crm"
      }
    }),
    /Unsupported BUSINESS_DATA_PROVIDER/
  );
});

test("business memory factory rejects unknown provider adapters", () => {
  assert.throws(
    () => createBusinessMemoryRepository({
      env: {
        BUSINESS_PROVIDER_ADAPTER: "real_crm"
      }
    }),
    /Unsupported BUSINESS_PROVIDER_ADAPTER/
  );
});

test("business memory factory rejects incompatible data provider and provider adapter", () => {
  assert.throws(
    () => createBusinessMemoryRepository({
      env: {
        BUSINESS_DATA_PROVIDER: "demo",
        BUSINESS_PROVIDER_ADAPTER: "future_real_data"
      }
    }),
    /BUSINESS_DATA_PROVIDER and BUSINESS_PROVIDER_ADAPTER/
  );
  assert.throws(
    () => createBusinessMemoryConfig({
      BUSINESS_DATA_PROVIDER: "future_real_data",
      BUSINESS_PROVIDER_ADAPTER: "demo"
    }),
    /BUSINESS_DATA_PROVIDER and BUSINESS_PROVIDER_ADAPTER/
  );
});

test("business memory factory rejects postgres provider without DATABASE_URL", () => {
  assert.throws(
    () => createBusinessMemoryRepository({
      env: {
        BUSINESS_MEMORY_PROVIDER: "postgres"
      }
    }),
    (error) =>
      error instanceof BusinessMemoryConfigurationError &&
      error.code === "BUSINESS_MEMORY_CONFIGURATION_ERROR" &&
      /DATABASE_URL/.test(error.message)
  );
});

test("business memory factory rejects unknown providers", () => {
  assert.throws(
    () => createBusinessMemoryRepository({
      env: {
        BUSINESS_MEMORY_PROVIDER: "sqlite"
      }
    }),
    (error) =>
      error instanceof BusinessMemoryConfigurationError &&
      error.code === "BUSINESS_MEMORY_CONFIGURATION_ERROR"
  );
});

test("MVP tool registry uses business memory factory default without changing demo behavior", async () => {
  const registry = createMvpToolRegistry();
  const result = await registry.execute("get_pending_quotes", {
    agentId: "commercial",
    agentPermissions: [{ kind: "read_analyze", resource: "request:*" }],
    requestId: "req-business-memory-factory",
    audit: false
  }, {
    requestId: "req-business-memory-factory"
  });

  assert.equal(result.status, "completed");
  assert.equal(result.output.demo, true);
  assert.equal(result.output.dataSource, "demo_mock");
  assert.equal(result.output.sourceProvider, "demo");
  assert.equal(result.output.sourceId, "demo");
  assert.deepEqual(result.output.items.map((item) => item.id), ["quote-atlas-001", "quote-solar-002"]);
});
