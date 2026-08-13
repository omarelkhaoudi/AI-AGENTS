import { createToolDefinition, createToolInputSchema } from "./contract.js";
import { ToolRegistry } from "./registry.js";

const DEMO_NOTICE = "Demonstration data only. This is not real company data.";

const baseInputSchema = createToolInputSchema({
  required: ["requestId"],
  properties: {
    requestId: { type: "string" }
  }
});

export function createMvpTools() {
  return Object.freeze([
    createToolDefinition({
      id: "get_company_overview",
      name: "Get Company Overview",
      description: "Returns a mocked overview of company operating signals for MVP demonstrations.",
      category: "overview",
      requiredPermission: "read_analyze",
      allowedAgents: ["director", "finance"],
      inputSchema: baseInputSchema,
      execute: async (context) => createDemoResult(context, [
        { label: "Cash collection attention", status: "watch" },
        { label: "Commercial follow-ups", status: "watch" },
        { label: "Production delays", status: "watch" },
        { label: "Purchase needs", status: "watch" }
      ])
    }),
    createToolDefinition({
      id: "get_pending_payments",
      name: "Get Pending Payments",
      description: "Returns mocked pending payment items for MVP demonstrations.",
      category: "finance",
      requiredPermission: "read_analyze",
      allowedAgents: ["finance"],
      inputSchema: baseInputSchema,
      execute: async (context) => createDemoResult(context, [
        { customer: "Demo Client A", amount: 12000, currency: "MAD", due: "this_week" },
        { customer: "Demo Client B", amount: 8500, currency: "MAD", due: "this_week" }
      ])
    }),
    createToolDefinition({
      id: "get_pending_quotes",
      name: "Get Pending Quotes",
      description: "Returns mocked quote follow-up items for MVP demonstrations.",
      category: "commercial",
      requiredPermission: "read_analyze",
      allowedAgents: ["commercial"],
      inputSchema: baseInputSchema,
      execute: async (context) => createDemoResult(context, [
        { customer: "Demo Prospect A", quoteAgeDays: 6, priority: "high" },
        { customer: "Demo Prospect B", quoteAgeDays: 3, priority: "medium" }
      ])
    }),
    createToolDefinition({
      id: "get_delayed_production_orders",
      name: "Get Delayed Production Orders",
      description: "Returns mocked delayed production order items for MVP demonstrations.",
      category: "production",
      requiredPermission: "read_analyze",
      allowedAgents: ["production"],
      inputSchema: baseInputSchema,
      execute: async (context) => createDemoResult(context, [
        { order: "DEMO-PO-001", delayRisk: "high", reason: "Mock material delay" },
        { order: "DEMO-PO-002", delayRisk: "medium", reason: "Mock capacity conflict" }
      ])
    }),
    createToolDefinition({
      id: "get_purchase_needs",
      name: "Get Purchase Needs",
      description: "Returns mocked purchasing need items for MVP demonstrations.",
      category: "purchasing",
      requiredPermission: "read_analyze",
      allowedAgents: ["purchasing"],
      inputSchema: baseInputSchema,
      execute: async (context) => createDemoResult(context, [
        { item: "Demo Raw Material A", urgency: "high", suggestedAction: "prepare_purchase_request" },
        { item: "Demo Packaging B", urgency: "medium", suggestedAction: "review_stock" }
      ])
    })
  ]);
}

export function createMvpToolRegistry({ repository = null } = {}) {
  const registry = new ToolRegistry({ repository });
  for (const tool of createMvpTools()) {
    registry.register(tool);
  }
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
