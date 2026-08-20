import { MVP_AGENT_IDS } from "../agents/default-agents.js";

// Security scope of each tool. This is the authorization domain, deliberately
// separate from the presentation domain reported by the Director API: narrowing
// a security scope must never be coupled to how a result is displayed.
export const TOOL_SECURITY_DOMAINS = Object.freeze({
  get_company_overview: Object.freeze(["company_overview"]),
  get_pending_payments: Object.freeze(["payments"]),
  get_pending_quotes: Object.freeze(["quotes"]),
  get_delayed_production_orders: Object.freeze(["production"]),
  get_purchase_needs: Object.freeze(["purchase_needs"]),
  get_hr_overview: Object.freeze(["hr"]),
  get_after_sales_overview: Object.freeze(["after_sales"]),
  get_marketing_overview: Object.freeze(["marketing"]),
  get_community_overview: Object.freeze(["community"]),
  get_legal_overview: Object.freeze(["legal"]),
  get_customer_overview: Object.freeze(["customers"]),
  get_customer_orders: Object.freeze(["orders"]),
  get_overdue_invoices: Object.freeze(["invoices"]),
  get_supplier_catalog: Object.freeze(["suppliers"]),
  get_receivables_summary: Object.freeze(["payments", "invoices"]),
  get_quote_follow_ups: Object.freeze(["quotes"]),
  get_production_schedule: Object.freeze(["production", "orders"]),
  execute_invoice_payment: Object.freeze(["payments"]),
  prepare_hr_sensitive_decision: Object.freeze(["hr"]),
  prepare_legal_sensitive_decision: Object.freeze(["legal"])
});

// Least privilege: each of the ten agents is scoped to the domains its own
// mission needs, and to nothing else. Every agent of the CDC hierarchy is
// present; none is granted a domain it has no tool for.
export const AGENT_SECURITY_DOMAINS = Object.freeze({
  director: Object.freeze(["company_overview"]),
  commercial: Object.freeze(["quotes", "customers", "orders"]),
  finance: Object.freeze(["company_overview", "payments", "customers", "invoices"]),
  production: Object.freeze(["production", "orders"]),
  purchasing: Object.freeze(["purchase_needs", "suppliers"]),
  hr: Object.freeze(["hr"]),
  after_sales: Object.freeze(["after_sales"]),
  marketing: Object.freeze(["marketing"]),
  community_manager: Object.freeze(["community"]),
  legal: Object.freeze(["legal"])
});

export const DOMAIN_RESOURCE_PREFIX = "domain:";

export function toolSecurityDomains(toolId) {
  return TOOL_SECURITY_DOMAINS[toolId] ? [...TOOL_SECURITY_DOMAINS[toolId]] : [];
}

export function domainResource(domain) {
  return `${DOMAIN_RESOURCE_PREFIX}${domain}`;
}

export function agentSecurityDomains(agentId) {
  return AGENT_SECURITY_DOMAINS[agentId] ? [...AGENT_SECURITY_DOMAINS[agentId]] : [];
}

export function listSecurityScopedAgentIds() {
  return MVP_AGENT_IDS.filter((agentId) => AGENT_SECURITY_DOMAINS[agentId]);
}
