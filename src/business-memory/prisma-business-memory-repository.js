import {
  BUSINESS_DOMAINS,
  BusinessMemoryError,
  createBusinessRecord,
  validateBusinessDomainAccess,
  validateDomain
} from "./domain-contract.js";
import { BUSINESS_DATA_SOURCES, normalizeBusinessDataSource } from "./source.js";

const DOMAIN_MODEL_MAP = Object.freeze({
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
  after_sales_tickets: Object.freeze({
    delegate: "afterSalesTicket",
    recordType: "after_sales_ticket",
    toPrisma: afterSalesTicketData
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

  async getBusinessRecord({ domain, id, agentId = "director", source = null } = {}) {
    validateBusinessDomainAccess({ domain, agentId });
    const config = getDomainModelConfig(domain);
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

    return saved ? toBusinessRecord(domain, saved) : null;
  }

  async listBusinessRecords({ domain, agentId = "director", source = BUSINESS_DATA_SOURCES.DEMO_MOCK } = {}) {
    validateBusinessDomainAccess({ domain, agentId });
    const config = getDomainModelConfig(domain);
    const records = await this.prisma[config.delegate].findMany({
      where: { source: normalizeBusinessDataSource(source) },
      orderBy: { businessId: "asc" }
    });
    return Object.freeze(records.map((record) => toBusinessRecord(domain, record)));
  }

  async listBusinessRecordsByDomain({ agentId = "director", source = BUSINESS_DATA_SOURCES.DEMO_MOCK } = {}) {
    const entries = [];
    for (const domain of BUSINESS_DOMAINS) {
      try {
        entries.push([domain, await this.listBusinessRecords({ domain, agentId, source })]);
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

function getDomainModelConfig(domain) {
  validateDomain(domain);
  return DOMAIN_MODEL_MAP[domain];
}

function toBusinessRecord(domain, saved) {
  const config = getDomainModelConfig(domain);
  return createBusinessRecord({
    id: saved.businessId,
    domain,
    recordType: config.recordType,
    status: saved.status,
    source: saved.source,
    data: saved.data,
    relations: createRelations(domain, saved),
    dates: createDates(domain, saved),
    metadata: saved.metadata ?? {}
  });
}

function baseData(record, extra = {}) {
  return {
    businessId: record.id,
    source: record.source,
    status: record.status,
    data: record.data,
    metadata: record.metadata,
    ...extra
  };
}

function customerData(record) {
  return baseData(record, {
    name: record.data.name ?? record.id,
    segment: record.data.segment ?? null
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
    leadTimeDays: record.data.leadTimeDays ?? null
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

function createRelations(domain, saved) {
  if (domain === "customers" || domain === "suppliers") {
    return {};
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
      orderId: saved.orderBusinessId ?? null
    };
  }
  if (domain === "purchase_needs") {
    return {
      supplierId: saved.supplierBusinessId ?? null,
      linkedOrderId: saved.linkedOrderId ?? null
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
  if (domain === "after_sales_tickets") {
    common.openedAt = formatDate(saved.openedAt);
    common.resolvedAt = formatDate(saved.resolvedAt);
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

function formatDate(value) {
  if (!value) {
    return null;
  }
  return new Date(value).toISOString().slice(0, 10);
}
