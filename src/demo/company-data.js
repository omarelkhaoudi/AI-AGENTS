export const DEMO_NOTICE = "Demonstration data only. This is not real company data.";

// The demo data set used to carry absolute dates anchored on a fixed
// operating date, and production lateness was measured against that date
// rather than against the clock. A real order whose deadline had passed was
// therefore reported as on time, because it was compared to 2026-08-13.
//
// Dates are now offsets from the day the set is built: the demo keeps the
// same shape whenever it runs, and real data is measured against the real
// clock instead of inheriting a date that belongs to a fixture.
// referenceDate is the day the offsets are counted from. It defaults to the
// clock, so every existing caller keeps the behaviour it had. It exists so a
// fixture can build the set on a chosen day without waiting for the calendar:
// a test asserting that no date is frozen to a fixture cannot itself depend on
// which day it runs. The reference is copied rather than read in place, because
// a caller's Date must not come back with its hours cleared.
export function demoDate(offsetDays, referenceDate = new Date()) {
  const day = new Date(referenceDate);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() + offsetDays);
  return day.toISOString().slice(0, 10);
}

// The reference reaches the whole set through demoDay, so the offsets below stay
// readable as the business facts they are. It builds the demo set and nothing
// else: no business computation takes its reference from here.
export function createDemoCompanyData({ referenceDate = new Date() } = {}) {
  const demoDay = (offsetDays) => demoDate(offsetDays, referenceDate);

  return Object.freeze({
    company: Object.freeze({
      id: "demo-company",
      name: "Demo Manufacturing Company",
      operatingDate: demoDay(0),
      currency: "MAD"
    }),
    customers: Object.freeze([
      Object.freeze({
        id: "customer-atlas",
        name: "Demo Client Atlas",
        segment: "manufacturing",
        pipelineStage: "deposit_follow_up",
        lastContactAt: demoDay(-6),
        history: ["quote accepted", "deposit invoice issued", "production started"],
        outstandingBalance: 12000,
        currency: "MAD"
      }),
      Object.freeze({
        id: "customer-nova",
        name: "Demo Client Nova",
        segment: "retail",
        pipelineStage: "balance_collection",
        lastContactAt: demoDay(-1),
        history: ["order scheduled", "balance invoice issued"],
        outstandingBalance: 8500,
        currency: "MAD"
      })
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
        pipelineStage: "deposit_pending",
        followUpReason: "deposit_not_received",
        noResponseDays: 8,
        depositRequired: true,
        depositPaymentId: "payment-atlas-deposit",
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
        pipelineStage: "customer_reply_pending",
        followUpReason: "quote_without_reply",
        noResponseDays: 5,
        depositRequired: false,
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
        issuedAt: demoDay(-3),
        dueAt: demoDay(-2),
        linkedPaymentId: "payment-atlas-deposit"
      }),
      Object.freeze({
        id: "invoice-nova-balance",
        customerId: "customer-nova",
        orderId: "order-nova-002",
        status: "issued",
        amount: 8500,
        currency: "MAD",
        issuedAt: demoDay(-1),
        dueAt: demoDay(0),
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
        expectedPaymentDate: demoDay(-2),
        dueStatus: "overdue",
        receivable: true,
        daysLate: 2,
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
        expectedPaymentDate: demoDay(0),
        dueStatus: "due_today",
        receivable: true,
        daysLate: 0,
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
        commercialAttention: true,
        attentionReason: "deposit and material dependency",
        missingMaterialId: "material-aluminum-a",
        due: demoDay(3)
      }),
      Object.freeze({
        id: "order-nova-002",
        customerId: "customer-nova",
        status: "scheduled",
        risk: "medium",
        delayRisk: "medium",
        commercialAttention: true,
        attentionReason: "capacity conflict could affect delivery promise",
        due: demoDay(6)
      })
    ]),
    production: Object.freeze([
      Object.freeze({
        orderId: "order-atlas-001",
        status: "blocked",
        classification: "IN_DANGER",
        plannedStep: "material_cutting",
        responsible: "demo-production-lead",
        plannedDate: demoDay(1),
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
        classification: "AT_RISK",
        plannedStep: "assembly",
        responsible: "demo-workshop-lead",
        plannedDate: demoDay(5),
        timing: "a surveiller",
        delayRisk: "medium",
        reason: "Demo capacity conflict"
      }),
      Object.freeze({
        orderId: "order-sample-003",
        status: "on_time",
        classification: "ON_TIME",
        plannedStep: "quality_check",
        responsible: "demo-quality-lead",
        plannedDate: demoDay(7),
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
        stockOnHand: 4,
        missingQuantity: 20,
        unitPrice: 320,
        currency: "MAD",
        availability: "available_express",
        supplierLeadTimeDays: 2,
        supplierOrderStatus: "to_prepare",
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
        stockOnHand: 30,
        missingQuantity: 90,
        unitPrice: 12,
        currency: "MAD",
        availability: "available_standard",
        supplierLeadTimeDays: 5,
        supplierOrderStatus: "to_review",
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
        recordType: "employee_attendance",
        employeeId: "employee-demo-001",
        departmentId: "production",
        label: "Demo attendance review",
        status: "watch",
        priority: "medium",
        observedAt: demoDay(5),
        absentToday: false,
        presentToday: true,
        administrativeTask: "verify_weekly_attendance",
        headcountConcern: false,
        requiresDecision: false
      }),
      Object.freeze({
        id: "hr-leave-demo-001",
        category: "leave",
        recordType: "leave_request",
        employeeId: "employee-demo-002",
        departmentId: "production",
        label: "Demo overlapping leave request",
        status: "attention_required",
        priority: "high",
        observedAt: demoDay(5),
        plannedAt: demoDay(8),
        leaveType: "annual_leave",
        absenceType: "planned_leave",
        coverageRisk: "high",
        requiresDecision: true,
        decision: "Review staffing coverage before approving the demo leave request."
      }),
      Object.freeze({
        id: "hr-recruitment-demo-001",
        category: "recruitment",
        recordType: "recruitment_need",
        recruitmentId: "recruitment-production-operator",
        label: "Demo production staffing need",
        status: "open",
        priority: "medium",
        observedAt: demoDay(5),
        linkedDepartment: "production",
        neededRole: "Production operator",
        staffingNeed: true,
        headcountConcern: true,
        requiresDecision: false
      }),
      Object.freeze({
        id: "hr-contract-demo-001",
        category: "contract",
        recordType: "hr_contract_document",
        employeeId: "employee-demo-003",
        departmentId: "administration",
        label: "Demo HR contract document follow-up",
        status: "watch",
        priority: "medium",
        observedAt: demoDay(5),
        dueAt: demoDay(15),
        documentStatus: "draft_review",
        requiresDecision: false
      }),
      Object.freeze({
        id: "hr-incident-demo-001",
        category: "incident",
        recordType: "hr_incident",
        employeeId: "employee-demo-004",
        departmentId: "workshop",
        label: "Demo HR incident follow-up",
        status: "attention_required",
        priority: "high",
        observedAt: demoDay(5),
        incidentType: "workplace_follow_up",
        evaluationRequired: true,
        requiresDecision: true,
        decision: "Human validation is required before any HR sanction or sensitive decision."
      })
    ]),
    afterSales: Object.freeze([
      Object.freeze({
        id: "case-sav-001",
        customerId: "customer-atlas",
        orderId: "order-atlas-001",
        caseType: "quality_claim",
        warrantyStatus: "under_warranty",
        interventionStatus: "waiting_internal",
        appointmentAt: demoDay(6),
        responsible: "demo-after-sales-lead",
        openedAt: demoDay(-5),
        dueAt: demoDay(-1),
        daysOpen: 5,
        overdue: true,
        urgency: "high",
        priority: "HIGH",
        status: "OPEN",
        satisfactionScore: 2,
        satisfactionLevel: "low",
        topic: "Demo customer quality claim linked to delivery timing",
        requiresDecision: true,
        decision: "Decide whether commercial should proactively contact Demo Client Atlas."
      }),
      Object.freeze({
        id: "case-sav-002",
        customerId: "customer-nova",
        orderId: "order-nova-002",
        caseType: "warranty_follow_up",
        warrantyStatus: "under_warranty",
        interventionStatus: "waiting_customer",
        appointmentAt: demoDay(9),
        responsible: "demo-support-agent",
        openedAt: demoDay(-2),
        dueAt: demoDay(5),
        daysOpen: 2,
        overdue: false,
        urgency: "medium",
        priority: "MEDIUM",
        status: "WAITING_CUSTOMER",
        satisfactionScore: 4,
        satisfactionLevel: "watch",
        topic: "Demo warranty follow-up"
      }),
      Object.freeze({
        id: "case-sav-003",
        customerId: "customer-atlas",
        orderId: "order-atlas-001",
        caseType: "intervention",
        warrantyStatus: "out_of_warranty",
        interventionStatus: "in_progress",
        appointmentAt: demoDay(5),
        responsible: "demo-quality-technician",
        openedAt: demoDay(-6),
        dueAt: demoDay(1),
        daysOpen: 6,
        overdue: false,
        urgency: "critical",
        priority: "CRITICAL",
        status: "IN_PROGRESS",
        satisfactionScore: 3,
        satisfactionLevel: "medium",
        topic: "Demo urgent intervention after delivery issue",
        requiresDecision: true,
        decision: "Confirm internal intervention priority before promising resolution."
      })
    ]),
    marketing: Object.freeze([
      Object.freeze({
        id: "campaign-q3-packaging",
        campaign: "Demo Q3 Packaging Campaign",
        status: "active",
        objective: "Increase qualified packaging leads",
        channel: "LinkedIn",
        editorialSlot: "week_33",
        performance: "watch",
        performanceScore: 62,
        opportunity: "Align campaign message with delayed Atlas order risk before publication",
        suggestedAction: "review_message",
        linkedCommunityTaskId: "community-post-q3",
        requiresDecision: true,
        decision: "Validate campaign message before community publication."
      }),
      Object.freeze({
        id: "content-plan-demo",
        campaign: "Demo Content Plan",
        status: "active",
        objective: "Prepare weekly editorial calendar",
        channel: "Blog and social",
        editorialSlot: "week_33",
        performance: "ok",
        performanceScore: 84,
        opportunity: "Reuse best-performing product education content",
        suggestedAction: "prepare_next_post"
      })
    ]),
    community: Object.freeze([
      Object.freeze({
        id: "community-post-q3",
        channel: "Demo LinkedIn Page",
        contentType: "post",
        publicationStatus: "draft",
        scheduledFor: demoDay(6),
        captionDraft: "Demo caption draft for Q3 packaging campaign.",
        engagementScore: 78,
        messagesAwaitingReply: 2,
        commentsAwaitingReply: 1,
        urgency: "high",
        suggestedAction: "prepare_public_reply",
        linkedMarketingId: "campaign-q3-packaging",
        requiresDecision: true,
        decision: "Approve public wording prepared by Community Manager."
      }),
      Object.freeze({
        id: "community-calendar",
        channel: "Demo Editorial Calendar",
        contentType: "calendar",
        publicationStatus: "scheduled",
        scheduledFor: demoDay(8),
        captionDraft: "Demo weekly content reminder.",
        engagementScore: 65,
        messagesAwaitingReply: 1,
        commentsAwaitingReply: 0,
        urgency: "medium",
        suggestedAction: "review_scheduled_content"
      })
    ]),
    legal: Object.freeze([
      Object.freeze({
        id: "legal-contract-atlas",
        subject: "Demo Contract Renewal for Client Atlas",
        contractId: "contract-atlas-renewal",
        documentType: "contract",
        customerId: "customer-atlas",
        contractStatus: "renewal_pending",
        deadline: demoDay(12),
        clause: "delivery commitment and penalty clause",
        commercialTerms: "deposit required before schedule confirmation",
        legalCaseStatus: "open",
        riskLevel: "high",
        urgency: "high",
        status: "attention_required",
        suggestedAction: "prepare_legal_review",
        requiresDecision: true,
        decision: "Review renewal clause before confirming delivery commitments."
      }),
      Object.freeze({
        id: "legal-compliance-check",
        subject: "Demo Compliance Check",
        contractId: "contract-compliance-demo",
        documentType: "compliance_note",
        contractStatus: "review_pending",
        deadline: demoDay(17),
        clause: "standard compliance review",
        commercialTerms: "no binding commitment prepared",
        legalCaseStatus: "watch",
        riskLevel: "medium",
        urgency: "medium",
        status: "watch",
        suggestedAction: "review_document_status"
      })
    ]),
    // Lot 2B.2 synthetic reference data. Quantities are chosen so the material
    // shortage derived from a bill of material minus stock reproduces exactly
    // the pre-existing purchaseNeeds figures: 24 - 4 = 20 and 120 - 30 = 90.
    // The price list the datasheet reads. Four entries chosen so the demo set
    // carries the three ways a quote must refuse to be prepared rather than one
    // happy path: MAT-ALU-A has no price at all, and MAT-PACK-B has two that are
    // both in force, a standard tariff and a revision nobody closed.
    prices: Object.freeze([
      Object.freeze({
        id: "price-atlas-panel",
        productId: "product-atlas-panel",
        productReference: "PRD-ATLAS-PANEL",
        amount: 4200,
        currency: "MAD",
        unit: "unit",
        status: "active",
        validFrom: demoDay(-30)
      }),
      Object.freeze({
        id: "price-nova-frame",
        productId: "product-nova-frame",
        productReference: "PRD-NOVA-FRAME",
        amount: 2750,
        currency: "MAD",
        unit: "unit",
        status: "active",
        validFrom: demoDay(-30)
      }),
      Object.freeze({
        id: "price-packaging-b-standard",
        productId: "material-packaging-b",
        productReference: "MAT-PACK-B",
        amount: 18,
        currency: "MAD",
        unit: "units",
        status: "active",
        validFrom: demoDay(-60)
      }),
      Object.freeze({
        id: "price-packaging-b-revised",
        productId: "material-packaging-b",
        productReference: "MAT-PACK-B",
        amount: 21,
        currency: "MAD",
        unit: "units",
        status: "active",
        validFrom: demoDay(-10)
      })
    ]),
    products: Object.freeze([
      Object.freeze({
        id: "product-atlas-panel",
        name: "Demo Atlas Panel",
        reference: "PRD-ATLAS-PANEL",
        category: "finished_good",
        // A file reference, never a byte. The picture lives outside the business
        // memory; what is stored is where to find it.
        imageRef: "demo/products/prd-atlas-panel.jpg",
        unit: "unit",
        status: "active"
      }),
      Object.freeze({
        id: "product-nova-frame",
        name: "Demo Nova Frame",
        reference: "PRD-NOVA-FRAME",
        category: "finished_good",
        imageRef: "demo/products/prd-nova-frame.jpg",
        unit: "unit",
        status: "active"
      }),
      Object.freeze({
        id: "material-aluminum-a",
        name: "Demo Aluminum Sheet A",
        reference: "MAT-ALU-A",
        category: "raw_material",
        unit: "sheets",
        status: "active"
      }),
      Object.freeze({
        id: "material-packaging-b",
        name: "Demo Packaging B",
        reference: "MAT-PACK-B",
        category: "packaging",
        unit: "units",
        status: "active"
      })
    ]),
    stock: Object.freeze([
      Object.freeze({
        id: "stock-aluminum-a",
        productId: "material-aluminum-a",
        supplierId: "supplier-metal-one",
        quantity: 4,
        unit: "sheets",
        status: "available",
        countedAt: demoDay(0)
      }),
      Object.freeze({
        id: "stock-packaging-b",
        productId: "material-packaging-b",
        supplierId: "supplier-pack-two",
        quantity: 30,
        unit: "units",
        status: "available",
        countedAt: demoDay(0)
      })
    ]),
    // Lines stay inside the record data, matching how the repository already
    // persists them. The BillOfMaterialLine table remains unused.
    billsOfMaterial: Object.freeze([
      Object.freeze({
        id: "bom-atlas-001",
        productId: "product-atlas-panel",
        orderId: "order-atlas-001",
        status: "active",
        validFrom: demoDay(-12),
        lines: Object.freeze([
          Object.freeze({
            lineId: "bom-atlas-001-line-1",
            productId: "material-aluminum-a",
            quantity: 24,
            unit: "sheets"
          })
        ])
      }),
      Object.freeze({
        id: "bom-nova-002",
        productId: "product-nova-frame",
        orderId: "order-nova-002",
        status: "active",
        validFrom: demoDay(-12),
        lines: Object.freeze([
          Object.freeze({
            lineId: "bom-nova-002-line-1",
            productId: "material-packaging-b",
            quantity: 120,
            unit: "units"
          })
        ])
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
  return data.afterSales.filter((entry) => ["OPEN", "IN_PROGRESS", "WAITING_CUSTOMER", "WAITING_INTERNAL", "open"].includes(entry.status));
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

// Lot 2B.1 read accessors. They expose demo records that were already modelled
// but had no tool, and add no new data.

export function getCustomerOverview(data = createDemoCompanyData()) {
  return data.customers;
}

// CDC section 29 lists orders among the fifteen things its question must answer,
// beside revenue and beside sales. The figure is the order book and nothing else:
// how many orders are registered, and in which state.
//
// No amount, no currency, no total. An order carries none, in the schema, in the
// ingestion or in the demo set, so any valued figure here would be invented.
//
// It counts data.orders, never the production records. The workshop holds one
// file more than the book, and calling that a third order would report a
// commitment nobody registered. That gap is named by the schedule below.
//
// It returns no item, and that is the point. Section A ENCAISSER taught this at
// Lot 6: a tool that feeds a heading with records another tool already reports
// lists the same signal twice, and the deduplication cannot see it because the
// identity of a signal includes its domain. A figure belongs beside the ten
// headings, never inside one. get_customer_orders keeps listing the orders for
// whoever asks for them directly.
export function createOrderBookSummary(data = createDemoCompanyData()) {
  const orders = data.orders ?? [];
  const countsByStatus = {};
  for (const order of orders) {
    const status = order.status ?? "unknown";
    countsByStatus[status] = (countsByStatus[status] ?? 0) + 1;
  }

  return {
    items: [],
    summary: Object.freeze({
      countsByStatus: Object.freeze(countsByStatus),
      counts: Object.freeze({
        orders: orders.length,
        fromQuote: orders.filter((order) => order.quoteId).length
      })
    })
  };
}

// Finds a product by the reference a person reads on a datasheet, and reports
// the prices in force for it. It knows products and prices and nothing about
// where they are stored, so it can be exercised without a repository.
//
// It never completes what it does not find. A quote built on an invented price
// is worse than no quote: it looks finished. So the three ways the data can
// fail to answer are reported as issues rather than filled in.
export function createProductDatasheet({ products = [], prices = [] } = {}, input = {}) {
  const reference = typeof input.productReference === "string" ? input.productReference.trim() : "";
  if (reference === "") {
    return createDatasheetResult({ reference: null, issues: ["missing_product_reference"] });
  }

  const product = products.find((candidate) => candidate.reference === reference);
  if (!product) {
    return createDatasheetResult({ reference, issues: ["unknown_product_reference"] });
  }

  const inForce = prices.filter((price) => price.productId === product.id && price.status === "active");
  const issues = [];
  if (inForce.length === 0) {
    issues.push("no_price_for_product");
  }
  // Two tariffs in force is not a choice to make on the reader's behalf. Both
  // are reported and the quote refuses, because picking one would state a
  // decision nobody took.
  if (inForce.length > 1) {
    issues.push("several_prices_in_force");
  }

  return createDatasheetResult({
    reference,
    datasheet: product,
    prices: inForce,
    issues
  });
}

function createDatasheetResult({ reference = null, datasheet = null, prices = [], issues = [] }) {
  return Object.freeze({
    reference,
    datasheet: datasheet ? Object.freeze({ ...datasheet }) : null,
    prices: Object.freeze(prices.map((price) => Object.freeze({ ...price }))),
    issues: Object.freeze([...issues])
  });
}

// Prepares a quote from what the datasheet actually says. The three blocks are
// kept apart on purpose: what came from the product, what came from the price
// list, and what the caller asked for. A reader can tell where every value came
// from, and nothing is merged into a figure whose origin is lost.
//
// No total. Quantity times price belongs to none of the three sources, and this
// lot adds only what was explicitly asked for: the customer and the quantity.
//
// The result is a proposal, never a stored quote: status is pending_approval and
// nothing is written to the quotes domain. The tool requires prepare_action, so
// ToolExecutionService will not run it without a human decision either way.
export function prepareQuoteFromDatasheet(data = {}, input = {}) {
  const sheet = createProductDatasheet(data, input);
  const quantity = Number(input.quantity);
  const customerId = typeof input.customerId === "string" ? input.customerId.trim() : "";

  const issues = [...sheet.issues];
  // Number(null) is 0 and Number("") is 0, so absence is checked before the
  // conversion is trusted. A quantity of zero is not a quantity either.
  if (!Number.isFinite(quantity) || quantity <= 0) {
    issues.push("missing_quantity");
  }
  if (customerId === "") {
    issues.push("missing_customer");
  }

  if (issues.length > 0) {
    // A refusal carries no amount at all. Reporting a price beside a refusal
    // would let it be read as the price of the quote that was refused.
    return Object.freeze({
      status: "refused",
      reference: sheet.reference,
      issues: Object.freeze([...issues])
    });
  }

  return Object.freeze({
    status: "pending_approval",
    fromDatasheet: Object.freeze({ ...sheet.datasheet }),
    fromPriceList: Object.freeze({ ...sheet.prices[0] }),
    fromRequest: Object.freeze({ customerId, quantity }),
    issues: Object.freeze([])
  });
}

export function getCustomerOrders(data = createDemoCompanyData()) {
  return data.orders;
}

// An invoice is settled when it is paid or cancelled; anything else is still
// owed. Overdue is a due-date comparison, kept per record: no aggregate is
// computed here.
export function isInvoiceSettled(invoice) {
  return ["paid", "settled", "cancelled"].includes(invoice?.status);
}

export function isInvoiceOverdue(invoice, referenceDate = new Date()) {
  if (isInvoiceSettled(invoice) || typeof invoice?.dueAt !== "string") {
    return false;
  }

  const dueAt = Date.parse(invoice.dueAt);
  return Number.isNaN(dueAt) ? false : dueAt < referenceDate.getTime();
}

export function getOverdueInvoices(data = createDemoCompanyData(), referenceDate = new Date()) {
  return data.invoices
    .filter((invoice) => !isInvoiceSettled(invoice))
    .map((invoice) => Object.freeze({
      ...invoice,
      overdue: isInvoiceOverdue(invoice, referenceDate)
    }));
}

export function getSupplierCatalog(data = createDemoCompanyData()) {
  return data.suppliers;
}

// --- Lot 2B.2 computations -------------------------------------------------

const SETTLED_PAYMENT_STATUSES = Object.freeze(["received", "paid", "settled", "cancelled"]);

export function isPaymentSettled(payment) {
  return SETTLED_PAYMENT_STATUSES.includes(payment?.status);
}

// Payments carry an expected date, invoices a due date. Receivables are read
// through one accessor so both are treated the same way.
function receivableDueDate(record) {
  return record?.dueAt ?? record?.expectedPaymentDate ?? null;
}

export function isReceivableOverdue(record, referenceDate = new Date()) {
  const dueDate = receivableDueDate(record);
  if (typeof dueDate !== "string") {
    return false;
  }

  const due = Date.parse(dueDate);
  return Number.isNaN(due) ? false : due < referenceDate.getTime();
}

function currencyKey(record) {
  return typeof record?.currency === "string" && record.currency.trim().length > 0
    ? record.currency
    : "unknown";
}

function normalizeReceivable(record, receivableKind, referenceDate) {
  return Object.freeze({
    ...record,
    receivableKind,
    dueDate: receivableDueDate(record),
    overdue: isReceivableOverdue(record, referenceDate)
  });
}

// CDC section 5: the list AND the expected amount. Amounts are never summed
// across currencies, and nothing that cannot be summed is silently dropped.
export function createReceivablesSummary(
  { payments = [], invoices = [] } = {},
  referenceDate = new Date()
) {
  const outstandingPayments = payments.filter((payment) => !isPaymentSettled(payment));
  const outstandingInvoices = invoices.filter((invoice) => !isInvoiceSettled(invoice));

  // A payment that settles an invoice already carries that amount. Counting the
  // invoice as well would double the expected cash.
  const coveredInvoiceIds = new Set(
    outstandingPayments.map((payment) => payment?.invoiceId).filter((id) => typeof id === "string")
  );
  const deduplicatedInvoiceIds = outstandingInvoices
    .filter((invoice) => coveredInvoiceIds.has(invoice.id))
    .map((invoice) => invoice.id);
  const keptInvoices = outstandingInvoices.filter((invoice) => !coveredInvoiceIds.has(invoice.id));

  const items = [
    ...outstandingPayments.map((payment) => normalizeReceivable(payment, "payment", referenceDate)),
    ...keptInvoices.map((invoice) => normalizeReceivable(invoice, "invoice", referenceDate))
  ];

  const totalsByCurrency = {};
  const overdueTotalsByCurrency = {};
  let itemsWithoutAmount = 0;
  let negativeAmountCount = 0;

  for (const item of items) {
    if (!Number.isFinite(item.amount)) {
      itemsWithoutAmount += 1;
      continue;
    }
    if (item.amount < 0) {
      negativeAmountCount += 1;
    }

    const key = currencyKey(item);
    totalsByCurrency[key] = (totalsByCurrency[key] ?? 0) + item.amount;
    if (item.overdue) {
      overdueTotalsByCurrency[key] = (overdueTotalsByCurrency[key] ?? 0) + item.amount;
    }
  }

  return {
    items,
    summary: Object.freeze({
      totalsByCurrency: Object.freeze({ ...totalsByCurrency }),
      overdueTotalsByCurrency: Object.freeze({ ...overdueTotalsByCurrency }),
      counts: Object.freeze({
        receivables: items.length,
        overdue: items.filter((item) => item.overdue).length,
        itemsWithoutAmount,
        negativeAmountCount,
        deduplicatedInvoices: deduplicatedInvoiceIds.length
      }),
      deduplicatedInvoiceIds: Object.freeze([...deduplicatedInvoiceIds])
    })
  };
}

// CDC section 29 lists revenue, collections and receivables as three separate
// figures. Revenue therefore cannot be what was collected, or it would repeat
// the other two: it is what was invoiced, settled or not.
//
// isInvoiceSettled groups paid, settled and cancelled together, which is right
// for a receivable and wrong here: a paid invoice IS revenue, a cancelled one
// never was. Hence a predicate of its own rather than a reuse that would have
// silently understated the total.
const CANCELLED_INVOICE_STATUSES = Object.freeze(["cancelled", "void", "voided"]);

export function isInvoiceCancelled(invoice) {
  return CANCELLED_INVOICE_STATUSES.includes(invoice?.status);
}

// No period filter. No other tool in this project filters by period, and the
// CDC states none, so inventing one would be inventing a business rule. The
// window is instead REPORTED: periodStart and periodEnd are the earliest and
// latest issue dates actually present, so a reader knows exactly what the total
// covers without a threshold anyone had to choose.
export function createRevenueSummary({ invoices = [] } = {}) {
  const items = invoices
    .filter((invoice) => !isInvoiceCancelled(invoice))
    .map((invoice) => Object.freeze({ ...invoice }));
  const cancelledCount = invoices.length - items.length;

  const totalsByCurrency = {};
  const countsByStatus = {};
  const issuedDates = [];
  let itemsWithoutAmount = 0;
  let negativeAmountCount = 0;
  let undatedCount = 0;

  for (const invoice of items) {
    const status = typeof invoice.status === "string" ? invoice.status : "unknown";
    countsByStatus[status] = (countsByStatus[status] ?? 0) + 1;

    const issuedAt = Date.parse(invoice.issuedAt);
    if (Number.isNaN(issuedAt)) {
      undatedCount += 1;
    } else {
      issuedDates.push(issuedAt);
    }

    // Number(null) is 0, so a null amount would have passed for a real zero and
    // been counted as usable data. Absence is checked before conversion.
    const brut = invoice.amount;
    const amount = brut === null || brut === undefined || brut === "" ? Number.NaN : Number(brut);
    if (!Number.isFinite(amount)) {
      // Counted, never guessed: a missing amount is a gap in the data, and a
      // total that quietly skipped it would look complete when it is not.
      itemsWithoutAmount += 1;
      continue;
    }
    if (amount < 0) {
      negativeAmountCount += 1;
    }

    const key = currencyKey(invoice);
    totalsByCurrency[key] = (totalsByCurrency[key] ?? 0) + amount;
  }

  // No items. Section A ENCAISSER collects the items of EVERY finance tool, so
  // returning the invoices here listed the same two business signals twice: once
  // as the payment expected, once as the invoice behind it, with different ids so
  // the existing deduplication could not see they were the same reality.
  //
  // Revenue is a figure, not a list of things to act on. It belongs in the
  // aggregate, which is exactly where CDC section 29 puts it, and nowhere in the
  // ten action headings of section 31.
  return {
    items: [],
    summary: Object.freeze({
      // Currencies are never merged into a single figure: two amounts in two
      // currencies are two amounts, and adding them would invent money.
      totalsByCurrency: Object.freeze({ ...totalsByCurrency }),
      countsByStatus: Object.freeze({ ...countsByStatus }),
      counts: Object.freeze({
        invoices: items.length,
        itemsWithoutAmount,
        negativeAmountCount,
        undatedCount,
        cancelledCount
      }),
      periodStart: issuedDates.length > 0
        ? new Date(Math.min(...issuedDates)).toISOString().slice(0, 10)
        : null,
      periodEnd: issuedDates.length > 0
        ? new Date(Math.max(...issuedDates)).toISOString().slice(0, 10)
        : null
    })
  };
}

export const DEFAULT_QUOTE_FOLLOW_UP_DAYS = 5;

const CLOSED_QUOTE_STATUSES = Object.freeze([
  "accepted",
  "rejected",
  "cancelled",
  "closed",
  "won",
  "lost",
  "expired"
]);

export function isQuoteClosed(quote) {
  return CLOSED_QUOTE_STATUSES.includes(quote?.status);
}

function daysSince(isoDate, referenceDate) {
  const from = Date.parse(isoDate);
  return Number.isNaN(from) ? null : Math.floor((referenceDate.getTime() - from) / 86400000);
}

// CDC section 4: quotes left without a reply for at least the threshold. The
// threshold is inclusive, so a quote sitting exactly N days is already due.
export function isQuoteFollowUpDue(quote, {
  thresholdDays = DEFAULT_QUOTE_FOLLOW_UP_DAYS,
  referenceDate = new Date()
} = {}) {
  if (!quote || isQuoteClosed(quote)) {
    return false;
  }
  if (!Number.isFinite(quote.noResponseDays) || quote.noResponseDays < thresholdDays) {
    return false;
  }

  // lastFollowUpAt is not part of the persisted business model. It is honoured
  // when a caller supplies it, so a quote chased recently is not chased twice.
  if (typeof quote.lastFollowUpAt === "string") {
    const since = daysSince(quote.lastFollowUpAt, referenceDate);
    if (since !== null && since < thresholdDays) {
      return false;
    }
  }

  return true;
}

export function createQuoteFollowUps({ quotes = [] } = {}, options = {}) {
  return quotes.filter((quote) => isQuoteFollowUpDue(quote, options));
}

// --- Lot 2B.2 production schedule (CDC section 6) --------------------------

const COMPLETED_PRODUCTION_STATUSES = Object.freeze([
  "completed",
  "done",
  "delivered",
  "finished",
  "closed"
]);

const STORED_PRODUCTION_CLASSIFICATIONS = Object.freeze(["IN_DANGER", "AT_RISK", "ON_TIME"]);

export const PRODUCTION_CLASSIFICATION_LABELS = Object.freeze({
  LATE: "en retard",
  IN_DANGER: "en danger",
  AT_RISK: "a surveiller",
  ON_TIME: "a l'heure",
  UNKNOWN: "inconnu"
});

// The operating date of the demo set, which is the day it is built. It is a
// convenience for fixtures that want to pin a reference explicitly; it is
// never a default, because a date belonging to a fixture must not decide
// whether a real order is late.
export function demoReferenceDate(data = createDemoCompanyData()) {
  return new Date(data.company.operatingDate);
}

export function isProductionCompleted(record) {
  return COMPLETED_PRODUCTION_STATUSES.includes(record?.status);
}

function parseIsoDate(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// The planned date is the workshop deadline and takes priority. The order due
// date is the commercial commitment and only stands in when no planned date is
// usable, so a missing order never invents a deadline.
export function resolveProductionDueDate(record, orders = []) {
  const order = orders.find((candidate) => candidate?.id === record?.orderId) ?? null;

  if (parseIsoDate(record?.plannedDate) !== null) {
    return { dueDate: record.plannedDate, dueDateSource: "planned_date", orderFound: Boolean(order) };
  }
  if (parseIsoDate(order?.due) !== null) {
    return { dueDate: order.due, dueDateSource: "order_due", orderFound: true };
  }
  return { dueDate: null, dueDateSource: "none", orderFound: Boolean(order) };
}

// LATE is derived, never stored: a deadline passed on work that is not finished.
// It overrides the stored classification. Without a usable deadline the stored
// value is kept untouched.
export function classifyProductionRecord(record, { orders = [], referenceDate = new Date() } = {}) {
  const { dueDate } = resolveProductionDueDate(record, orders);
  const due = parseIsoDate(dueDate);

  if (due !== null && due < referenceDate.getTime() && !isProductionCompleted(record)) {
    return "LATE";
  }

  return STORED_PRODUCTION_CLASSIFICATIONS.includes(record?.classification)
    ? record.classification
    : "UNKNOWN";
}

// The schedule already knows which of its records name an order that does not
// exist: every item carries orderFound. That flag reached the response and no
// heading, because deduplication keeps the first entry for a signal and the
// historical tool reports the same record without the flag. The gap between the
// workshop and the order book was in the payload and invisible in the report.
//
// It is reported as a figure of its own, and the file is named rather than
// counted: a production file with no registered order is something to look at,
// not an order to add. This is the only tool that sees both sides.
export function createProductionScheduleSummary(data = createDemoCompanyData(), options = {}) {
  const items = createProductionSchedule(data, options);
  const withoutOrder = items
    .filter((item) => item.orderFound === false)
    .map((item) => item.orderId);

  return {
    items,
    summary: Object.freeze({
      counts: Object.freeze({
        records: items.length,
        withoutOrder: withoutOrder.length
      }),
      productionWithoutOrder: Object.freeze([...withoutOrder])
    })
  };
}

export function createProductionSchedule(
  { production = [], orders = [] } = {},
  { referenceDate = new Date() } = {}
) {
  return production.map((record) => {
    const due = resolveProductionDueDate(record, orders);
    const classification = classifyProductionRecord(record, { orders, referenceDate });

    return Object.freeze({
      ...record,
      classification,
      timing: PRODUCTION_CLASSIFICATION_LABELS[classification],
      dueDate: due.dueDate,
      dueDateSource: due.dueDateSource,
      orderFound: due.orderFound,
      late: classification === "LATE"
    });
  });
}

// --- Lot 2B.2 material requirements (CDC section 7) -----------------------
// Order -> bill of material -> stock -> shortage. Nothing is pre-computed: the
// shortage is derived, and anything that cannot be derived is reported as an
// anomaly rather than dropped.

const CLOSED_ORDER_STATUSES = Object.freeze(["cancelled", "completed", "delivered", "closed"]);

// Fail closed on purpose: only stock we are sure is available counts. Treating
// reserved stock as usable would stop the workshop, which is worse than
// ordering slightly too much.
const AVAILABLE_STOCK_STATUSES = Object.freeze(["available", "in_stock", "free"]);

export function isOrderClosed(order) {
  return CLOSED_ORDER_STATUSES.includes(order?.status);
}

export function isStockAvailable(stockItem) {
  return AVAILABLE_STOCK_STATUSES.includes(stockItem?.status);
}

function positiveQuantity(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

// An order quantity multiplies every bill of material line. The field is not
// part of the persisted order model, so it defaults to one and is only
// exercised through fixtures.
function orderMultiplier(order) {
  return positiveQuantity(order?.quantity) ?? 1;
}

function findBillOfMaterial(order, billsOfMaterial) {
  return billsOfMaterial.find((bill) => bill?.orderId && bill.orderId === order?.id)
    ?? billsOfMaterial.find((bill) => bill?.productId && bill.productId === order?.productId)
    ?? null;
}

export function summarizeProductStock(productId, stock = []) {
  let available = 0;
  let unavailableQuantity = 0;
  let stockRecordsIgnored = 0;
  let stockKnown = false;
  let supplierId = null;

  for (const item of stock) {
    if (item?.productId !== productId) {
      continue;
    }
    stockKnown = true;
    supplierId = supplierId ?? item.supplierId ?? null;
    const quantity = Number.isFinite(item.quantity) ? Math.max(0, item.quantity) : 0;

    if (isStockAvailable(item)) {
      available += quantity;
    } else {
      unavailableQuantity += quantity;
      stockRecordsIgnored += 1;
    }
  }

  return { available, unavailableQuantity, stockRecordsIgnored, stockKnown, supplierId };
}

export function createMaterialRequirements({
  orders = [],
  billsOfMaterial = [],
  stock = [],
  products = []
} = {}) {
  const items = [];
  const anomalies = [];
  let consideredOrders = 0;
  let unavailableQuantity = 0;
  let stockRecordsIgnored = 0;

  for (const order of orders) {
    if (isOrderClosed(order)) {
      continue;
    }
    consideredOrders += 1;

    const bill = findBillOfMaterial(order, billsOfMaterial);
    if (!bill) {
      anomalies.push(Object.freeze({ reason: "bill_of_material_missing", orderId: order?.id ?? null }));
      continue;
    }

    const lines = Array.isArray(bill.lines) ? bill.lines : [];
    if (lines.length === 0) {
      anomalies.push(Object.freeze({
        reason: "bill_of_material_empty",
        orderId: order?.id ?? null,
        billOfMaterialId: bill.id ?? null
      }));
      continue;
    }

    const multiplier = orderMultiplier(order);
    for (const line of lines) {
      const lineQuantity = positiveQuantity(line?.quantity);
      if (lineQuantity === null) {
        anomalies.push(Object.freeze({
          reason: "invalid_line",
          orderId: order?.id ?? null,
          billOfMaterialId: bill.id ?? null,
          lineId: line?.lineId ?? null
        }));
        continue;
      }

      const required = lineQuantity * multiplier;
      const stockSummary = summarizeProductStock(line.productId, stock);
      const product = products.find((candidate) => candidate?.id === line.productId) ?? null;
      const shortage = Math.max(0, required - stockSummary.available);

      unavailableQuantity += stockSummary.unavailableQuantity;
      stockRecordsIgnored += stockSummary.stockRecordsIgnored;

      items.push(Object.freeze({
        orderId: order?.id ?? null,
        billOfMaterialId: bill.id ?? null,
        lineId: line?.lineId ?? null,
        productId: line.productId ?? null,
        productName: product?.name ?? null,
        productKnown: Boolean(product),
        unit: line.unit ?? product?.unit ?? null,
        required,
        available: stockSummary.available,
        shortage,
        covered: shortage === 0,
        stockKnown: stockSummary.stockKnown,
        supplierId: stockSummary.supplierId
      }));
    }
  }

  return {
    items,
    summary: Object.freeze({
      counts: Object.freeze({
        orders: consideredOrders,
        lines: items.length,
        shortages: items.filter((item) => !item.covered).length,
        covered: items.filter((item) => item.covered).length,
        unavailableQuantity,
        stockRecordsIgnored,
        anomalies: anomalies.length
      }),
      anomalies: Object.freeze([...anomalies])
    })
  };
}
