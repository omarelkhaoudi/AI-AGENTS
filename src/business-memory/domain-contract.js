import { BUSINESS_DATA_SOURCES, normalizeBusinessDataSource } from "./source.js";

export const BUSINESS_DOMAINS = Object.freeze([
  "customers",
  "quotes",
  "invoices",
  "payments",
  "orders",
  "production",
  "purchase_needs",
  "suppliers",
  "after_sales_tickets"
]);

export const BUSINESS_DOMAIN_DEFINITIONS = Object.freeze({
  customers: createBusinessDomainDefinition({
    label: "Clients",
    recordType: "customer",
    allowedAgents: ["director", "commercial", "finance", "after_sales", "legal"],
    essentialFields: ["id", "name", "status", "createdAt", "updatedAt", "source", "metadata"]
  }),
  quotes: createBusinessDomainDefinition({
    label: "Devis",
    recordType: "quote",
    allowedAgents: ["director", "commercial"],
    essentialFields: ["id", "customerId", "prospectId", "status", "issuedAt", "validUntil", "source", "metadata"]
  }),
  invoices: createBusinessDomainDefinition({
    label: "Factures",
    recordType: "invoice",
    allowedAgents: ["director", "finance"],
    essentialFields: ["id", "customerId", "quoteId", "orderId", "status", "issuedAt", "dueAt", "source", "metadata"]
  }),
  payments: createBusinessDomainDefinition({
    label: "Paiements / creances",
    recordType: "payment",
    allowedAgents: ["director", "finance"],
    essentialFields: ["id", "customerId", "invoiceId", "orderId", "status", "dueAt", "source", "metadata"]
  }),
  orders: createBusinessDomainDefinition({
    label: "Commandes",
    recordType: "order",
    allowedAgents: ["director", "commercial", "production", "purchasing", "after_sales"],
    essentialFields: ["id", "customerId", "quoteId", "status", "dueAt", "source", "metadata"]
  }),
  production: createBusinessDomainDefinition({
    label: "Production",
    recordType: "production_signal",
    allowedAgents: ["director", "production"],
    essentialFields: ["id", "orderId", "status", "dueAt", "source", "metadata"]
  }),
  purchase_needs: createBusinessDomainDefinition({
    label: "Besoins achats",
    recordType: "purchase_need",
    allowedAgents: ["director", "purchasing"],
    essentialFields: ["id", "supplierId", "linkedOrderId", "status", "neededAt", "source", "metadata"]
  }),
  suppliers: createBusinessDomainDefinition({
    label: "Fournisseurs",
    recordType: "supplier",
    allowedAgents: ["director", "purchasing"],
    essentialFields: ["id", "name", "status", "createdAt", "updatedAt", "source", "metadata"]
  }),
  after_sales_tickets: createBusinessDomainDefinition({
    label: "Tickets SAV",
    recordType: "after_sales_ticket",
    allowedAgents: ["director", "after_sales"],
    essentialFields: ["id", "customerId", "orderId", "status", "openedAt", "source", "metadata"]
  })
});

export class BusinessMemoryError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "BusinessMemoryError";
    this.code = code;
    this.details = details;
  }
}

export function createBusinessRecord({
  id,
  domain,
  recordType,
  status = "draft",
  source = BUSINESS_DATA_SOURCES.DEMO_MOCK,
  data,
  relations = {},
  dates = {},
  metadata = {}
} = {}) {
  validateDomain(domain);
  requireText(id, "id");
  requireText(recordType, "recordType");

  return Object.freeze({
    id,
    domain,
    recordType,
    status,
    source: normalizeBusinessDataSource(source),
    data: freezeClone(data ?? {}),
    relations: freezeClone(relations),
    dates: freezeClone(dates),
    metadata: freezeClone(metadata)
  });
}

export function validateBusinessDomainAccess({ domain, agentId }) {
  const definition = validateDomain(domain);
  if (!definition.allowedAgents.includes(agentId)) {
    throw new BusinessMemoryError(`Agent cannot access business domain: ${domain}`, "BUSINESS_DOMAIN_ACCESS_DENIED", {
      domain,
      agentId
    });
  }
  return true;
}

export function validateDomain(domain) {
  const definition = BUSINESS_DOMAIN_DEFINITIONS[domain];
  if (!definition) {
    throw new BusinessMemoryError(`Unknown business domain: ${domain}`, "UNKNOWN_BUSINESS_DOMAIN", {
      domain
    });
  }
  return definition;
}

function createBusinessDomainDefinition({
  label,
  recordType,
  allowedAgents,
  essentialFields
}) {
  return Object.freeze({
    label,
    recordType,
    allowedAgents: Object.freeze([...allowedAgents]),
    essentialFields: Object.freeze([...essentialFields])
  });
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BusinessMemoryError(`${field} must be a non-empty string.`, "INVALID_BUSINESS_RECORD", {
      field
    });
  }
}

function freezeClone(value) {
  return Object.freeze(structuredClone(value));
}
