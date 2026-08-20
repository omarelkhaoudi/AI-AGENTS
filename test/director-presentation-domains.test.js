import assert from "node:assert/strict";
import test from "node:test";
import { BUSINESS_DOMAIN_BY_TOOL, createMvpToolRegistry } from "../src/index.js";

// The Director groups results by presentation domain. A tool with no domain
// reports null and silently escapes every section filter, so the table must
// cover the registry exactly.
test("every registered tool declares a presentation domain", () => {
  const missing = createMvpToolRegistry()
    .list()
    .map((tool) => tool.id)
    .filter((toolId) => !BUSINESS_DOMAIN_BY_TOOL[toolId]);

  assert.deepEqual(missing, [], "these tools would report domain null in the Director sections");
});

test("the presentation table has no entry outside the registry", () => {
  const registered = new Set(createMvpToolRegistry().list().map((tool) => tool.id));
  const orphans = Object.keys(BUSINESS_DOMAIN_BY_TOOL).filter((toolId) => !registered.has(toolId));

  assert.deepEqual(orphans, []);
});

test("every presentation domain is a non-empty string", () => {
  for (const [toolId, domain] of Object.entries(BUSINESS_DOMAIN_BY_TOOL)) {
    assert.equal(typeof domain, "string", toolId);
    assert.ok(domain.trim().length > 0, toolId);
  }
});

// A tool reading several domains still reports one presentation domain: the one
// of the section it feeds. These two are pinned because Director section
// assertions require them:
//   minimumSections["A ENCAISSER"].every(entry => entry.domain === "payments")
//   summary.receivables.every(entry => entry.domain === "payments")
//   minimumSections["A COMMANDER"].every(entry => entry.domain === "purchase_needs")
test("multi domain tools report the presentation domain of the section they feed", () => {
  assert.equal(BUSINESS_DOMAIN_BY_TOOL.get_receivables_summary, "payments");
  assert.equal(BUSINESS_DOMAIN_BY_TOOL.get_material_requirements, "purchase_needs");
  assert.equal(BUSINESS_DOMAIN_BY_TOOL.get_production_schedule, "production");
  assert.equal(BUSINESS_DOMAIN_BY_TOOL.get_quote_follow_ups, "quotes");
});

// Historical mappings are load bearing for existing Director assertions and
// must not drift.
test("the mappings that existed before Lot 2C are unchanged", () => {
  assert.deepEqual(
    {
      get_pending_payments: BUSINESS_DOMAIN_BY_TOOL.get_pending_payments,
      get_pending_quotes: BUSINESS_DOMAIN_BY_TOOL.get_pending_quotes,
      get_delayed_production_orders: BUSINESS_DOMAIN_BY_TOOL.get_delayed_production_orders,
      get_purchase_needs: BUSINESS_DOMAIN_BY_TOOL.get_purchase_needs,
      get_after_sales_overview: BUSINESS_DOMAIN_BY_TOOL.get_after_sales_overview,
      get_hr_overview: BUSINESS_DOMAIN_BY_TOOL.get_hr_overview,
      prepare_hr_sensitive_decision: BUSINESS_DOMAIN_BY_TOOL.prepare_hr_sensitive_decision,
      get_marketing_overview: BUSINESS_DOMAIN_BY_TOOL.get_marketing_overview,
      get_community_overview: BUSINESS_DOMAIN_BY_TOOL.get_community_overview,
      get_legal_overview: BUSINESS_DOMAIN_BY_TOOL.get_legal_overview,
      prepare_legal_sensitive_decision: BUSINESS_DOMAIN_BY_TOOL.prepare_legal_sensitive_decision
    },
    {
      get_pending_payments: "payments",
      get_pending_quotes: "quotes",
      get_delayed_production_orders: "production",
      get_purchase_needs: "purchase_needs",
      get_after_sales_overview: "after_sales_tickets",
      get_hr_overview: "hr_demo_overview",
      prepare_hr_sensitive_decision: "hr_demo_overview",
      get_marketing_overview: "marketing_demo_overview",
      get_community_overview: "community_demo_overview",
      get_legal_overview: "legal_demo_overview",
      prepare_legal_sensitive_decision: "legal_demo_overview"
    }
  );
});

// The one behaviour this commit changes: a routed tool that reported no domain.
test("the routed sensitive payment tool reports the payments domain", () => {
  assert.equal(BUSINESS_DOMAIN_BY_TOOL.execute_invoice_payment, "payments");
});
