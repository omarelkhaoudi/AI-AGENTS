import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUSINESS_DOMAINS,
  BUSINESS_DOMAIN_ALIASES,
  BUSINESS_DOMAIN_DEFINITIONS,
  BUSINESS_DATA_SOURCES,
  DOMAIN_MODEL_MAP,
  MVP_AGENT_IDS,
  createBusinessRecord,
  createBusinessSource,
  getDomainModelConfig,
  normalizeBusinessDomain
} from "../src/index.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Adding a business domain requires several declarations to stay in step. Each
// one is cheap to forget and fails silently at runtime, so the whole wiring is
// asserted here rather than discovered in production.
test("every business domain declares a complete definition", () => {
  for (const domain of BUSINESS_DOMAINS) {
    const definition = BUSINESS_DOMAIN_DEFINITIONS[domain];

    assert.ok(definition, `${domain} must have a domain definition`);
    assert.ok(definition.label?.length > 0, `${domain} must declare a label`);
    assert.ok(definition.recordType?.length > 0, `${domain} must declare a recordType`);
    assert.ok(Array.isArray(definition.allowedAgents), `${domain} must declare allowedAgents`);
    assert.ok(definition.allowedAgents.length > 0, `${domain} must allow at least one agent`);
    assert.ok(Array.isArray(definition.essentialFields), `${domain} must declare essentialFields`);
  }
});

test("no domain definition exists outside the declared domain list", () => {
  assert.deepEqual(
    Object.keys(BUSINESS_DOMAIN_DEFINITIONS).sort(),
    [...BUSINESS_DOMAINS].sort(),
    "definitions and BUSINESS_DOMAINS must describe exactly the same domains"
  );
});

test("every domain allows only agents that actually exist", () => {
  for (const domain of BUSINESS_DOMAINS) {
    for (const agentId of BUSINESS_DOMAIN_DEFINITIONS[domain].allowedAgents) {
      assert.ok(
        MVP_AGENT_IDS.includes(agentId),
        `${domain} allows unknown agent ${agentId}`
      );
    }
  }
});

test("every business domain is mapped to a Prisma delegate with a matching record type", () => {
  assert.deepEqual(
    Object.keys(DOMAIN_MODEL_MAP).sort(),
    [...BUSINESS_DOMAINS].sort(),
    "DOMAIN_MODEL_MAP and BUSINESS_DOMAINS must describe exactly the same domains"
  );

  for (const domain of BUSINESS_DOMAINS) {
    const config = getDomainModelConfig(domain);

    assert.ok(config, `${domain} must map to a Prisma model`);
    assert.ok(config.delegate?.length > 0, `${domain} must declare a Prisma delegate`);
    assert.equal(typeof config.toPrisma, "function", `${domain} must declare a toPrisma mapper`);
    assert.equal(
      config.recordType,
      BUSINESS_DOMAIN_DEFINITIONS[domain].recordType,
      `${domain} record type must match between the domain definition and the Prisma mapping`
    );
  }
});

test("every Prisma delegate corresponds to a model declared in the schema", async () => {
  const schema = await readFile(join(PROJECT_ROOT, "prisma", "schema.prisma"), "utf8");
  const declaredModels = [...schema.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{/gm)].map((match) => match[1]);

  for (const domain of BUSINESS_DOMAINS) {
    const { delegate } = getDomainModelConfig(domain);
    // Prisma derives a delegate name by lower-casing the first letter of the model.
    const expectedModel = delegate.charAt(0).toUpperCase() + delegate.slice(1);

    assert.ok(
      declaredModels.includes(expectedModel),
      `${domain} maps to delegate "${delegate}" but model ${expectedModel} is not declared in schema.prisma`
    );
  }
});

// Relations and dates are validated strictly by the record contract: a domain
// whose canonical fields are undeclared throws as soon as a record is built.
test("every domain can build a canonical record with its declared relations and dates", () => {
  for (const domain of BUSINESS_DOMAINS) {
    const definition = BUSINESS_DOMAIN_DEFINITIONS[domain];
    const record = createBusinessRecord({
      id: `registry-${domain}`,
      domain,
      recordType: definition.recordType,
      status: "draft",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: {},
      relations: {},
      dates: {},
      metadata: {}
    });

    assert.equal(record.domain, domain);
    assert.equal(record.recordType, definition.recordType);
    assert.ok(record.relations && typeof record.relations === "object", `${domain} relations must normalize`);
    assert.ok(record.dates && typeof record.dates === "object", `${domain} dates must normalize`);
  }
});

test("domain aliases resolve to declared domains", () => {
  for (const [alias, target] of Object.entries(BUSINESS_DOMAIN_ALIASES)) {
    assert.ok(
      BUSINESS_DOMAINS.includes(target),
      `alias ${alias} points at undeclared domain ${target}`
    );
    assert.equal(normalizeBusinessDomain(alias), target);
    assert.equal(
      BUSINESS_DOMAINS.includes(alias),
      false,
      `alias ${alias} must not also be a domain`
    );
  }
});

test("the business source layer reports exactly the declared domains", () => {
  const source = createBusinessSource();

  assert.deepEqual(
    [...source.listBusinessDomains()].sort(),
    [...BUSINESS_DOMAINS].sort(),
    "the provider adapter layer must expose the same domains as the contract"
  );
});
