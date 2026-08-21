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
  "hr_demo_overview",
  "after_sales_tickets",
  "products",
  "prices",
  "stock",
  "bills_of_material",
  "payment_terms"
]);

export const BUSINESS_DOMAIN_ALIASES = Object.freeze({
  purchasing: "purchase_needs",
  after_sales: "after_sales_tickets"
});

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
  hr_demo_overview: createBusinessDomainDefinition({
    label: "Ressources humaines demo",
    recordType: "hr_signal",
    allowedAgents: ["director", "hr"],
    essentialFields: ["id", "category", "status", "observedAt", "source", "metadata"]
  }),
  after_sales_tickets: createBusinessDomainDefinition({
    label: "Tickets SAV",
    recordType: "after_sales_ticket",
    allowedAgents: ["director", "after_sales"],
    essentialFields: ["id", "customerId", "orderId", "status", "openedAt", "source", "metadata"]
  }),
  products: createBusinessDomainDefinition({
    label: "Produits",
    recordType: "product",
    allowedAgents: ["director", "commercial", "production", "purchasing"],
    essentialFields: ["id", "name", "status", "createdAt", "updatedAt", "source", "metadata"]
  }),
  prices: createBusinessDomainDefinition({
    label: "Prix",
    recordType: "price_entry",
    allowedAgents: ["director", "commercial", "finance"],
    essentialFields: ["id", "productId", "status", "validFrom", "validUntil", "source", "metadata"]
  }),
  stock: createBusinessDomainDefinition({
    label: "Stock",
    recordType: "stock_item",
    allowedAgents: ["director", "purchasing", "production"],
    essentialFields: ["id", "productId", "supplierId", "status", "countedAt", "source", "metadata"]
  }),
  bills_of_material: createBusinessDomainDefinition({
    label: "Nomenclatures",
    recordType: "bill_of_material",
    allowedAgents: ["director", "production", "purchasing"],
    essentialFields: ["id", "productId", "orderId", "status", "validFrom", "source", "metadata"]
  }),
  payment_terms: createBusinessDomainDefinition({
    label: "Conditions de paiement",
    recordType: "payment_term",
    allowedAgents: ["director", "finance", "commercial"],
    essentialFields: ["id", "customerId", "status", "source", "metadata"]
  })
});

export const BUSINESS_RECORD_CANONICAL_FIELDS = Object.freeze([
  "id",
  "domain",
  "recordType",
  "status",
  "source",
  "sequence",
  "data",
  "relations",
  "dates",
  "metadata"
]);

export const BUSINESS_DOMAIN_RELATION_FIELDS = Object.freeze({
  customers: Object.freeze([]),
  quotes: Object.freeze(["customerId", "prospectId", "linkedOrderId"]),
  invoices: Object.freeze(["customerId", "quoteId", "orderId"]),
  payments: Object.freeze(["customerId", "invoiceId", "quoteId", "orderId"]),
  orders: Object.freeze(["customerId", "quoteId"]),
  production: Object.freeze(["orderId", "missingMaterialId"]),
  purchase_needs: Object.freeze(["supplierId", "linkedOrderId", "materialId"]),
  suppliers: Object.freeze([]),
  hr_demo_overview: Object.freeze(["employeeId", "departmentId", "recruitmentId"]),
  after_sales_tickets: Object.freeze(["customerId", "orderId"]),
  products: Object.freeze([]),
  prices: Object.freeze(["productId"]),
  stock: Object.freeze(["productId", "supplierId"]),
  bills_of_material: Object.freeze(["productId", "orderId"]),
  payment_terms: Object.freeze(["customerId"])
});

export const BUSINESS_DOMAIN_DATE_FIELDS = Object.freeze({
  customers: Object.freeze(["createdAt", "updatedAt"]),
  quotes: Object.freeze(["issuedAt", "validUntil"]),
  invoices: Object.freeze(["issuedAt", "dueAt"]),
  payments: Object.freeze(["dueAt"]),
  orders: Object.freeze(["dueAt"]),
  production: Object.freeze(["dueAt"]),
  purchase_needs: Object.freeze(["neededAt"]),
  suppliers: Object.freeze(["createdAt", "updatedAt"]),
  hr_demo_overview: Object.freeze(["observedAt", "dueAt"]),
  after_sales_tickets: Object.freeze(["openedAt", "resolvedAt"]),
  products: Object.freeze(["createdAt", "updatedAt"]),
  prices: Object.freeze(["validFrom", "validUntil"]),
  stock: Object.freeze(["countedAt"]),
  bills_of_material: Object.freeze(["validFrom"]),
  payment_terms: Object.freeze([])
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
  sequence = null,
  data,
  relations = {},
  dates = {},
  metadata = {},
  ...extraFields
} = {}) {
  if (Object.keys(extraFields).length > 0) {
    throw new BusinessMemoryError("Business record contains non-canonical top-level fields.", "INVALID_BUSINESS_RECORD", {
      unexpectedFields: Object.keys(extraFields)
    });
  }
  const normalizedDomain = normalizeBusinessDomain(domain);
  const definition = validateDomain(normalizedDomain);
  requireText(id, "id");
  requireText(recordType, "recordType");
  requireText(status, "status");
  validateRecordType({
    record: {
      domain: normalizedDomain,
      recordType
    },
    definition
  });

  return Object.freeze({
    id,
    domain: normalizedDomain,
    recordType,
    status,
    source: normalizeBusinessDataSource(source),
    sequence: normalizeRecordSequence(sequence),
    data: freezeClone(data ?? {}),
    relations: freezeClone(normalizeKnownFields(relations, BUSINESS_DOMAIN_RELATION_FIELDS[normalizedDomain])),
    dates: freezeClone(normalizeKnownFields(dates, BUSINESS_DOMAIN_DATE_FIELDS[normalizedDomain])),
    metadata: freezeClone(metadata)
  });
}

export function assertBusinessRecordContract(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new BusinessMemoryError("Business record must be an object.", "INVALID_BUSINESS_RECORD", {
      field: "record"
    });
  }

  requireText(record.id, "id");
  const definition = validateDomain(record.domain);
  requireText(record.recordType, "recordType");
  requireText(record.status, "status");
  normalizeBusinessDataSource(record.source);
  requireObject(record.data, "data");
  requireObject(record.relations, "relations");
  requireObject(record.dates, "dates");
  requireObject(record.metadata, "metadata");
  validateCanonicalRecordFields(record);
  validateRecordType({ record, definition });
  validateKnownCanonicalFields({
    value: record.relations,
    fields: BUSINESS_DOMAIN_RELATION_FIELDS[normalizeBusinessDomain(record.domain)],
    container: "relations"
  });
  validateKnownCanonicalFields({
    value: record.dates,
    fields: BUSINESS_DOMAIN_DATE_FIELDS[normalizeBusinessDomain(record.domain)],
    container: "dates"
  });
  return true;
}

// Records reach a tool in a defined order, and the Director keeps the first
// occurrence when it deduplicates a section. That rule only means something
// if the order is the same everywhere: the in-memory provider returned
// declaration order while PostgreSQL returned rows sorted by identifier, so
// the same company produced two different reports. The rank is carried by the
// record itself, which is the only thing both providers share.
export function normalizeRecordSequence(sequence) {
  if (sequence === null || sequence === undefined) {
    return null;
  }
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new BusinessMemoryError("Business record sequence must be a non-negative integer or null.", "INVALID_BUSINESS_RECORD", {
      field: "sequence",
      sequence
    });
  }
  return sequence;
}

// A total order, never a partial one: records without a rank still sort
// deterministically by identifier, and a tie on the rank is broken the same
// way. Ranked records always come before unranked ones so that adding a rank
// to part of a domain cannot interleave it unpredictably.
export function compareBusinessRecords(left, right) {
  const leftRank = left?.sequence ?? null;
  const rightRank = right?.sequence ?? null;

  if (leftRank !== rightRank) {
    if (leftRank === null) {
      return 1;
    }
    if (rightRank === null) {
      return -1;
    }
    return leftRank - rightRank;
  }
  return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
}

export function filterBusinessRecords(records, { source = null, filters = null } = {}) {
  const normalizedSource = source === null ? null : normalizeBusinessDataSource(source);
  return Object.freeze(records
    .filter((record) => {
      assertBusinessRecordContract(record);
      return (normalizedSource === null || record.source === normalizedSource) &&
        matchesBusinessRecordFilters(record, filters);
    })
    .sort(compareBusinessRecords));
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
  const normalizedDomain = normalizeBusinessDomain(domain);
  const definition = BUSINESS_DOMAIN_DEFINITIONS[normalizedDomain];
  if (!definition) {
    throw new BusinessMemoryError(`Unknown business domain: ${domain}`, "UNKNOWN_BUSINESS_DOMAIN", {
      domain
    });
  }
  return definition;
}

export function normalizeBusinessDomain(domain) {
  return BUSINESS_DOMAIN_ALIASES[domain] ?? domain;
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

function requireObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BusinessMemoryError(`${field} must be an object.`, "INVALID_BUSINESS_RECORD", {
      field
    });
  }
}

function matchesBusinessRecordFilters(record, filters) {
  if (filters === null || filters === undefined) {
    return true;
  }
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
    throw new BusinessMemoryError("filters must be an object when provided.", "INVALID_BUSINESS_FILTER", {
      filters
    });
  }

  if (filters.status !== undefined && record.status !== filters.status) {
    return false;
  }
  if (filters.ids !== undefined && (!Array.isArray(filters.ids) || !filters.ids.includes(record.id))) {
    return false;
  }
  if (filters.data !== undefined && !matchesShallowObject(record.data, filters.data, "data")) {
    return false;
  }
  if (filters.metadata !== undefined && !matchesShallowObject(record.metadata, filters.metadata, "metadata")) {
    return false;
  }
  return true;
}

function matchesShallowObject(target, expected, field) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new BusinessMemoryError(`${field} filter must be an object.`, "INVALID_BUSINESS_FILTER", {
      field
    });
  }
  return Object.entries(expected).every(([key, value]) => target[key] === value);
}

function validateCanonicalRecordFields(record) {
  const unexpectedFields = Object.keys(record).filter((field) => !BUSINESS_RECORD_CANONICAL_FIELDS.includes(field));
  if (unexpectedFields.length > 0) {
    throw new BusinessMemoryError("Business record contains non-canonical top-level fields.", "INVALID_BUSINESS_RECORD", {
      unexpectedFields
    });
  }
}

function validateRecordType({ record, definition }) {
  if (record.recordType !== definition.recordType) {
    throw new BusinessMemoryError("Business record type does not match its domain.", "INVALID_BUSINESS_RECORD", {
      domain: record.domain,
      expectedRecordType: definition.recordType,
      actualRecordType: record.recordType
    });
  }
}

function validateKnownCanonicalFields({ value, fields, container }) {
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (missing.length > 0) {
    throw new BusinessMemoryError(`Business record ${container} are missing canonical fields.`, "INVALID_BUSINESS_RECORD", {
      container,
      missing
    });
  }
}

function normalizeKnownFields(value, fields = []) {
  const normalized = { ...(value ?? {}) };
  for (const field of fields) {
    if (normalized[field] === undefined) {
      normalized[field] = null;
    }
  }
  return normalized;
}

function freezeClone(value) {
  return Object.freeze(structuredClone(value));
}
