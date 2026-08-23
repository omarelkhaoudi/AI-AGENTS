import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_SECURITY_DOMAINS,
  InMemoryRepository,
  MVP_AGENT_IDS,
  ToolExecutionService,
  ToolExecutionServiceError,
  agentSecurityDomains,
  createMvpAgentPermissions,
  createMvpToolRegistry,
  createPermission,
  domainResource,
  evaluateActionPolicy,
  matchesResource,
  toolSecurityDomains
} from "../src/index.js";
import { listJavaScriptFiles } from "../scripts/list-js-files.mjs";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("matchesResource truth table", () => {
  // A wildcard PERMISSION grants everything.
  assert.equal(matchesResource("*", "request:abc"), true);
  assert.equal(matchesResource("*", "*"), true);

  // A wildcard REQUEST must not unlock a narrowly scoped permission.
  assert.equal(matchesResource("request:abc", "*"), false);
  assert.equal(matchesResource("request:*", "*"), false);
  assert.equal(matchesResource("domain:payments", "*"), false);

  // Exact matches.
  assert.equal(matchesResource("request:abc", "request:abc"), true);
  assert.equal(matchesResource("request:abc", "request:def"), false);

  // Prefix wildcards stay bounded to their segment.
  assert.equal(matchesResource("request:*", "request:abc"), true);
  assert.equal(matchesResource("request:*", "request:"), false);
  assert.equal(matchesResource("request:*", "requestother:abc"), false);
  assert.equal(matchesResource("domain:*", "domain:payments"), true);
  assert.equal(matchesResource("domain:payments", "domain:payments_secret"), false);

  // Non-string inputs are never a match.
  assert.equal(matchesResource(null, "request:abc"), false);
  assert.equal(matchesResource("request:*", null), false);
  assert.equal(matchesResource(undefined, undefined), true);
});

test("a wildcard requested resource can no longer escalate a scoped permission", () => {
  const scoped = [createPermission({ kind: "execute_action", resource: "request:AAA" })];

  assert.equal(
    evaluateActionPolicy({ permissions: scoped, actionKind: "execute_action", resource: "request:AAA" }).decision,
    "execute_directly"
  );
  assert.equal(
    evaluateActionPolicy({ permissions: scoped, actionKind: "execute_action", resource: "request:BBB" }).decision,
    "denied"
  );
  assert.equal(
    evaluateActionPolicy({ permissions: scoped, actionKind: "execute_action", resource: "*" }).decision,
    "denied"
  );
  // The default resource is "*", so omitting it must not grant anything either.
  assert.equal(
    evaluateActionPolicy({ permissions: scoped, actionKind: "execute_action" }).decision,
    "denied"
  );
});

test("no matching permission is DENIED before any approval consideration", () => {
  const noPermission = evaluateActionPolicy({
    permissions: [],
    actionKind: "execute_action",
    resource: "request:AAA",
    requiresApproval: true
  });

  assert.equal(noPermission.decision, "denied");
  assert.equal(noPermission.allowed, false);
  assert.equal(noPermission.canPrepare, false);
  assert.equal(noPermission.requiresApproval, false);
  // The reason distinguishes the two denial paths: reaching the approval branch
  // first would report a preparation failure instead of a missing permission.
  assert.equal(noPermission.reason, "No matching permission allows this action.");

  const wrongResource = evaluateActionPolicy({
    permissions: [createPermission({ kind: "execute_action", resource: "request:OTHER" })],
    actionKind: "execute_action",
    resource: "request:AAA",
    requiresApproval: true
  });
  assert.equal(wrongResource.decision, "denied");
});

test("a read-only permission cannot prepare a sensitive action for approval", () => {
  const readOnly = evaluateActionPolicy({
    permissions: [createPermission({ kind: "read_analyze", resource: "request:AAA" })],
    actionKind: "execute_action",
    resource: "request:AAA",
    requiresApproval: true
  });

  assert.equal(readOnly.decision, "denied");
  assert.equal(readOnly.canPrepare, false);

  const canPrepare = evaluateActionPolicy({
    permissions: [createPermission({ kind: "prepare_action", resource: "request:AAA" })],
    actionKind: "execute_action",
    resource: "request:AAA",
    requiresApproval: true
  });
  assert.equal(canPrepare.decision, "requires_human_approval");
  assert.equal(canPrepare.canPrepare, true);
});

test("matchesResource has exactly one implementation in the source tree", async () => {
  const files = await listJavaScriptFiles(join(PROJECT_ROOT, "src"));
  const implementations = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (/function\s+matchesResource\s*\(/.test(source)) {
      implementations.push(relative(PROJECT_ROOT, file));
    }
  }

  assert.deepEqual(implementations, [join("src", "security", "permissions.js")]);
});

test("every MVP tool declares a security domain, and every allowed agent is scoped to it", () => {
  const registry = createMvpToolRegistry();

  for (const tool of registry.list()) {
    assert.ok(tool.securityDomains.length > 0, `${tool.id} must declare at least one security domain`);
    assert.deepEqual([...tool.securityDomains], toolSecurityDomains(tool.id));

    for (const agentId of tool.allowedAgents) {
      for (const domain of tool.securityDomains) {
        assert.ok(
          agentSecurityDomains(agentId).includes(domain),
          `${agentId} must be scoped to ${domain} to use ${tool.id}`
        );
      }
    }
  }
});

test("the ten CDC agents are all present and none holds a domain it has no tool for", () => {
  assert.equal(MVP_AGENT_IDS.length, 10);

  // notify_delay_alert is registered only when a client is injected, so the
  // invariant is checked against the full registry. The stub performs no call.
  const registry = createMvpToolRegistry({
    workflowClient: { postWorkflowEvent: async () => { throw new Error("never called"); } }
  });
  const neededByAgent = new Map(MVP_AGENT_IDS.map((agentId) => [agentId, new Set()]));
  for (const tool of registry.list()) {
    for (const agentId of tool.allowedAgents) {
      for (const domain of tool.securityDomains) {
        neededByAgent.get(agentId)?.add(domain);
      }
    }
  }

  for (const agentId of MVP_AGENT_IDS) {
    assert.ok(AGENT_SECURITY_DOMAINS[agentId], `${agentId} must keep a declared security scope`);
    assert.deepEqual(
      [...agentSecurityDomains(agentId)].sort(),
      [...neededByAgent.get(agentId)].sort(),
      `${agentId} must hold exactly the domains its own tools need`
    );
  }
});

test("seeded agent permissions are scoped to the agent business domains", () => {
  for (const agentId of MVP_AGENT_IDS) {
    const permissions = createMvpAgentPermissions(agentId);
    const domains = agentSecurityDomains(agentId);

    for (const domain of domains) {
      assert.ok(
        permissions.some((permission) => matchesResource(permission.resource, domainResource(domain))),
        `${agentId} must be granted ${domain}`
      );
    }

    // No agent may reach a domain outside its own perimeter.
    for (const foreignDomain of Object.values(AGENT_SECURITY_DOMAINS).flat()) {
      if (domains.includes(foreignDomain)) {
        continue;
      }
      assert.equal(
        permissions.some((permission) => matchesResource(permission.resource, domainResource(foreignDomain))),
        false,
        `${agentId} must not reach ${foreignDomain}`
      );
    }
  }
});

test("an agent outside the tool business domain is denied even when allowedAgents would pass", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({ repository, toolRegistry: createMvpToolRegistry({ repository }) });

  // Finance is an allowed agent for get_pending_payments, but here it carries
  // only the commercial scope: the domain check must still refuse.
  await assert.rejects(
    () => service.execute({
      agentId: "finance",
      agentPermissions: createMvpAgentPermissions("commercial"),
      toolId: "get_pending_payments",
      input: { requestId: "req-domain" },
      requestId: "req-domain"
    }),
    (error) => error instanceof ToolExecutionServiceError && error.code === "DOMAIN_NOT_ALLOWED"
  );

  const denied = (await repository.listAuditEvents()).filter((event) => event.type === "permission_denied");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].metadata.code, "DOMAIN_NOT_ALLOWED");
});

test("the domain check narrows without masking the general permission denial", async () => {
  const repository = new InMemoryRepository();
  const service = new ToolExecutionService({ repository, toolRegistry: createMvpToolRegistry({ repository }) });

  await assert.rejects(
    () => service.execute({
      agentId: "finance",
      agentPermissions: [],
      toolId: "get_pending_payments",
      input: { requestId: "req-none" },
      requestId: "req-none"
    }),
    (error) => error instanceof ToolExecutionServiceError && error.code === "PERMISSION_DENIED"
  );
});
