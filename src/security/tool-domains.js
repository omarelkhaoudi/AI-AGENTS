import { MVP_AGENT_IDS } from "../agents/default-agents.js";

// Security scope of each tool. This is the authorization domain, deliberately
// separate from the presentation domain reported by the Director API: narrowing
// a security scope must never be coupled to how a result is displayed.
export const TOOL_SECURITY_DOMAINS = Object.freeze({
  get_company_overview: "company_overview",
  get_pending_payments: "payments",
  get_pending_quotes: "quotes",
  get_delayed_production_orders: "production",
  get_purchase_needs: "purchase_needs",
  get_hr_overview: "hr",
  get_after_sales_overview: "after_sales",
  get_marketing_overview: "marketing",
  get_community_overview: "community",
  get_legal_overview: "legal",
  get_customer_overview: "customers",
  get_customer_orders: "orders",
  get_overdue_invoices: "invoices",
  get_supplier_catalog: "suppliers",
  execute_invoice_payment: "payments",
  prepare_hr_sensitive_decision: "hr",
  prepare_legal_sensitive_decision: "legal"
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

export function toolSecurityDomain(toolId) {
  return TOOL_SECURITY_DOMAINS[toolId] ?? null;
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
