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
      Object.freeze({
        id: "customer-atlas",
        name: "Demo Client Atlas",
        segment: "manufacturing",
        pipelineStage: "deposit_follow_up",
        lastContactAt: "2026-08-07",
        history: ["quote accepted", "deposit invoice issued", "production started"],
        outstandingBalance: 12000,
        currency: "MAD"
      }),
      Object.freeze({
        id: "customer-nova",
        name: "Demo Client Nova",
        segment: "retail",
        pipelineStage: "balance_collection",
        lastContactAt: "2026-08-12",
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
        expectedPaymentDate: "2026-08-16",
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
        expectedPaymentDate: "2026-08-18",
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
        due: "2026-08-16"
      }),
      Object.freeze({
        id: "order-nova-002",
        customerId: "customer-nova",
        status: "scheduled",
        risk: "medium",
        delayRisk: "medium",
        commercialAttention: true,
        attentionReason: "capacity conflict could affect delivery promise",
        due: "2026-08-19"
      })
    ]),
    production: Object.freeze([
      Object.freeze({
        orderId: "order-atlas-001",
        status: "blocked",
        classification: "IN_DANGER",
        plannedStep: "material_cutting",
        responsible: "demo-production-lead",
        plannedDate: "2026-08-14",
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
        plannedDate: "2026-08-18",
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
        plannedDate: "2026-08-20",
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
        observedAt: "2026-08-18",
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
        observedAt: "2026-08-18",
        plannedAt: "2026-08-21",
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
        observedAt: "2026-08-18",
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
        observedAt: "2026-08-18",
        dueAt: "2026-08-28",
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
        observedAt: "2026-08-18",
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
        appointmentAt: "2026-08-19",
        responsible: "demo-after-sales-lead",
        openedAt: "2026-08-13",
        dueAt: "2026-08-17",
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
        appointmentAt: "2026-08-22",
        responsible: "demo-support-agent",
        openedAt: "2026-08-16",
        dueAt: "2026-08-23",
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
        appointmentAt: "2026-08-18",
        responsible: "demo-quality-technician",
        openedAt: "2026-08-12",
        dueAt: "2026-08-18",
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
        scheduledFor: "2026-08-19",
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
        scheduledFor: "2026-08-21",
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
        deadline: "2026-08-25",
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
        deadline: "2026-08-30",
        clause: "standard compliance review",
        commercialTerms: "no binding commitment prepared",
        legalCaseStatus: "watch",
        riskLevel: "medium",
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
