import {
  BUSINESS_DOMAINS,
  BusinessMemoryError,
  createBusinessRecord,
  filterBusinessRecords,
  normalizeBusinessDomain,
  validateBusinessDomainAccess,
  validateDomain
} from "./domain-contract.js";
import { BUSINESS_DATA_SOURCES, normalizeBusinessDataSource } from "./source.js";

// Exported so the structural registry test can verify that every business
// domain stays wired to a Prisma delegate.
export const DOMAIN_MODEL_MAP = Object.freeze({
  customers: Object.freeze({
    delegate: "customer",
    recordType: "customer",
    toPrisma: customerData
  }),
  quotes: Object.freeze({
    delegate: "quote",
    recordType: "quote",
    toPrisma: quoteData
  }),
  invoices: Object.freeze({
    delegate: "invoice",
    recordType: "invoice",
    toPrisma: invoiceData
  }),
  payments: Object.freeze({
    delegate: "payment",
    recordType: "payment",
    toPrisma: paymentData
  }),
  orders: Object.freeze({
    delegate: "businessOrder",
    recordType: "order",
    toPrisma: orderData
  }),
  production: Object.freeze({
    delegate: "productionRecord",
    recordType: "production_signal",
    toPrisma: productionData
  }),
  purchase_needs: Object.freeze({
    delegate: "purchaseNeed",
    recordType: "purchase_need",
    toPrisma: purchaseNeedData
  }),
  suppliers: Object.freeze({
    delegate: "supplier",
    recordType: "supplier",
    toPrisma: supplierData
  }),
  hr_demo_overview: Object.freeze({
    delegate: "hrSignal",
    recordType: "hr_signal",
    toPrisma: hrSignalData
  }),
  after_sales_tickets: Object.freeze({
    delegate: "afterSalesTicket",
    recordType: "after_sales_ticket",
    toPrisma: afterSalesTicketData
  }),
  products: Object.freeze({
    delegate: "product",
    recordType: "product",
    toPrisma: productData
  }),
  prices: Object.freeze({
    delegate: "priceListEntry",
    recordType: "price_entry",
    toPrisma: priceEntryData
  }),
  stock: Object.freeze({
    delegate: "stockItem",
    recordType: "stock_item",
    toPrisma: stockItemData
  }),
  bills_of_material: Object.freeze({
    delegate: "billOfMaterial",
    recordType: "bill_of_material",
    toPrisma: billOfMaterialData
  }),
  payment_terms: Object.freeze({
    delegate: "paymentTerm",
    recordType: "payment_term",
    toPrisma: paymentTermData
  })
});

export class PrismaBusinessMemoryRepository {
  constructor({ prisma, dataSourceDescriptor = null }) {
    if (!prisma) {
      throw new BusinessMemoryError("PrismaBusinessMemoryRepository requires a PrismaClient.", "PRISMA_REQUIRED");
    }
    this.prisma = prisma;
    this.dataSourceDescriptor = dataSourceDescriptor;
  }

  getBusinessDataSource() {
    return this.dataSourceDescriptor;
  }

  listBusinessDomains() {
    return [...BUSINESS_DOMAINS];
  }

  async saveBusinessRecord(input) {
    const record = createBusinessRecord(input);
    const config = getDomainModelConfig(record.domain);
    const data = config.toPrisma(record);
    const saved = await this.prisma[config.delegate].upsert({
      where: {
        source_businessId: {
          source: record.source,
          businessId: record.id
        }
      },
      create: data,
      update: data
    });
    return toBusinessRecord(record.domain, saved);
  }

  async getBusinessRecord({ domain, id, agentId = "director", source = null, filters = null } = {}) {
    const normalizedDomain = normalizeBusinessDomain(domain);
    validateBusinessDomainAccess({ domain: normalizedDomain, agentId });
    const config = getDomainModelConfig(normalizedDomain);
    const normalizedSource = source === null ? null : normalizeBusinessDataSource(source);
    const saved = normalizedSource
      ? await this.prisma[config.delegate].findUnique({
          where: {
            source_businessId: {
              source: normalizedSource,
              businessId: id
            }
          }
        })
      : await this.prisma[config.delegate].findFirst({
          where: { businessId: id },
          orderBy: { createdAt: "asc" }
        });

    const record = saved ? toBusinessRecord(normalizedDomain, saved) : null;
    return record && filterBusinessRecords([record], { source: null, filters }).length === 1 ? record : null;
  }

  async listBusinessRecords({ domain, agentId = "director", source = BUSINESS_DATA_SOURCES.DEMO_MOCK, filters = null } = {}) {
    const normalizedDomain = normalizeBusinessDomain(domain);
    validateBusinessDomainAccess({ domain: normalizedDomain, agentId });
    const config = getDomainModelConfig(normalizedDomain);
    const records = await this.prisma[config.delegate].findMany({
      where: source === null ? {} : { source: normalizeBusinessDataSource(source) },
      orderBy: { businessId: "asc" }
    });
    return filterBusinessRecords(records.map((record) => toBusinessRecord(normalizedDomain, record)), {
      source: null,
      filters
    });
  }

  async listBusinessRecordsByDomain({ agentId = "director", source = BUSINESS_DATA_SOURCES.DEMO_MOCK, filters = null } = {}) {
    const entries = [];
    for (const domain of BUSINESS_DOMAINS) {
      try {
        entries.push([domain, await this.listBusinessRecords({ domain, agentId, source, filters })]);
      } catch (error) {
        if (error instanceof BusinessMemoryError && error.code === "BUSINESS_DOMAIN_ACCESS_DENIED") {
          entries.push([domain, Object.freeze([])]);
          continue;
        }
        throw error;
      }
    }
    return Object.freeze(Object.fromEntries(entries));
  }
}

export function getDomainModelConfig(domain) {
  const normalizedDomain = normalizeBusinessDomain(domain);
  validateDomain(normalizedDomain);
  return DOMAIN_MODEL_MAP[normalizedDomain];
}

function toBusinessRecord(domain, saved) {
  const config = getDomainModelConfig(domain);
  const { sequence, metadata } = splitStoredMetadata(saved.metadata);
  return createBusinessRecord({
    id: saved.businessId,
    domain,
    recordType: config.recordType,
    status: saved.status,
    source: saved.source,
    sequence,
    data: saved.data,
    relations: createRelations(domain, saved),
    dates: createDates(domain, saved),
    metadata
  });
}

// No column carries the rank, so it travels inside the metadata JSON that
// every business model already has. toBusinessRecord lifts it back to the
// canonical field and removes it from metadata, so a record read from
// PostgreSQL is indistinguishable from the same record held in memory.
const SEQUENCE_METADATA_KEY = "__sequence";

function baseData(record, extra = {}) {
  return {
    businessId: record.id,
    source: record.source,
    status: record.status,
    data: record.data,
    metadata: record.sequence === null
      ? record.metadata
      : { ...record.metadata, [SEQUENCE_METADATA_KEY]: record.sequence },
    ...extra
  };
}

function splitStoredMetadata(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return { sequence: null, metadata: {} };
  }
  const { [SEQUENCE_METADATA_KEY]: sequence, ...metadata } = stored;
  return { sequence: Number.isInteger(sequence) ? sequence : null, metadata };
}

function customerData(record) {
  return baseData(record, {
    name: record.data.name ?? record.id,
    segment: record.data.segment ?? null,
    ...optionalDateField("createdAt", record.dates.createdAt),
    ...optionalDateField("updatedAt", record.dates.updatedAt)
  });
}

function quoteData(record) {
  return baseData(record, {
    customerBusinessId: record.relations.customerId ?? record.data.customerId ?? null,
    prospectId: record.relations.prospectId ?? record.data.prospectId ?? null,
    linkedOrderId: record.relations.linkedOrderId ?? record.data.linkedOrderId ?? null,
    issuedAt: parseDate(record.dates.issuedAt),
    validUntil: parseDate(record.dates.validUntil)
  });
}

function invoiceData(record) {
  return baseData(record, {
    customerBusinessId: record.relations.customerId ?? record.data.customerId ?? null,
    quoteBusinessId: record.relations.quoteId ?? record.data.quoteId ?? null,
    orderBusinessId: record.relations.orderId ?? record.data.orderId ?? null,
    amount: record.data.amount ?? null,
    currency: record.data.currency ?? null,
    issuedAt: parseDate(record.dates.issuedAt),
    dueAt: parseDate(record.dates.dueAt)
  });
}

function paymentData(record) {
  return baseData(record, {
    customerBusinessId: record.relations.customerId ?? record.data.customerId ?? null,
    invoiceBusinessId: record.relations.invoiceId ?? record.data.invoiceId ?? null,
    quoteBusinessId: record.relations.quoteId ?? record.data.quoteId ?? null,
    orderBusinessId: record.relations.orderId ?? record.data.orderId ?? null,
    amount: record.data.amount ?? null,
    currency: record.data.currency ?? null,
    dueAt: parseDate(record.dates.dueAt)
  });
}

function orderData(record) {
  return baseData(record, {
    customerBusinessId: record.relations.customerId ?? record.data.customerId ?? null,
    quoteBusinessId: record.relations.quoteId ?? record.data.quoteId ?? null,
    risk: record.data.risk ?? null,
    dueAt: parseDate(record.dates.dueAt)
  });
}

function productionData(record) {
  return baseData(record, {
    orderBusinessId: record.relations.orderId ?? record.data.orderId ?? null,
    delayRisk: record.data.delayRisk ?? null,
    dueAt: parseDate(record.dates.dueAt)
  });
}

function purchaseNeedData(record) {
  return baseData(record, {
    supplierBusinessId: record.relations.supplierId ?? record.data.supplierId ?? null,
    linkedOrderId: record.relations.linkedOrderId ?? record.data.linkedOrderId ?? null,
    urgency: record.data.urgency ?? null,
    neededAt: parseDate(record.dates.neededAt)
  });
}

function supplierData(record) {
  return baseData(record, {
    name: record.data.name ?? record.id,
    leadTimeDays: record.data.leadTimeDays ?? null,
    ...optionalDateField("createdAt", record.dates.createdAt),
    ...optionalDateField("updatedAt", record.dates.updatedAt)
  });
}

function afterSalesTicketData(record) {
  return baseData(record, {
    customerBusinessId: record.relations.customerId ?? record.data.customerId ?? null,
    orderBusinessId: record.relations.orderId ?? record.data.orderId ?? null,
    priority: record.data.priority ?? record.data.urgency ?? null,
    openedAt: parseDate(record.dates.openedAt),
    resolvedAt: parseDate(record.dates.resolvedAt)
  });
}

function hrSignalData(record) {
  return baseData(record, {
    employeeBusinessId: record.relations.employeeId ?? record.data.employeeId ?? null,
    departmentId: record.relations.departmentId ?? record.data.departmentId ?? record.data.linkedDepartment ?? null,
    recruitmentId: record.relations.recruitmentId ?? record.data.recruitmentId ?? null,
    category: record.data.category ?? null,
    priority: record.data.priority ?? null,
    observedAt: parseDate(record.dates.observedAt),
    dueAt: parseDate(record.dates.dueAt)
  });
}

function productData(record) {
  return baseData(record, {
    name: record.data.name ?? record.id,
    reference: record.data.reference ?? null,
    category: record.data.category ?? null,
    ...optionalDateField("createdAt", record.dates.createdAt),
    ...optionalDateField("updatedAt", record.dates.updatedAt)
  });
}

function priceEntryData(record) {
  return baseData(record, {
    productBusinessId: record.relations.productId ?? record.data.productId ?? null,
    amount: record.data.amount ?? null,
    currency: record.data.currency ?? null,
    validFrom: parseDate(record.dates.validFrom),
    validUntil: parseDate(record.dates.validUntil)
  });
}

function stockItemData(record) {
  return baseData(record, {
    productBusinessId: record.relations.productId ?? record.data.productId ?? null,
    supplierBusinessId: record.relations.supplierId ?? record.data.supplierId ?? null,
    quantity: record.data.quantity ?? null,
    unit: record.data.unit ?? null,
    countedAt: parseDate(record.dates.countedAt)
  });
}

function billOfMaterialData(record) {
  return baseData(record, {
    productBusinessId: record.relations.productId ?? record.data.productId ?? null,
    orderBusinessId: record.relations.orderId ?? record.data.orderId ?? null,
    validFrom: parseDate(record.dates.validFrom)
  });
}

function paymentTermData(record) {
  return baseData(record, {
    customerBusinessId: record.relations.customerId ?? record.data.customerId ?? null,
    netDays: Number.isInteger(record.data.netDays) ? record.data.netDays : null
  });
}

function createRelations(domain, saved) {
  if (domain === "customers" || domain === "suppliers") {
    return {};
  }
  if (domain === "hr_demo_overview") {
    return {
      employeeId: saved.employeeBusinessId ?? null,
      departmentId: saved.departmentId ?? null,
      recruitmentId: saved.recruitmentId ?? null
    };
  }
  if (domain === "quotes") {
    return {
      customerId: saved.customerBusinessId ?? null,
      prospectId: saved.prospectId ?? null,
      linkedOrderId: saved.linkedOrderId ?? null
    };
  }
  if (domain === "invoices") {
    return {
      customerId: saved.customerBusinessId ?? null,
      quoteId: saved.quoteBusinessId ?? null,
      orderId: saved.orderBusinessId ?? null
    };
  }
  if (domain === "payments") {
    return {
      customerId: saved.customerBusinessId ?? null,
      invoiceId: saved.invoiceBusinessId ?? null,
      quoteId: saved.quoteBusinessId ?? null,
      orderId: saved.orderBusinessId ?? null
    };
  }
  if (domain === "orders") {
    return {
      customerId: saved.customerBusinessId ?? null,
      quoteId: saved.quoteBusinessId ?? null
    };
  }
  if (domain === "production") {
    return {
      orderId: saved.orderBusinessId ?? null,
      missingMaterialId: saved.data?.missingMaterialId ?? null
    };
  }
  if (domain === "purchase_needs") {
    return {
      supplierId: saved.supplierBusinessId ?? null,
      linkedOrderId: saved.linkedOrderId ?? null,
      materialId: saved.data?.materialId ?? null
    };
  }
  if (domain === "products") {
    return {};
  }
  if (domain === "prices") {
    return {
      productId: saved.productBusinessId ?? null
    };
  }
  if (domain === "stock") {
    return {
      productId: saved.productBusinessId ?? null,
      supplierId: saved.supplierBusinessId ?? null
    };
  }
  if (domain === "bills_of_material") {
    return {
      productId: saved.productBusinessId ?? null,
      orderId: saved.orderBusinessId ?? null
    };
  }
  if (domain === "payment_terms") {
    return {
      customerId: saved.customerBusinessId ?? null
    };
  }
  return {
    customerId: saved.customerBusinessId ?? null,
    orderId: saved.orderBusinessId ?? null
  };
}

function createDates(domain, saved) {
  const common = {};
  if (domain === "customers" || domain === "suppliers") {
    common.createdAt = formatDate(saved.createdAt);
    common.updatedAt = formatDate(saved.updatedAt);
  }
  if (domain === "quotes") {
    common.issuedAt = formatDate(saved.issuedAt);
    common.validUntil = formatDate(saved.validUntil);
  }
  if (domain === "invoices") {
    common.issuedAt = formatDate(saved.issuedAt);
    common.dueAt = formatDate(saved.dueAt);
  }
  if (domain === "payments") {
    common.dueAt = formatDate(saved.dueAt);
  }
  if (domain === "orders" || domain === "production") {
    common.dueAt = formatDate(saved.dueAt);
  }
  if (domain === "purchase_needs") {
    common.neededAt = formatDate(saved.neededAt);
  }
  if (domain === "hr_demo_overview") {
    common.observedAt = formatDate(saved.observedAt);
    common.dueAt = formatDate(saved.dueAt);
  }
  if (domain === "after_sales_tickets") {
    common.openedAt = formatDate(saved.openedAt);
    common.resolvedAt = formatDate(saved.resolvedAt);
  }
  if (domain === "products") {
    common.createdAt = formatDate(saved.createdAt);
    common.updatedAt = formatDate(saved.updatedAt);
  }
  if (domain === "prices") {
    common.validFrom = formatDate(saved.validFrom);
    common.validUntil = formatDate(saved.validUntil);
  }
  if (domain === "stock") {
    common.countedAt = formatDate(saved.countedAt);
  }
  if (domain === "bills_of_material") {
    common.validFrom = formatDate(saved.validFrom);
  }
  return common;
}

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function optionalDateField(field, value) {
  const parsed = parseDate(value);
  return parsed ? { [field]: parsed } : {};
}

function formatDate(value) {
  if (!value) {
    return null;
  }
  return new Date(value).toISOString().slice(0, 10);
}
