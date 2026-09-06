import { createMockToolAdapter } from "./adapters/mock-adapter.js";
import { createN8nToolAdapter } from "./adapters/n8n-adapter.js";
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
  createOrderBookSummary,
  getCustomerOrders,
  getOverdueInvoices,
  getSupplierCatalog,
  createReceivablesSummary,
  createRevenueSummary,
  createQuoteFollowUps,
  createProductionScheduleSummary,
  createProductDatasheet,
  prepareQuoteFromDatasheet,
  createMaterialRequirements
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
      id: "get_order_book_summary",
      name: "Get Order Book Summary",
      description: "Returns how many demo orders are registered and in which state. It reports no item, because a figure belongs beside the Director headings rather than inside one, and no amount, because an order carries none.",
      category: "orders",
      requiredPermission: "read_analyze",
      allowedAgents: ["commercial"],
      businessMemory,
      domain: "orders",
      resolveItems: createOrderBookSummary
    }),
    createDatasheetTool({
      id: "get_product_datasheet",
      name: "Get Product Datasheet",
      description: "Finds a demo product by the reference printed on its datasheet and reports the prices in force for it. It never completes what it does not find: an unknown reference, a product with no price, and a product with several prices in force are each reported as an issue.",
      requiredPermission: "read_analyze",
      resolveSummary: createProductDatasheet,
      businessMemory
    }),
    createDatasheetTool({
      id: "prepare_quote_from_datasheet",
      name: "Prepare Quote From Datasheet",
      description: "Prepares a quote proposal from a product datasheet and the price in force, keeping what came from the product, from the price list and from the request apart. It stores nothing and requires a human approval. Without a price, or with several in force, it refuses rather than choosing one.",
      requiredPermission: "prepare_action",
      resolveSummary: prepareQuoteFromDatasheet,
      businessMemory
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
    }),
    createMvpMockTool({
      id: "get_receivables_summary",
      name: "Get Receivables Summary",
      description: "Returns outstanding demo receivables with totals per currency. A payment that settles an invoice replaces it, so no amount is counted twice, and totals are never merged across currencies.",
      category: "finance",
      requiredPermission: "read_analyze",
      allowedAgents: ["finance"],
      businessMemory,
      domains: ["payments", "invoices"],
      resolveItems: createReceivablesSummary
    }),
    createMvpMockTool({
      id: "get_revenue_summary",
      name: "Get Revenue Summary",
      description: "Returns demo invoiced revenue with totals per currency. Cancelled invoices are excluded and paid ones are kept, because revenue is what was invoiced rather than what was collected. Totals are never merged across currencies, and the period reported is derived from the issue dates actually present.",
      category: "finance",
      requiredPermission: "read_analyze",
      allowedAgents: ["finance"],
      businessMemory,
      domain: "invoices",
      resolveItems: createRevenueSummary
    }),
    createMvpMockTool({
      id: "get_quote_follow_ups",
      name: "Get Quote Follow Ups",
      description: "Returns demo quotes left without a reply for at least five days and not closed, so commercial follow-up can be prepared.",
      category: "commercial",
      requiredPermission: "read_analyze",
      allowedAgents: ["commercial"],
      businessMemory,
      domains: ["quotes"],
      resolveItems: createQuoteFollowUps
    }),
    createMvpMockTool({
      id: "get_production_schedule",
      name: "Get Production Schedule",
      description: "Returns demo production orders classified as on time, to watch, in danger or late. Lateness is derived from the planned date, falling back to the order due date, and never stored.",
      category: "production",
      requiredPermission: "read_analyze",
      allowedAgents: ["production"],
      businessMemory,
      domains: ["production", "orders"],
      resolveItems: createProductionScheduleSummary
    }),
    createMvpMockTool({
      id: "get_material_requirements",
      name: "Get Material Requirements",
      description: "Derives demo material shortages from open orders, their bill of material and available stock. Only stock explicitly available is counted, and anything that cannot be derived is reported as an anomaly.",
      category: "purchasing",
      requiredPermission: "read_analyze",
      allowedAgents: ["purchasing"],
      businessMemory,
      domains: ["orders", "bills_of_material", "stock", "products"],
      resolveItems: createMaterialRequirements
    })
  ]);
}

export function createMvpToolRegistry({
  repository = null,
  businessMemory = createBusinessMemoryRepository(),
  workflowClient = null
} = {}) {
  const registry = new ToolRegistry({ repository });
  for (const tool of createMvpTools({ businessMemory })) {
    registry.register(tool);
  }
  registry.register(createSensitiveInvoicePaymentTool());
  registry.register(createSensitiveHrDecisionTool());
  registry.register(createSensitiveLegalDecisionTool());

  // The only tool that leaves the company, and the only conditional one. With no
  // client there is nothing to call, so it is left unregistered rather than
  // registered and broken: the default registry stays exactly what it was.
  if (workflowClient) {
    registry.register(createDelayAlertNotificationTool(workflowClient));
  }

  return registry;
}

// The delay_alert workflow declares orderId and delayRisk as its inputs, so the
// tool requires them too. Asking for them here means a missing field is refused
// by the registry, before the adapter builds anything.
const delayAlertInputSchema = createToolInputSchema({
  required: ["requestId", "orderId", "delayRisk"],
  properties: {
    requestId: { type: "string" },
    orderId: { type: "string" },
    delayRisk: { type: "string" }
  }
});

// execute_action, not read_analyze: this sends a message to the outside world.
// The consequence is deliberate. requiresApproval() in ToolExecutionService
// treats every non read_analyze tool as needing a human approval, so no alert
// can leave without one, and an approval cannot be spent twice.
function createDelayAlertNotificationTool(client) {
  const id = "notify_delay_alert";
  return createToolDefinition({
    id,
    name: "Notify Delay Alert",
    description: "Sends a production delay alert to the n8n delay_alert workflow. It leaves the company, so it always requires a human approval.",
    category: "production",
    securityDomains: toolSecurityDomains(id),
    requiredPermission: "execute_action",
    allowedAgents: ["production"],
    inputSchema: delayAlertInputSchema,
    adapter: createN8nToolAdapter({
      toolId: id,
      eventType: "delay_alert",
      inputSchema: delayAlertInputSchema,
      client,
      metadata: { category: "production" }
    })
  });
}

function createDemoResult(context, items, descriptor = createBusinessDataSourceDescriptor({
  provider: BUSINESS_DATA_PROVIDERS.DEMO
}), summary = null) {
  return Object.freeze({
    demo: descriptor.demo === true,
    dataSource: descriptor.recordSource,
    sourceProvider: descriptor.provider,
    sourceId: descriptor.sourceId,
    notice: DEMO_NOTICE,
    context,
    items,
    // Only a computing tool carries a summary; a read tool output keeps its
    // exact previous shape.
    ...(summary ? { summary } : {})
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

// The only tools that take a business input. createMvpMockTool passes none to
// its resolvers, and widening that signature would reach the four resolvers
// that already use their second parameter for a reference date or options:
// receivables and overdue invoices would then measure lateness against a
// request identifier. So these two are built the way notify_delay_alert is,
// with their own schema and their own resolve.
//
// Nothing else is duplicated. The memory read goes through
// readBusinessRecordsForTool, the domains through toolSecurityDomains, and
// ToolExecutionService checks them exactly as it checks the other tools.
const datasheetInputSchema = createToolInputSchema({
  required: ["requestId"],
  properties: {
    requestId: { type: "string" },
    productReference: { type: "string" },
    customerId: { type: "string" },
    quantity: { type: "number" }
  }
});

function createDatasheetTool({ id, name, description, requiredPermission, resolveSummary, businessMemory }) {
  return createToolDefinition({
    id,
    name,
    description,
    category: "orders",
    securityDomains: toolSecurityDomains(id),
    requiredPermission,
    allowedAgents: ["commercial"],
    inputSchema: datasheetInputSchema,
    adapter: createMockToolAdapter({
      toolId: id,
      inputSchema: datasheetInputSchema,
      metadata: {
        category: "orders",
        dataSource: getBusinessDataSourceDescriptor(businessMemory).recordSource
      },
      resolve: async (context, input) => {
        const descriptor = getBusinessDataSourceDescriptor(businessMemory);
        const read = async (domain) => {
          if (!businessMemory) {
            return [];
          }
          const records = await readBusinessRecordsForTool({
            businessMemory,
            domain,
            agentId: context.agentId,
            source: descriptor.recordSource
          });
          return records.map((record) => record.data);
        };
        const data = { products: await read("products"), prices: await read("prices") };
        // No item: a datasheet and a quote proposal are answers to a question,
        // not business signals a Director heading should list.
        return createDemoResult(context, [], descriptor, resolveSummary(data, input));
      }
    })
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
  domains = null,
  resolveItems
}) {
  // A tool reads either one domain or several. Both forms normalise to a list.
  const businessDomains = domains ?? (domain ? [domain] : []);
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
        const resolved = await resolveDemoItems({
          businessMemory,
          domains: businessDomains,
          context,
          resolveItems,
          descriptor
        });
        // A computing tool returns its aggregates alongside the items; a plain
        // read tool keeps returning a bare array and its output is unchanged.
        return Array.isArray(resolved)
          ? createDemoResult(context, resolved, descriptor)
          : createDemoResult(context, resolved.items, descriptor, resolved.summary);
      }
    })
  });
}

async function resolveDemoItems({ businessMemory, domains, context, resolveItems, descriptor }) {
  if (!businessMemory || domains.length === 0) {
    return resolveItems();
  }

  const slice = createEmptyDemoDataSlice();
  for (const domain of domains) {
    const records = await readBusinessRecordsForTool({
      businessMemory,
      domain,
      agentId: context.agentId,
      source: descriptor.recordSource
    });
    const key = DEMO_SLICE_KEY_BY_DOMAIN[domain];
    if (key) {
      slice[key] = records.map((record) => record.data);
    }
  }
  return resolveItems(slice);
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

// Business domain to demo data key. A tool reading several domains fills one
// entry per domain, so the mapping lives in a single place.
const DEMO_SLICE_KEY_BY_DOMAIN = Object.freeze({
  payments: "payments",
  quotes: "quotes",
  production: "production",
  purchase_needs: "purchaseNeeds",
  hr_demo_overview: "hr",
  after_sales_tickets: "afterSales",
  customers: "customers",
  orders: "orders",
  invoices: "invoices",
  suppliers: "suppliers",
  products: "products",
  stock: "stock",
  bills_of_material: "billsOfMaterial"
});

function createEmptyDemoDataSlice() {
  return Object.fromEntries(Object.values(DEMO_SLICE_KEY_BY_DOMAIN).map((key) => [key, []]));
}

function createDemoDataSlice(domain, items) {
  const slice = createEmptyDemoDataSlice();
  const key = DEMO_SLICE_KEY_BY_DOMAIN[domain];
  if (key) {
    slice[key] = items;
  }
  return slice;
}
