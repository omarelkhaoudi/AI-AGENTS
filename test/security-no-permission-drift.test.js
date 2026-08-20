import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_SECURITY_DOMAINS,
  BUSINESS_DOMAINS,
  BUSINESS_DOMAIN_DEFINITIONS,
  MVP_AGENT_IDS,
  TOOL_SECURITY_DOMAINS,
  agentSecurityDomains,
  createMvpAgentPermissions,
  createMvpToolRegistry,
  matchesResource
} from "../src/index.js";

// These snapshots are the least privilege model, frozen on purpose: a change
// here has to be a deliberate edit of this file, never a side effect.
//
// Lot 1  established the model.
// Lot 2A.1 added persistence only and changed nothing here.
// Lot 2B.1 adds four read tools and, with them, the four domains those tools
//          need: commercial +customers +orders, finance +customers +invoices,
//          production +orders, purchasing +suppliers. Every other agent is
//          untouched, and no agent gains a domain outside its own mission.
// Lot 2B.2 commit 3 adds two computing tools and changes NO agent scope:
//          get_receivables_summary reads payments and invoices, both already
//          held by finance, and get_quote_follow_ups reads quotes, already
//          held by commercial. Only the tool table below grows.
// Lot 2B.2 commit 4 adds get_production_schedule, reading production and
//          orders, both already held by production. Again no agent scope moves.
// Lot 2B.2 commit 5 adds get_material_requirements and IS the one commit of the
//          lot that widens an agent: purchasing gains orders,
//          bills_of_material, stock and products, the four domains the CDC
//          section 7 chain needs. All four are within the business memory
//          ceilings already declared for purchasing. No other agent moves.
const EXPECTED_AGENT_SECURITY_DOMAINS = Object.freeze({
  director: ["company_overview"],
  commercial: ["quotes", "customers", "orders"],
  finance: ["company_overview", "payments", "customers", "invoices"],
  production: ["production", "orders"],
  purchasing: ["purchase_needs", "suppliers", "orders", "bills_of_material", "stock", "products"],
  hr: ["hr"],
  after_sales: ["after_sales"],
  marketing: ["marketing"],
  community_manager: ["community"],
  legal: ["legal"]
});

const EXPECTED_TOOL_SECURITY_DOMAINS = Object.freeze({
  get_company_overview: ["company_overview"],
  get_pending_payments: ["payments"],
  get_pending_quotes: ["quotes"],
  get_delayed_production_orders: ["production"],
  get_purchase_needs: ["purchase_needs"],
  get_hr_overview: ["hr"],
  get_after_sales_overview: ["after_sales"],
  get_marketing_overview: ["marketing"],
  get_community_overview: ["community"],
  get_legal_overview: ["legal"],
  get_customer_overview: ["customers"],
  get_customer_orders: ["orders"],
  get_overdue_invoices: ["invoices"],
  get_supplier_catalog: ["suppliers"],
  get_receivables_summary: ["payments", "invoices"],
  get_quote_follow_ups: ["quotes"],
  get_production_schedule: ["production", "orders"],
  get_material_requirements: ["orders", "bills_of_material", "stock", "products"],
  execute_invoice_payment: ["payments"],
  prepare_hr_sensitive_decision: ["hr"],
  prepare_legal_sensitive_decision: ["legal"]
});

test("the ten CDC agents are all still present", () => {
  assert.equal(MVP_AGENT_IDS.length, 10);
  assert.deepEqual([...MVP_AGENT_IDS].sort(), Object.keys(EXPECTED_AGENT_SECURITY_DOMAINS).sort());
});

test("agent security domains match the reviewed snapshot exactly", () => {
  assert.deepEqual(
    Object.fromEntries(Object.keys(AGENT_SECURITY_DOMAINS).sort().map((agentId) => [
      agentId,
      [...agentSecurityDomains(agentId)].sort()
    ])),
    Object.fromEntries(Object.keys(EXPECTED_AGENT_SECURITY_DOMAINS).sort().map((agentId) => [
      agentId,
      [...EXPECTED_AGENT_SECURITY_DOMAINS[agentId]].sort()
    ]))
  );
});

test("tool security domains match the reviewed snapshot exactly", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(TOOL_SECURITY_DOMAINS).map(([id, domains]) => [id, [...domains]])),
    Object.fromEntries(Object.entries(EXPECTED_TOOL_SECURITY_DOMAINS).map(([id, domains]) => [id, [...domains]]))
  );
});

test("no tool was removed", () => {
  const registry = createMvpToolRegistry();
  const registered = registry.list().map((tool) => tool.id).sort();

  assert.deepEqual(registered, Object.keys(EXPECTED_TOOL_SECURITY_DOMAINS).sort());
});

// The Lot 1 invariant: an agent holds exactly the security domains its own
// tools need. New business domains must not appear on any agent.
test("each agent still holds exactly the domains its tools require", () => {
  const registry = createMvpToolRegistry();
  const needed = new Map(MVP_AGENT_IDS.map((agentId) => [agentId, new Set()]));

  for (const tool of registry.list()) {
    for (const agentId of tool.allowedAgents) {
      for (const domain of tool.securityDomains) {
        needed.get(agentId)?.add(domain);
      }
    }
  }

  for (const agentId of MVP_AGENT_IDS) {
    assert.deepEqual(
      [...agentSecurityDomains(agentId)].sort(),
      [...needed.get(agentId)].sort(),
      agentId
    );
  }
});

// Reference domains still unreachable by every agent. Lot 2B.2 commit 5 gives
// purchasing products, stock and bills_of_material for the CDC section 7 chain,
// so only prices and payment_terms remain out of reach for all ten agents.
test("the remaining business reference domains grant no agent any access", () => {
  const referenceDomains = ["prices", "payment_terms"];

  for (const domain of referenceDomains) {
    assert.ok(BUSINESS_DOMAINS.includes(domain), `${domain} must be a declared business domain`);

    for (const agentId of MVP_AGENT_IDS) {
      const permissions = createMvpAgentPermissions(agentId);
      assert.equal(
        permissions.some((permission) => matchesResource(permission.resource, `domain:${domain}`)),
        false,
        `${agentId} must not reach the ${domain} security scope`
      );
    }
  }
});

// The business memory layer declares its own allowedAgents ceiling. It must stay
// within the ten known agents and never contradict the security model above.
test("business domain access ceilings only mention known agents", () => {
  for (const domain of BUSINESS_DOMAINS) {
    for (const agentId of BUSINESS_DOMAIN_DEFINITIONS[domain].allowedAgents) {
      assert.ok(MVP_AGENT_IDS.includes(agentId), `${domain} allows unknown agent ${agentId}`);
    }
  }
});

test("seeded agent permissions still cover the request scope and nothing wider", () => {
  for (const agentId of MVP_AGENT_IDS) {
    const permissions = createMvpAgentPermissions(agentId);

    assert.ok(
      permissions.some((permission) => permission.resource === "request:*"),
      `${agentId} must keep its orchestration scope`
    );
    assert.equal(
      permissions.some((permission) => permission.resource === "*"),
      false,
      `${agentId} must never hold a wildcard permission`
    );
  }
});
