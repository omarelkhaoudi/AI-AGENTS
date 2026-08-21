import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  PrismaBusinessMemoryRepository,
  createBusinessDirectory,
  createBusinessMemoryPrismaClient,
  createBusinessMemoryRepository,
  hasValidDatabaseUrl
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

const postgresIntegrationEnabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const postgresUrlAvailable = hasValidDatabaseUrl(process.env.DATABASE_URL);
const skipReason =
  postgresIntegrationEnabled && postgresUrlAvailable
    ? false
    : "Set RUN_POSTGRES_INTEGRATION=true and DATABASE_URL to run the Director PostgreSQL equivalence tests.";

const MESSAGE = "Fais-moi le point sur mon entreprise aujourd'hui.";

async function report(businessMemory) {
  const { app, inject } = await buildAuthenticatedApi({
    repository: new InMemoryRepository(),
    businessMemory
  });
  try {
    const response = await inject({ method: "POST", url: "/api/director/requests", payload: { message: MESSAGE } });
    assert.equal(response.statusCode, 201);
    return JSON.parse(response.body);
  } finally {
    await app.close();
  }
}

function shape(body) {
  return {
    status: body.status,
    headline: body.summary.headline,
    tools: body.results.map((result) => result.tool),
    sections: Object.fromEntries(
      Object.entries(body.summary.minimumSections).map(([name, entries]) => [
        name,
        entries.map((entry) => entry.label ?? entry.reason)
      ])
    ),
    aggregates: body.summary.aggregates
  };
}

// Both providers hold the same seeded records, so the Director must produce the
// same report through either one. Anything that differs is something the report
// takes from somewhere other than the business memory.
test("the Director reports the same thing from memory and from PostgreSQL", { skip: skipReason }, async () => {
  const prisma = createBusinessMemoryPrismaClient(process.env.DATABASE_URL);
  try {
    const fromMemory = shape(await report(createBusinessMemoryRepository({ env: { BUSINESS_MEMORY_PROVIDER: "memory" } })));
    const fromPostgres = shape(await report(new PrismaBusinessMemoryRepository({ prisma })));

    assert.equal(fromPostgres.status, fromMemory.status);
    assert.equal(fromPostgres.headline, fromMemory.headline);
    assert.deepEqual(fromPostgres.tools, fromMemory.tools);
    assert.deepEqual(fromPostgres.sections, fromMemory.sections);
    assert.deepEqual(fromPostgres.aggregates, fromMemory.aggregates);
  } finally {
    await prisma.$disconnect();
  }
});

// The debt this commit pays off: the directory was built from the demo data set
// and cached for the life of the process, so the Director kept naming demo
// customers next to real amounts. This exercises the divergence rather than the
// structure: the name in the database is changed, and the report must follow.
test("a customer renamed in PostgreSQL is the name the next report shows", { skip: skipReason }, async () => {
  const prisma = createBusinessMemoryPrismaClient(process.env.DATABASE_URL);
  const memory = new PrismaBusinessMemoryRepository({ prisma });
  const original = await memory.getBusinessRecord({
    domain: "customers",
    id: "customer-atlas",
    agentId: "director",
    source: "demo_mock"
  });
  assert.ok(original, "the business seed must have run before this test");

  try {
    const before = shape(await report(memory));
    assert.ok(
      before.sections["A ENCAISSER"].some((label) => label.includes(original.data.name)),
      "the seeded name is reported to begin with"
    );

    const renamed = "Renamed In Database SARL";
    await memory.saveBusinessRecord({ ...original, data: { ...original.data, name: renamed } });

    const after = shape(await report(memory));

    assert.ok(
      after.sections["A ENCAISSER"].some((label) => label.includes(renamed)),
      "the report must show the name the database now holds"
    );
    assert.equal(
      after.sections["A ENCAISSER"].some((label) => label.includes(original.data.name)),
      false,
      "no demo name may survive once the database says otherwise"
    );
    // Only the name moved: the amounts and the section sizes are untouched.
    assert.equal(after.sections["A ENCAISSER"].length, before.sections["A ENCAISSER"].length);
    assert.ok(after.sections["A ENCAISSER"].every((label) => label.includes("MAD")));
  } finally {
    await memory.saveBusinessRecord(original);
    await prisma.$disconnect();
  }
});

test("the directory is read from the business memory, as the Director", { skip: skipReason }, async () => {
  const prisma = createBusinessMemoryPrismaClient(process.env.DATABASE_URL);
  try {
    const directory = await createBusinessDirectory(new PrismaBusinessMemoryRepository({ prisma }));

    assert.ok(directory.customerNames.size > 0, "customers are read");
    assert.ok(directory.customerIdByOrder.size > 0, "orders are read");
    assert.equal(directory.customerNames.get("customer-atlas"), "Demo Client Atlas");
    assert.equal(directory.customerIdByOrder.get("order-atlas-001"), "customer-atlas");
  } finally {
    await prisma.$disconnect();
  }
});

// No business memory, no names. The builder must not reach for a data set of
// its own when it is given nothing.
test("a missing business memory yields an empty directory, never demo names", async () => {
  for (const input of [null, undefined, {}]) {
    const directory = await createBusinessDirectory(input);
    assert.equal(directory.customerNames.size, 0);
    assert.equal(directory.customerIdByOrder.size, 0);
  }
});
