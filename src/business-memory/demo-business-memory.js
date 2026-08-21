import { createDemoCompanyData } from "../demo/company-data.js";
import { createBusinessRecord } from "./domain-contract.js";
import { InMemoryBusinessMemoryRepository } from "./in-memory-business-memory.js";
import { BUSINESS_DATA_SOURCES } from "./source.js";

export function createDemoBusinessMemoryRepository(data = createDemoCompanyData()) {
  return new InMemoryBusinessMemoryRepository({
    records: createDemoBusinessRecords(data)
  });
}

// Declaration order is the order a reader expects, so it becomes the rank
// the record carries. Numbering restarts per domain: the rank orders a
// domain, it is not a global position.
export function createDemoBusinessRecords(data = createDemoCompanyData()) {
  return rankByDomain([
    ...data.customers.map((customer) => createBusinessRecord({
      id: customer.id,
      domain: "customers",
      recordType: "customer",
      status: customer.status ?? "active",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: customer,
      dates: {
        createdAt: customer.createdAt ?? data.company.operatingDate,
        updatedAt: customer.updatedAt ?? data.company.operatingDate
      },
      metadata: { companyId: data.company.id, draft: true }
    })),
    ...data.quotes.map((quote) => createBusinessRecord({
      id: quote.id,
      domain: "quotes",
      recordType: "quote",
      status: quote.status,
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: quote,
      relations: {
        customerId: quote.customerId ?? null,
        prospectId: quote.prospectId ?? null,
        linkedOrderId: quote.linkedOrderId ?? null
      },
      dates: {
        issuedAt: quote.issuedAt ?? data.company.operatingDate,
        validUntil: quote.validUntil ?? null
      },
      metadata: { companyId: data.company.id, draft: true }
    })),
    ...data.invoices.map((invoice) => createBusinessRecord({
      id: invoice.id,
      domain: "invoices",
      recordType: "invoice",
      status: invoice.status,
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: invoice,
      relations: {
        customerId: invoice.customerId ?? null,
        quoteId: invoice.quoteId ?? null,
        orderId: invoice.orderId ?? null
      },
      dates: {
        issuedAt: invoice.issuedAt ?? null,
        dueAt: invoice.dueAt ?? null
      },
      metadata: { companyId: data.company.id, draft: true }
    })),
    ...data.payments.map((payment) => createBusinessRecord({
      id: payment.id,
      domain: "payments",
      recordType: "payment",
      status: payment.status,
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: payment,
      relations: {
        customerId: payment.customerId ?? null,
        invoiceId: payment.invoiceId ?? null,
        quoteId: payment.quoteId ?? null,
        orderId: payment.orderId ?? null
      },
      dates: {
        dueAt: payment.dueAt ?? payment.due ?? null
      },
      metadata: { companyId: data.company.id, draft: true }
    })),
    ...data.orders.map((order) => createBusinessRecord({
      id: order.id,
      domain: "orders",
      recordType: "order",
      status: order.status,
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: order,
      relations: {
        customerId: order.customerId ?? null,
        quoteId: order.quoteId ?? null
      },
      dates: {
        dueAt: order.due ?? null
      },
      metadata: { companyId: data.company.id, draft: true }
    })),
    ...data.production.map((production) => createBusinessRecord({
      id: production.id ?? production.orderId,
      domain: "production",
      recordType: "production_signal",
      status: production.status,
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: production,
      relations: {
        orderId: production.orderId ?? null,
        missingMaterialId: production.missingMaterialId ?? null
      },
      dates: {
        dueAt: production.dueAt ?? findOrderDueDate(data, production.orderId)
      },
      metadata: { companyId: data.company.id, draft: true }
    })),
    ...data.purchaseNeeds.map((need) => createBusinessRecord({
      id: need.id,
      domain: "purchase_needs",
      recordType: "purchase_need",
      status: need.status ?? need.urgency,
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: need,
      relations: {
        supplierId: need.supplierId ?? null,
        linkedOrderId: need.linkedOrderId ?? null,
        materialId: need.materialId ?? null
      },
      dates: {
        neededAt: need.neededAt ?? data.company.operatingDate
      },
      metadata: { companyId: data.company.id, draft: true }
    })),
    ...data.suppliers.map((supplier) => createBusinessRecord({
      id: supplier.id,
      domain: "suppliers",
      recordType: "supplier",
      status: supplier.status ?? "active",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: supplier,
      dates: {
        createdAt: supplier.createdAt ?? data.company.operatingDate,
        updatedAt: supplier.updatedAt ?? data.company.operatingDate
      },
      metadata: { companyId: data.company.id, draft: true }
    })),
    ...data.hr.map((entry) => createBusinessRecord({
      id: entry.id,
      domain: "hr_demo_overview",
      recordType: "hr_signal",
      status: entry.status,
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: entry,
      relations: {
        employeeId: entry.employeeId ?? null,
        departmentId: entry.departmentId ?? entry.linkedDepartment ?? null,
        recruitmentId: entry.recruitmentId ?? null
      },
      dates: {
        observedAt: entry.observedAt ?? data.company.operatingDate,
        dueAt: entry.dueAt ?? entry.plannedAt ?? null
      },
      metadata: { companyId: data.company.id, draft: true, sensitive: true }
    })),
    ...data.afterSales.map((ticket) => createBusinessRecord({
      id: ticket.id,
      domain: "after_sales_tickets",
      recordType: "after_sales_ticket",
      status: ticket.status,
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: ticket,
      relations: {
        customerId: ticket.customerId ?? null,
        orderId: ticket.orderId ?? null
      },
      dates: {
        openedAt: ticket.openedAt ?? data.company.operatingDate,
        resolvedAt: ticket.resolvedAt ?? null
      },
      metadata: { companyId: data.company.id, draft: true }
    })),
    ...data.products.map((product) => createBusinessRecord({
      id: product.id,
      domain: "products",
      recordType: "product",
      status: product.status ?? "active",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: product,
      dates: {
        createdAt: product.createdAt ?? data.company.operatingDate,
        updatedAt: product.updatedAt ?? data.company.operatingDate
      },
      metadata: { companyId: data.company.id, draft: true }
    })),
    ...data.stock.map((item) => createBusinessRecord({
      id: item.id,
      domain: "stock",
      recordType: "stock_item",
      status: item.status ?? "available",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: item,
      relations: {
        productId: item.productId ?? null,
        supplierId: item.supplierId ?? null
      },
      dates: {
        countedAt: item.countedAt ?? data.company.operatingDate
      },
      metadata: { companyId: data.company.id, draft: true }
    })),
    ...data.billsOfMaterial.map((bill) => createBusinessRecord({
      id: bill.id,
      domain: "bills_of_material",
      recordType: "bill_of_material",
      status: bill.status ?? "active",
      source: BUSINESS_DATA_SOURCES.DEMO_MOCK,
      data: bill,
      relations: {
        productId: bill.productId ?? null,
        orderId: bill.orderId ?? null
      },
      dates: {
        validFrom: bill.validFrom ?? data.company.operatingDate
      },
      metadata: { companyId: data.company.id, draft: true }
    }))
  ]);
}

function rankByDomain(records) {
  const nextRank = new Map();
  return Object.freeze(records.map((record) => {
    const rank = nextRank.get(record.domain) ?? 0;
    nextRank.set(record.domain, rank + 1);
    return createBusinessRecord({ ...record, sequence: rank });
  }));
}

function findOrderDueDate(data, orderId) {
  return data.orders.find((order) => order.id === orderId)?.due ?? null;
}
