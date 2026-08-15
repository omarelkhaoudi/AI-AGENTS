import { createMockToolAdapter } from "./adapters/mock-adapter.js";
import { createToolDefinition, createToolInputSchema } from "./contract.js";
import { ToolRegistry } from "./registry.js";
import { createBusinessMemoryRepository } from "../business-memory/repository-factory.js";
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
  getPurchaseNeeds
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
    })
  ]);
}

export function createMvpToolRegistry({ repository = null, businessMemory = createBusinessMemoryRepository() } = {}) {
  const registry = new ToolRegistry({ repository });
  for (const tool of createMvpTools({ businessMemory })) {
    registry.register(tool);
  }
  registry.register(createSensitiveInvoicePaymentTool());
  return registry;
}

function createDemoResult(context, items) {
  return Object.freeze({
    demo: true,
    dataSource: "demo_mock",
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
    requiredPermission,
    allowedAgents,
    inputSchema: baseInputSchema,
    adapter: createMockToolAdapter({
      toolId: id,
      inputSchema: baseInputSchema,
      metadata: {
        category,
        dataSource: "demo_mock"
      },
      resolve: async (context) => createDemoResult(context, await resolveDemoItems({
        businessMemory,
        domain,
        context,
        resolveItems
      }))
    })
  });
}

async function resolveDemoItems({ businessMemory, domain, context, resolveItems }) {
  if (!businessMemory || !domain) {
    return resolveItems();
  }

  const records = await businessMemory.listBusinessRecords({
    domain,
    agentId: context.agentId,
    source: "demo_mock"
  });
  return resolveItems(createDemoDataSlice(domain, records.map((record) => record.data)));
}

function createDemoDataSlice(domain, items) {
  return {
    payments: domain === "payments" ? items : [],
    quotes: domain === "quotes" ? items : [],
    production: domain === "production" ? items : [],
    purchaseNeeds: domain === "purchase_needs" ? items : [],
    afterSales: domain === "after_sales_tickets" ? items : []
  };
}
