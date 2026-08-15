export const DEMO_NOTICE = "Demonstration data only. This is not real company data.";

export function createDemoCompanyData() {
  return Object.freeze({
    company: Object.freeze({
      id: "demo-company",
      name: "Demo Manufacturing Company",
      operatingDate: "2026-08-13",
      currency: "MAD"
    }),
    customers: Object.freeze([
      Object.freeze({ id: "customer-atlas", name: "Demo Client Atlas", segment: "manufacturing" }),
      Object.freeze({ id: "customer-nova", name: "Demo Client Nova", segment: "retail" })
    ]),
    prospects: Object.freeze([
      Object.freeze({ id: "prospect-solar", name: "Demo Prospect Solar", opportunity: "Packaging line" })
    ]),
    quotes: Object.freeze([
      Object.freeze({
        id: "quote-atlas-001",
        customerId: "customer-atlas",
        status: "accepted_pending_deposit",
        ageDays: 8,
        priority: "high",
        linkedOrderId: "order-atlas-001",
        requiresDecision: true,
        decision: "Confirm deposit follow-up before production deadline."
      }),
      Object.freeze({
        id: "quote-solar-002",
        prospectId: "prospect-solar",
        status: "pending_customer_reply",
        ageDays: 5,
        priority: "medium",
        opportunity: "Demo upsell opportunity"
      })
    ]),
    invoices: Object.freeze([
      Object.freeze({
        id: "invoice-atlas-deposit",
        customerId: "customer-atlas",
        quoteId: "quote-atlas-001",
        orderId: "order-atlas-001",
        status: "issued",
        amount: 12000,
        currency: "MAD",
        issuedAt: "2026-08-10",
        dueAt: "2026-08-16",
        linkedPaymentId: "payment-atlas-deposit"
      }),
      Object.freeze({
        id: "invoice-nova-balance",
        customerId: "customer-nova",
        orderId: "order-nova-002",
        status: "issued",
        amount: 8500,
        currency: "MAD",
        issuedAt: "2026-08-12",
        dueAt: "2026-08-18",
        linkedPaymentId: "payment-nova-balance"
      })
    ]),
    payments: Object.freeze([
      Object.freeze({
        id: "payment-atlas-deposit",
        customerId: "customer-atlas",
        invoiceId: "invoice-atlas-deposit",
        quoteId: "quote-atlas-001",
        orderId: "order-atlas-001",
        type: "deposit",
        amount: 12000,
        currency: "MAD",
        due: "this_week",
        status: "expected",
        priority: "high",
        requiresDecision: true,
        decision: "Validate whether the order can continue if the deposit is delayed."
      }),
      Object.freeze({
        id: "payment-nova-balance",
        customerId: "customer-nova",
        invoiceId: "invoice-nova-balance",
        type: "balance",
        amount: 8500,
        currency: "MAD",
        due: "this_week",
        status: "expected",
        priority: "medium"
      })
    ]),
    orders: Object.freeze([
      Object.freeze({
        id: "order-atlas-001",
        customerId: "customer-atlas",
        quoteId: "quote-atlas-001",
        status: "in_production",
        risk: "high",
        delayRisk: "high",
        missingMaterialId: "material-aluminum-a",
        due: "2026-08-16"
      }),
      Object.freeze({
        id: "order-nova-002",
        customerId: "customer-nova",
        status: "scheduled",
        risk: "medium",
        delayRisk: "medium",
        due: "2026-08-19"
      })
    ]),
    production: Object.freeze([
      Object.freeze({
        orderId: "order-atlas-001",
        status: "blocked",
        timing: "en danger",
        delayRisk: "high",
        reason: "Demo missing aluminum material",
        missingMaterialId: "material-aluminum-a",
        requiresDecision: true,
        decision: "Choose between express supplier purchase or revised delivery date."
      }),
      Object.freeze({
        orderId: "order-nova-002",
        status: "watch",
        timing: "a surveiller",
        delayRisk: "medium",
        reason: "Demo capacity conflict"
      }),
      Object.freeze({
        orderId: "order-sample-003",
        status: "on_time",
        timing: "a l'heure",
        delayRisk: "low",
        reason: "Demo order progressing normally"
      })
    ]),
    purchaseNeeds: Object.freeze([
      Object.freeze({
        id: "purchase-aluminum-a",
        materialId: "material-aluminum-a",
        item: "Demo Aluminum Sheet A",
        quantity: 24,
        unit: "sheets",
        linkedOrderId: "order-atlas-001",
        supplierId: "supplier-metal-one",
        supplierName: "Demo Supplier Metal One",
        urgency: "high",
        suggestedAction: "prepare_purchase_request",
        requiresDecision: true,
        decision: "Approve urgent purchase preparation for Demo Aluminum Sheet A."
      }),
      Object.freeze({
        id: "purchase-packaging-b",
        item: "Demo Packaging B",
        quantity: 120,
        unit: "units",
        supplierId: "supplier-pack-two",
        supplierName: "Demo Supplier Pack Two",
        urgency: "medium",
        suggestedAction: "review_stock"
      })
    ]),
    suppliers: Object.freeze([
      Object.freeze({ id: "supplier-metal-one", name: "Demo Supplier Metal One", leadTimeDays: 2 }),
      Object.freeze({ id: "supplier-pack-two", name: "Demo Supplier Pack Two", leadTimeDays: 5 })
    ]),
    hr: Object.freeze([
      Object.freeze({
        id: "hr-presence-demo-001",
        category: "attendance",
        label: "Demo attendance review",
        status: "watch",
        priority: "medium",
        headcountConcern: false,
        requiresDecision: false
      }),
      Object.freeze({
        id: "hr-leave-demo-001",
        category: "leave",
        label: "Demo overlapping leave request",
        status: "attention_required",
        priority: "high",
        requiresDecision: true,
        decision: "Review staffing coverage before approving the demo leave request."
      }),
      Object.freeze({
        id: "hr-recruitment-demo-001",
        category: "recruitment",
        label: "Demo production staffing need",
        status: "open",
        priority: "medium",
        linkedDepartment: "production",
        requiresDecision: false
      }),
      Object.freeze({
        id: "hr-contract-demo-001",
        category: "contract",
        label: "Demo HR contract document follow-up",
        status: "watch",
        priority: "medium",
        requiresDecision: false
      })
    ]),
    afterSales: Object.freeze([
      Object.freeze({
        id: "case-sav-001",
        customerId: "customer-atlas",
        orderId: "order-atlas-001",
        urgency: "high",
        priority: "high",
        status: "open",
        topic: "Demo customer quality claim linked to delivery timing",
        requiresDecision: true,
        decision: "Decide whether commercial should proactively contact Demo Client Atlas."
      }),
      Object.freeze({
        id: "case-sav-002",
        customerId: "customer-nova",
        urgency: "medium",
        priority: "medium",
        status: "open",
        topic: "Demo warranty follow-up"
      })
    ]),
    marketing: Object.freeze([
      Object.freeze({
        id: "campaign-q3-packaging",
        campaign: "Demo Q3 Packaging Campaign",
        performance: "watch",
        suggestedAction: "review_message",
        linkedCommunityTaskId: "community-post-q3",
        requiresDecision: true,
        decision: "Validate campaign message before community publication."
      }),
      Object.freeze({
        id: "content-plan-demo",
        campaign: "Demo Content Plan",
        performance: "ok",
        suggestedAction: "prepare_next_post"
      })
    ]),
    community: Object.freeze([
      Object.freeze({
        id: "community-post-q3",
        channel: "Demo LinkedIn Page",
        urgency: "high",
        suggestedAction: "prepare_public_reply",
        linkedMarketingId: "campaign-q3-packaging",
        requiresDecision: true,
        decision: "Approve public wording prepared by Community Manager."
      }),
      Object.freeze({
        id: "community-calendar",
        channel: "Demo Editorial Calendar",
        urgency: "medium",
        suggestedAction: "review_scheduled_content"
      })
    ]),
    legal: Object.freeze([
      Object.freeze({
        id: "legal-contract-atlas",
        subject: "Demo Contract Renewal for Client Atlas",
        customerId: "customer-atlas",
        urgency: "high",
        status: "attention_required",
        suggestedAction: "prepare_legal_review",
        requiresDecision: true,
        decision: "Review renewal clause before confirming delivery commitments."
      }),
      Object.freeze({
        id: "legal-compliance-check",
        subject: "Demo Compliance Check",
        urgency: "medium",
        status: "watch",
        suggestedAction: "review_document_status"
      })
    ])
  });
}

export function createCompanyOverview(data = createDemoCompanyData()) {
  return Object.freeze([
    Object.freeze({ label: "Cash collection attention", status: "watch", linkedPaymentId: "payment-atlas-deposit" }),
    Object.freeze({ label: "Commercial follow-ups", status: "watch", linkedQuoteId: "quote-atlas-001" }),
    Object.freeze({ label: "Production delay risk", status: "high", linkedOrderId: "order-atlas-001" }),
    Object.freeze({ label: "Urgent purchase need", status: "high", linkedPurchaseNeedId: "purchase-aluminum-a" }),
    Object.freeze({ label: "Open after-sales case", status: "high", linkedCaseId: "case-sav-001" }),
    Object.freeze({ label: "Legal attention", status: "high", linkedLegalId: "legal-contract-atlas" })
  ].map((item) => Object.freeze({
    ...item,
    companyId: data.company.id,
    requiresDecision: item.status === "high"
  })));
}

export function getPendingPayments(data = createDemoCompanyData()) {
  return data.payments.filter((payment) => payment.status === "expected");
}

export function getPendingQuotes(data = createDemoCompanyData()) {
  return data.quotes.filter((quote) => quote.status.includes("pending"));
}

export function getDelayedProductionOrders(data = createDemoCompanyData()) {
  return data.production;
}

export function getPurchaseNeeds(data = createDemoCompanyData()) {
  return data.purchaseNeeds.filter((need) => ["high", "medium"].includes(need.urgency));
}

export function getHrOverview(data = createDemoCompanyData()) {
  return data.hr;
}

export function getAfterSalesOverview(data = createDemoCompanyData()) {
  return data.afterSales.filter((entry) => entry.status === "open");
}

export function getMarketingOverview(data = createDemoCompanyData()) {
  return data.marketing;
}

export function getCommunityOverview(data = createDemoCompanyData()) {
  return data.community;
}

export function getLegalOverview(data = createDemoCompanyData()) {
  return data.legal;
}
