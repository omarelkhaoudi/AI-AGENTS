import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  ToolContractError,
  ToolExecutionService,
  ToolExecutionServiceError,
  ToolRegistry,
  createPermission,
  createToolDefinition,
  createToolInputSchema,
  domainResource
} from "../src/index.js";

// Every tool shipped so far reads a single domain, so multi-domain scoping would
// otherwise go untested. These tools exist only here, to exercise the rule.
const INPUT_SCHEMA = createToolInputSchema({
  required: ["requestId"],
  properties: { requestId: { type: "string" } }
});

function createTool({ id = "multi_domain_tool", securityDomains, allowedAgents = ["finance"] } = {}) {
  return createToolDefinition({
    id,
    name: "Multi Domain Tool",
    description: "Reads several business domains at once.",
    category: "finance",
    securityDomains,
    requiredPermission: "read_analyze",
    allowedAgents,
    inputSchema: INPUT_SCHEMA,
    execute: async () => ({ demo: true, items: [] })
  });
}

function createHarness(tool) {
  const repository = new InMemoryRepository();
  const registry = new ToolRegistry({ repository });
  registry.register(tool);
  return { repository, service: new ToolExecutionService({ repository, toolRegistry: registry }) };
}

function scopes(...domains) {
  return [
    createPermission({ kind: "read_analyze", resource: "request:*" }),
    ...domains.map((domain) => createPermission({ kind: "read_analyze", resource: domainResource(domain) }))
  ];
}

function execute(service, agentPermissions, toolId = "multi_domain_tool") {
  return service.execute({
    agentId: "finance",
    agentPermissions,
    toolId,
    input: { requestId: "req-multi" },
    requestId: "req-multi",
    planStepId: "step-multi"
  });
}

test("a tool may declare several security domains", () => {
  const tool = createTool({ securityDomains: ["payments", "invoices"] });

  assert.deepEqual([...tool.securityDomains], ["payments", "invoices"]);
});

test("an agent holding every declared domain is allowed", async () => {
  const { service } = createHarness(createTool({ securityDomains: ["payments", "invoices"] }));

  const result = await execute(service, scopes("payments", "invoices"));

  assert.equal(result.status, "completed");
});

// The rule that matters: holding a subset is a denial, not a partial grant.
test("an agent holding only some declared domains is denied", async () => {
  const { service, repository } = createHarness(createTool({ securityDomains: ["payments", "invoices"] }));

  await assert.rejects(
    () => execute(service, scopes("payments")),
    (error) => {
      assert.ok(error instanceof ToolExecutionServiceError);
      assert.equal(error.code, "DOMAIN_NOT_ALLOWED");
      assert.deepEqual(error.details.missingDomains, ["invoices"]);
      assert.deepEqual([...error.details.securityDomains], ["payments", "invoices"]);
      return true;
    }
  );

  const denied = (await repository.listAuditEvents()).filter((event) => event.type === "permission_denied");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].metadata.code, "DOMAIN_NOT_ALLOWED");
});

test("the denial names every missing domain, not just the first", async () => {
  const { service } = createHarness(createTool({ securityDomains: ["payments", "invoices", "customers"] }));

  await assert.rejects(
    () => execute(service, scopes("payments")),
    (error) => {
      assert.deepEqual(error.details.missingDomains, ["invoices", "customers"]);
      return true;
    }
  );
});

test("an agent holding none of the declared domains is denied", async () => {
  const { service } = createHarness(createTool({ securityDomains: ["payments", "invoices"] }));

  await assert.rejects(
    () => execute(service, scopes()),
    (error) => {
      assert.deepEqual(error.details.missingDomains, ["payments", "invoices"]);
      return true;
    }
  );
});

test("a wildcard domain permission satisfies every declared domain", async () => {
  const { service } = createHarness(createTool({ securityDomains: ["payments", "invoices"] }));

  const result = await execute(service, [
    createPermission({ kind: "read_analyze", resource: "request:*" }),
    createPermission({ kind: "read_analyze", resource: "domain:*" })
  ]);

  assert.equal(result.status, "completed");
});

test("a tool declaring no domain keeps working without any domain scope", async () => {
  const { service } = createHarness(createTool({ id: "unscoped_tool", securityDomains: [] }));

  const result = await execute(service, scopes(), "unscoped_tool");

  assert.equal(result.status, "completed");
});

test("domain order does not change the outcome", async () => {
  const { service } = createHarness(createTool({ securityDomains: ["invoices", "payments"] }));

  const result = await execute(service, scopes("payments", "invoices"));

  assert.equal(result.status, "completed");
});

test("the contract rejects a malformed security domain list", () => {
  assert.throws(() => createTool({ securityDomains: "payments" }), ToolContractError);
  assert.throws(() => createTool({ securityDomains: ["payments", ""] }), ToolContractError);
  assert.throws(() => createTool({ securityDomains: ["payments", "   "] }), ToolContractError);
  assert.throws(() => createTool({ securityDomains: [null] }), ToolContractError);
  // A duplicate would silently weaken the "every domain" rule into a shorter list.
  assert.throws(() => createTool({ securityDomains: ["payments", "payments"] }), ToolContractError);
});

test("the declared domain list cannot be mutated through the tool definition", () => {
  const declared = ["payments", "invoices"];
  const tool = createTool({ securityDomains: declared });

  declared.push("customers");

  assert.deepEqual([...tool.securityDomains], ["payments", "invoices"]);
});
