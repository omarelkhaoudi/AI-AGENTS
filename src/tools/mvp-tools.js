import { createMockToolAdapter } from "./adapters/mock-adapter.js";
import { ToolAdapterError } from "./adapters/contract.js";
import { createToolDefinition, createToolInputSchema } from "./contract.js";
import { ToolRegistry } from "./registry.js";
import { toolSecurityDomains } from "../security/tool-domains.js";
import { BusinessMemoryError } from "../business-memory/domain-contract.js";
import { createBusinessMemoryRepository } from "../business-memory/repository-factory.js";
import {
  BUSINESS_DATA_PROVIDERS,
  BUSINESS_DATA_SOURCES,
  createBusinessDataSourceDescriptor
} from "../business-memory/source.js";
import {
  DEMO_NOTICE,
  createCompanyOverview,
  getAfterSalesOverview,
  getCommunityOverview,
  getDelayedProductionOrders,
  getHrOverview,
  getLegalOverview,
  getMarketingOverview,
  getPendingPayments,
  getPendingQuotes,
  getPurchaseNeeds,
  getCustomerOverview,
  getCustomerOrders,
  getOverdueInvoices,
  getSupplierCatalog
} from "../demo/company-data.js";

const baseInputSchema = createToolInputSchema({
  required: ["requestId"],
  properties: {
    requestId: { type: "string" }
  }
});

export function createMvpTools({ businessMemory = createBusinessMemoryRepository() } = {}) {
  return Object.freeze([
    createMvpMockTool({
      id: "get_company_overview",
      name: "Get Company Overview",
      description: "Returns a mocked overview of company operating signals for MVP demonstrations.",
      category: "overview",
      requiredPermission: "read_analyze",
      allowedAgents: ["director", "finance"],
      resolveItems: createCompanyOverview
    }),
    createMvpMockTool({
      id: "get_pending_payments",
      name: "Get Pending Payments",
      description: "Returns mocked pending payment items for MVP demonstrations.",
      category: "finance",
      requiredPermission: "read_analyze",
      allowedAgents: ["finance"],
      businessMemory,
      domain: "payments",
      resolveItems: getPendingPayments
    }),
    createMvpMockTool({
      id: "get_pending_quotes",
      name: "Get Pending Quotes",
      description: "Returns mocked quote follow-up items for MVP demonstrations.",
      category: "commercial",
      requiredPermission: "read_analyze",
      allowedAgents: ["commercial"],
      businessMemory,
      domain: "quotes",
      resolveItems: getPendingQuotes
    }),
    createMvpMockTool({
      id: "get_delayed_production_orders",
      name: "Get Delayed Production Orders",
      description: "Returns mocked delayed production order items for MVP demonstrations.",
      category: "production",
      requiredPermission: "read_analyze",
      allowedAgents: ["production"],
      businessMemory,
      domain: "production",
      resolveItems: getDelayedProductionOrders
    }),
    createMvpMockTool({
      id: "get_purchase_needs",
      name: "Get Purchase Needs",
      description: "Returns mocked purchasing need items for MVP demonstrations.",
      category: "purchasing",
      requiredPermission: "read_analyze",
      allowedAgents: ["purchasing"],
      businessMemory,
      domain: "purchase_needs",
      resolveItems: getPurchaseNeeds
    }),
    createMvpMockTool({
      id: "get_hr_overview",
      name: "Get HR Overview",
      description: "Returns mocked HR administration and workforce signals for MVP demonstrations. It never exposes real personal data.",
      category: "hr",
      requiredPermission: "read_analyze",
      allowedAgents: ["hr"],
      businessMemory,
      domain: "hr_demo_overview",
      resolveItems: getHrOverview
    }),
    createMvpMockTool({
      id: "get_after_sales_overview",
      name: "Get After Sales Overview",
      description: "Returns mocked after-sales and quality issue items for MVP demonstrations.",
      category: "after_sales",
      requiredPermission: "read_analyze",
      allowedAgents: ["after_sales"],
      businessMemory,
      domain: "after_sales_tickets",
      resolveItems: getAfterSalesOverview
    }),
    createMvpMockTool({
      id: "get_marketing_overview",
      name: "Get Marketing Overview",
      description: "Returns mocked marketing campaign and content signals for MVP demonstrations.",
      category: "marketing",
      requiredPermission: "read_analyze",
      allowedAgents: ["marketing"],
      resolveItems: getMarketingOverview
    }),
    createMvpMockTool({
      id: "get_community_overview",
      name: "Get Community Overview",
      description: "Returns mocked community management and editorial signals for MVP demonstrations.",
      category: "community",
      requiredPermission: "read_analyze",
      allowedAgents: ["community_manager"],
      resolveItems: getCommunityOverview
    }),
    createMvpMockTool({
      id: "get_legal_overview",
      name: "Get Legal Overview",
      description: "Returns mocked legal document and contract attention items for MVP demonstrations.",
      category: "legal",
      requiredPermission: "read_analyze",
      allowedAgents: ["legal"],
      resolveItems: getLegalOverview
    }),
    createMvpMockTool({
      id: "get_customer_overview",
      name: "Get Customer Overview",
      description: "Returns the demo customer base with pipeline stage and outstanding balance for commercial and finance follow-up.",
      category: "customers",
      requiredPermission: "read_analyze",
      allowedAgents: ["commercial", "finance"],
      businessMemory,
      domain: "customers",
      resolveItems: getCustomerOverview
    }),
    createMvpMockTool({
      id: "get_customer_orders",
      name: "Get Customer Orders",
      description: "Returns demo customer orders with status and risk for commercial follow-up and production planning.",
      category: "orders",
      requiredPermission: "read_analyze",
      allowedAgents: ["commercial", "production"],
      businessMemory,
      domain: "orders",
      resolveItems: getCustomerOrders
    }),
    createMvpMockTool({
      id: "get_overdue_invoices",
      name: "Get Overdue Invoices",
      description: "Returns demo invoices that are still owed, each flagged against its own due date. No amount is aggregated here.",
      category: "finance",
      requiredPermission: "read_analyze",
      allowedAgents: ["finance"],
      businessMemory,
      domain: "invoices",
      resolveItems: getOverdueInvoices
    }),
    createMvpMockTool({
      id: "get_supplier_catalog",
      name: "Get Supplier Catalog",
      description: "Returns the demo supplier list with lead times for purchasing follow-up.",
      category: "purchasing",
      requiredPermission: "read_analyze",
      allowedAgents: ["purchasing"],
      businessMemory,
      domain: "suppliers",
      resolveItems: getSupplierCatalog
    })
  ]);
}

export function createMvpToolRegistry({ repository = null, businessMemory = createBusinessMemoryRepository() } = {}) {
  const registry = new ToolRegistry({ repository });
  for (const tool of createMvpTools({ businessMemory })) {
    registry.register(tool);
  }
  registry.register(createSensitiveInvoicePaymentTool());
  registry.register(createSensitiveHrDecisionTool());
  registry.register(createSensitiveLegalDecisionTool());
  return registry;
}

function createDemoResult(context, items, descriptor = createBusinessDataSourceDescriptor({
  provider: BUSINESS_DATA_PROVIDERS.DEMO
})) {
  return Object.freeze({
    demo: descriptor.demo === true,
    dataSource: descriptor.recordSource,
    sourceProvider: descriptor.provider,
    sourceId: descriptor.sourceId,
    notice: DEMO_NOTICE,
    context,
    items
  });
}

function createSensitiveInvoicePaymentTool() {
  return createMvpMockTool({
    id: "execute_invoice_payment",
    name: "Execute Invoice Payment",
    description: "Prepares a mocked sensitive invoice payment action for human approval. It never performs a real payment.",
    category: "finance",
    requiredPermission: "execute_action",
    allowedAgents: ["finance"],
    resolveItems: () => [
      Object.freeze({
        id: "demo-payment-action",
        status: "prepared_only",
        demo: true,
        requiresDecision: true,
        decision: "Human approval is required before any payment execution."
      })
    ]
  });
}

function createSensitiveHrDecisionTool() {
  return createMvpMockTool({
    id: "prepare_hr_sensitive_decision",
    name: "Prepare HR Sensitive Decision",
    description: "Prepares a mocked HR sensitive decision for human approval. It never performs a real HR decision.",
    category: "hr",
    requiredPermission: "prepare_action",
    allowedAgents: ["hr"],
    resolveItems: () => [
      Object.freeze({
        id: "demo-hr-sensitive-decision",
        status: "prepared_only",
        demo: true,
        requiresDecision: true,
        decision: "Human approval is required before any recruitment, sanction, dismissal, contract change, or sensitive HR decision."
      })
    ]
  });
}

function createSensitiveLegalDecisionTool() {
  return createMvpMockTool({
    id: "prepare_legal_sensitive_decision",
    name: "Prepare Legal Sensitive Decision",
    description: "Prepares a mocked legal sensitive decision for human approval. It never signs, validates, or engages the company.",
    category: "legal",
    requiredPermission: "prepare_action",
    allowedAgents: ["legal"],
    resolveItems: () => [
      Object.freeze({
        id: "demo-legal-sensitive-decision",
        status: "prepared_only",
        demo: true,
        requiresDecision: true,
        decision: "Human approval is required before any signature, legal validation, or contractual commitment."
      })
    ]
  });
}

function createMvpMockTool({
  id,
  name,
  description,
  category,
  requiredPermission,
  allowedAgents,
  businessMemory = null,
  domain = null,
  resolveItems
}) {
  return createToolDefinition({
    id,
    name,
    description,
    category,
    securityDomains: toolSecurityDomains(id),
    requiredPermission,
    allowedAgents,
    inputSchema: baseInputSchema,
    adapter: createMockToolAdapter({
      toolId: id,
      inputSchema: baseInputSchema,
      metadata: {
        category,
        dataSource: getBusinessDataSourceDescriptor(businessMemory).recordSource
      },
      resolve: async (context) => {
        const descriptor = getBusinessDataSourceDescriptor(businessMemory);
        return createDemoResult(context, await resolveDemoItems({
          businessMemory,
          domain,
          context,
          resolveItems,
          descriptor
        }), descriptor);
      }
    })
  });
}

async function resolveDemoItems({ businessMemory, domain, context, resolveItems, descriptor }) {
  if (!businessMemory || !domain) {
    return resolveItems();
  }

  const records = await readBusinessRecordsForTool({
    businessMemory,
    domain,
    agentId: context.agentId,
    source: descriptor.recordSource
  });
  return resolveItems(createDemoDataSlice(domain, records.map((record) => record.data)));
}

export async function readBusinessRecordsForTool({
  businessMemory,
  domain,
  agentId,
  source,
  filters = null
} = {}) {
  assertBusinessMemoryReadContract(businessMemory);

  try {
    return await businessMemory.listBusinessRecords({
      domain,
      agentId,
      source,
      filters
    });
  } catch (cause) {
    if (cause instanceof BusinessMemoryError && cause.code === "BUSINESS_DOMAIN_ACCESS_DENIED") {
      throw new ToolAdapterError("Business memory access denied for this tool.", "BUSINESS_MEMORY_ACCESS_DENIED", {
        domain,
        agentId,
        causeCode: cause.code
      });
    }

    throw new ToolAdapterError("Business memory read failed for this tool.", "BUSINESS_MEMORY_READ_FAILED", {
      domain,
      agentId,
      causeCode: cause?.code ?? "UNKNOWN"
    });
  }
}

export function assertBusinessMemoryReadContract(businessMemory) {
  const missing = ["listBusinessRecords"].filter((method) => typeof businessMemory?.[method] !== "function");
  if (missing.length > 0) {
    throw new ToolAdapterError("Business memory read contract is not available for this tool.", "BUSINESS_MEMORY_CONTRACT_INVALID", {
      missing
    });
  }
  return true;
}

function getBusinessDataSourceDescriptor(businessMemory) {
  return businessMemory?.getBusinessDataSource?.() ?? createBusinessDataSourceDescriptor({
    provider: BUSINESS_DATA_PROVIDERS.DEMO,
    sourceId: BUSINESS_DATA_SOURCES.DEMO_MOCK
  });
}

function createDemoDataSlice(domain, items) {
  return {
    payments: domain === "payments" ? items : [],
    quotes: domain === "quotes" ? items : [],
    production: domain === "production" ? items : [],
    purchaseNeeds: domain === "purchase_needs" ? items : [],
    hr: domain === "hr_demo_overview" ? items : [],
    afterSales: domain === "after_sales_tickets" ? items : [],
    customers: domain === "customers" ? items : [],
    orders: domain === "orders" ? items : [],
    invoices: domain === "invoices" ? items : [],
    suppliers: domain === "suppliers" ? items : []
  };
}
