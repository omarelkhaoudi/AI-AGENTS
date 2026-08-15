import assert from "node:assert/strict";
import test from "node:test";
import {
  BusinessMemoryConfigurationError,
  InMemoryBusinessMemoryRepository,
  PrismaBusinessMemoryRepository,
  createBusinessMemoryConfig,
  createBusinessMemoryRepository,
  createMvpToolRegistry
} from "../src/index.js";

test("business memory factory defaults to memory provider", () => {
  const repository = createBusinessMemoryRepository({ env: {} });

  assert.ok(repository instanceof InMemoryBusinessMemoryRepository);
  assert.equal(createBusinessMemoryConfig({}).provider, "memory");
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
  assert.equal(repository.listBusinessRecords({ domain: "payments", agentId: "finance" }).length, 2);
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
  assert.deepEqual(result.output.items.map((item) => item.id), ["quote-atlas-001", "quote-solar-002"]);
});
