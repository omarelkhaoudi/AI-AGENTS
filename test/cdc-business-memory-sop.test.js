import assert from "node:assert/strict";
import test from "node:test";
import {
  BUSINESS_DOMAIN_DEFINITIONS,
  BUSINESS_DATA_SOURCES,
  InMemoryRepository,
  InMemorySopRepository,
  buildApi,
  createDemoBusinessMemoryRepository,
  getAgentBusinessConfig
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

const CDC_PRIORITY_COVERAGE = Object.freeze({
  commercial: Object.freeze({
    sopId: "commercial-quote-follow-up-draft",
    domains: ["customers", "quotes"],
    preparableAction: "prepare_action",
    approvalAction: "execute_action"
  }),
  finance: Object.freeze({
    sopId: "finance-receivables-follow-up-draft",
    domains: ["customers", "invoices", "payments"],
    preparableAction: "prepare_action",
    approvalAction: "human_approval_required"
  }),
  production: Object.freeze({
    sopId: "production-delay-follow-up-draft",
    domains: ["orders", "production"],
    preparableAction: "prepare_action",
    approvalAction: "execute_action"
  }),
  purchasing: Object.freeze({
    sopId: "purchasing-needs-identification-draft",
    domains: ["orders", "purchase_needs", "suppliers"],
    preparableAction: "prepare_action",
    approvalAction: "execute_action"
  }),
  after_sales: Object.freeze({
    sopId: "after-sales-claim-resolution-draft",
    domains: ["after_sales_tickets", "customers", "orders"],
    preparableAction: "prepare_action",
    approvalAction: "execute_action"
  }),
  hr: Object.freeze({
    sopId: "hr-administrative-follow-up-draft",
    domains: ["hr_demo_overview"],
    preparableAction: "prepare_action",
    approvalAction: "human_approval_required"
  })
});

test("CDC priority domains align business memory, agent config, and SOP drafts", () => {
  const memory = createDemoBusinessMemoryRepository();
  const sopRepository = new InMemorySopRepository();

  for (const [agentId, expectation] of Object.entries(CDC_PRIORITY_COVERAGE)) {
    const config = getAgentBusinessConfig(agentId);
    const sop = sopRepository.getSop(expectation.sopId, { agentId });

    assert.equal(sop.status, "draft", agentId);
    assert.equal(sop.metadata.confirmedByClient, false, agentId);
    assert.equal(sop.metadata.executesTools, false, agentId);
    assert.equal(config.authorizedActions.includes(expectation.preparableAction), true, agentId);
    assert.equal(config.approvalRequiredActions.includes(expectation.approvalAction), true, agentId);

    for (const domain of expectation.domains) {
      assert.ok(BUSINESS_DOMAIN_DEFINITIONS[domain].allowedAgents.includes(agentId), `${agentId}:${domain}`);
      assert.ok(config.accessibleInformation.includes(domain), `${agentId}:${domain}`);
      assert.ok(sop.relatedDomains.includes(domain), `${agentId}:${domain}`);

      const records = memory.listBusinessRecords({ domain, agentId });
      assert.ok(records.length > 0, `${agentId}:${domain}`);
      assert.ok(records.every((record) => record.source === BUSINESS_DATA_SOURCES.DEMO_MOCK), `${agentId}:${domain}`);
      assert.ok(records.every((record) => typeof record.status === "string" && record.status.length > 0), `${agentId}:${domain}`);
      assert.ok(records.every((record) => record.metadata.draft === true), `${agentId}:${domain}`);
    }
  }
});

test("CDC priority business memory records expose useful relations and dates", () => {
  const memory = createDemoBusinessMemoryRepository();

  const quote = memory.getBusinessRecord({ domain: "quotes", id: "quote-atlas-001", agentId: "commercial" });
  const invoice = memory.getBusinessRecord({ domain: "invoices", id: "invoice-atlas-deposit", agentId: "finance" });
  const payment = memory.getBusinessRecord({ domain: "payments", id: "payment-atlas-deposit", agentId: "finance" });
  const order = memory.getBusinessRecord({ domain: "orders", id: "order-atlas-001", agentId: "production" });
  const production = memory.getBusinessRecord({ domain: "production", id: "order-atlas-001", agentId: "production" });
  const purchaseNeed = memory.getBusinessRecord({ domain: "purchase_needs", id: "purchase-aluminum-a", agentId: "purchasing" });
  const supplier = memory.getBusinessRecord({ domain: "suppliers", id: "supplier-metal-one", agentId: "purchasing" });
  const hrSignal = memory.getBusinessRecord({ domain: "hr_demo_overview", id: "hr-leave-demo-001", agentId: "hr" });
  const ticket = memory.getBusinessRecord({ domain: "after_sales_tickets", id: "case-sav-001", agentId: "after_sales" });

  assert.equal(quote.relations.customerId, "customer-atlas");
  assert.equal(quote.relations.linkedOrderId, "order-atlas-001");
  assert.equal(invoice.relations.customerId, "customer-atlas");
  assert.equal(invoice.relations.orderId, "order-atlas-001");
  assert.equal(invoice.dates.dueAt, "2026-08-16");
  assert.equal(payment.relations.invoiceId, "invoice-atlas-deposit");
  assert.equal(payment.dates.dueAt, "this_week");
  assert.equal(order.dates.dueAt, "2026-08-16");
  assert.equal(production.relations.orderId, "order-atlas-001");
  assert.equal(production.dates.dueAt, "2026-08-16");
  assert.equal(purchaseNeed.relations.supplierId, "supplier-metal-one");
  assert.equal(purchaseNeed.relations.linkedOrderId, "order-atlas-001");
  assert.equal(supplier.status, "active");
  assert.equal(hrSignal.relations.employeeId, "employee-demo-002");
  assert.equal(hrSignal.dates.observedAt, "2026-08-18");
  assert.equal(ticket.relations.customerId, "customer-atlas");
  assert.equal(ticket.relations.orderId, "order-atlas-001");
});

test("Director central CDC scenario has the five priority agents and demo-marked outputs", async (t) => {
  const repository = new InMemoryRepository();
  const { app, inject } = await buildAuthenticatedApi({ repository });
  t.after(() => app.close());

  const response = await inject({
    method: "POST",
    url: "/api/director/requests",
    payload: {
      message: "Fais-moi le point complet de l'entreprise aujourd'hui."
    }
  });
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 201);
  // finance, commercial, production and purchasing each contribute two steps
  // since Lot 2C commit 4: the historical tool then the computing one.
  assert.deepEqual(body.results.map((result) => result.agent), [
    "finance",
    "finance",
    "commercial",
    "commercial",
    "production",
    "production",
    "purchasing",
    "purchasing",
    "after_sales"
  ]);
  assert.deepEqual([...new Set(body.results.map((result) => result.agent))], [
    "finance",
    "commercial",
    "production",
    "purchasing",
    "after_sales"
  ]);
  assert.equal(body.results.every((result) => result.result?.demo === true), true);
  assert.equal(body.results.every((result) => result.result?.dataSource === BUSINESS_DATA_SOURCES.DEMO_MOCK), true);
  assert.match(body.summary.headline, /5\/5 agents responded/);
  assert.equal(body.summary.decisionsRequired.length > 0, true);
});
