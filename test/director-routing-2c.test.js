import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TOOLS_BY_AGENT,
  InMemoryRepository,
  collectedItemIdentity,
  createDemoCompanyData,
  demoDate,
  createMaterialRequirements,
  createProductionSchedule,
  createSummaryAggregates,
  demoReferenceDate
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

async function ask(inject, message) {
  const response = await inject({ method: "POST", url: "/api/director/requests", payload: { message } });
  assert.equal(response.statusCode, 201, message);
  return JSON.parse(response.body);
}

function toolsOf(body, agentId) {
  return body.results.filter((result) => result.agent === agentId).map((result) => result.tool);
}

// CDC section 1 names nine agents for "Fais-moi le point complet", and section 3
// names the same nine for "Qu'est-ce qui est urgent aujourd'hui ?". Both used to
// reach the five of the MVP core, which left two of the ten headings section 31
// asks for empty in the very report those sections describe.
test("the literal CDC questions reach the nine agents they name", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const questions = [
    "Fais-moi le point complet de l'entreprise aujourd'hui.",
    "Qu'est-ce qui est urgent aujourd'hui ?",
    "Quelle est la situation aujourd'hui ?"
  ];

  for (const question of questions) {
    const body = await ask(inject, question);
    const agents = [...new Set(body.results.map((result) => result.agent))];

    assert.equal(agents.length, 9, question);
    for (const [heading, entries] of Object.entries(body.summary.minimumSections)) {
      assert.ok(entries.length > 0, `${heading} is empty for: ${question}`);
    }
  }
});

// Patterns are matched as substrings, so a word that names the question must not
// be a word that qualifies a noun. "urgent" alone captured "sujets juridiques
// urgents" and sent a legal request to all nine agents, the same collision
// "recommandes" had with "commandes". The pattern is "est urgent".
test("urgent used as an adjective never diverts a targeted request", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const legal = await ask(inject, "y a-t-il des sujets juridiques urgents");
  assert.deepEqual([...new Set(legal.results.map((result) => result.agent))], ["legal"]);

  const social = await ask(inject, "quelles publications reseaux sociaux sont urgentes");
  assert.deepEqual(
    [...new Set(social.results.map((result) => result.agent))],
    ["marketing", "community_manager"]
  );

  // And the staging CDC section 23 asks for is untouched: a request that matches
  // no pattern still goes to the MVP core, never to all nine.
  const unknown = await ask(inject, "Peux-tu regarder ce dossier stp ?");
  assert.deepEqual(
    [...new Set(unknown.results.map((result) => result.agent))],
    ["finance", "commercial", "production", "purchasing", "after_sales"]
  );
});

// CDC section 5: "Qu'est-ce qu'on doit encaisser cette semaine ?" must reach the
// receivables computation, not only the raw payment list.
test("the cash collection question reaches both finance tools, historical one first", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Qu'est-ce qu'on doit encaisser cette semaine ?");

  assert.deepEqual(toolsOf(body, "finance"), ["get_pending_payments", "get_receivables_summary", "get_revenue_summary"]);
  assert.equal(body.status, "completed");
});

test("the receivables summary carries totals per currency", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Qu'est-ce qu'on doit encaisser cette semaine ?");
  const summary = body.results.find((result) => result.tool === "get_receivables_summary").result.summary;

  assert.deepEqual(summary.totalsByCurrency, { MAD: 20500 });
  // Currencies are never merged into a single figure.
  assert.equal("total" in summary, false);
  assert.equal("totalAmount" in summary, false);
  assert.equal(Object.keys(summary.totalsByCurrency).length, 1);
});

// CDC section 4: "Quels clients dois-je relancer ?" must reach the follow-up
// filter, not only the pending quote list.
test("the follow-up question reaches both commercial tools, historical one first", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Quels clients dois-je relancer ?");

  // Lot 14 appends the order book figure, which section 29 asks for. The two
  // historical tools keep their order and their place ahead of it.
  assert.deepEqual(
    toolsOf(body, "commercial"),
    ["get_pending_quotes", "get_quote_follow_ups", "get_order_book_summary"]
  );
});

test("the follow-up tool applies the five day rule and excludes closed quotes", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Quels clients dois-je relancer ?");
  const items = body.results.find((result) => result.tool === "get_quote_follow_ups").result.items;

  assert.ok(items.length > 0);
  assert.ok(items.every((item) => item.noResponseDays >= 5), "the threshold is inclusive at five days");
  assert.equal(
    items.some((item) => ["accepted", "rejected", "cancelled", "closed", "won", "lost", "expired"].includes(item.status)),
    false,
    "a closed quote is never chased"
  );
});

test("the company overview runs fifteen steps for nine distinct agents", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");

  assert.equal(body.results.length, 15);
  assert.equal(new Set(body.results.map((result) => result.agent)).size, 9);
  assert.deepEqual(toolsOf(body, "finance"), ["get_pending_payments", "get_receivables_summary", "get_revenue_summary"]);
  assert.deepEqual(
    toolsOf(body, "commercial"),
    ["get_pending_quotes", "get_quote_follow_ups", "get_order_book_summary"]
  );
  assert.deepEqual(toolsOf(body, "production"), ["get_delayed_production_orders", "get_production_schedule"]);
  assert.deepEqual(toolsOf(body, "purchasing"), ["get_purchase_needs", "get_material_requirements"]);
});

// The headline names agents, so it must count agents and not steps.
test("the headline counts distinct agents, not steps", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");

  assert.match(body.summary.headline, /Point complete: 9\/9 agents responded/);
  assert.equal(body.summary.headline.includes("13/13"), false);
});

// Add before replace: the historical tools are still routed and still reported.
test("no historical tool was dropped from the company overview", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");
  const tools = body.results.map((result) => result.tool);

  for (const historical of [
    "get_pending_payments",
    "get_pending_quotes",
    "get_delayed_production_orders",
    "get_purchase_needs",
    "get_hr_overview",
    "get_after_sales_overview",
    "get_marketing_overview",
    "get_community_overview",
    "get_legal_overview"
  ]) {
    assert.ok(tools.includes(historical), `${historical} must still be routed`);
  }
});

test("no agent outside the routed ones gained a step", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");
  const stepsByAgent = new Map();

  for (const result of body.results) {
    stepsByAgent.set(result.agent, (stepsByAgent.get(result.agent) ?? 0) + 1);
  }

  for (const [agentId, count] of stepsByAgent) {
    // Lot 6 gives finance a third step, the revenue figure of CDC section 29.
    // Lot 14 gives commercial a third, the order book figure the same section
    // asks for. No other agent moved.
    const expected = ["finance", "commercial"].includes(agentId)
      ? 3
      : ["production", "purchasing"].includes(agentId) ? 2 : 1;
    assert.equal(count, expected, agentId);
  }
});

test("a sensitive payment still runs a single step and still needs approval", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const response = await inject({
    method: "POST",
    url: "/api/director/requests",
    payload: { message: "Effectue le paiement de cette facture." }
  });
  const body = JSON.parse(response.body);

  assert.equal(body.status, "requires_approval");
  assert.deepEqual(body.results.map((result) => result.tool), ["execute_invoice_payment"]);
  assert.equal(body.results[0].status, "not_executed");
});

test("the routing table keeps the historical tool ahead of the computing one", () => {
  assert.deepEqual([...DEFAULT_TOOLS_BY_AGENT.finance], ["get_pending_payments", "get_receivables_summary", "get_revenue_summary"]);
  assert.deepEqual(
    [...DEFAULT_TOOLS_BY_AGENT.commercial],
    ["get_pending_quotes", "get_quote_follow_ups", "get_order_book_summary"]
  );
  assert.deepEqual([...DEFAULT_TOOLS_BY_AGENT.production], ["get_delayed_production_orders", "get_production_schedule"]);
  assert.deepEqual([...DEFAULT_TOOLS_BY_AGENT.purchasing], ["get_purchase_needs", "get_material_requirements"]);
});

// Lot 2C commit 5 consumes what the computing tools aggregated. The totals sit
// beside the sections, never inside them: a section entry stays one business
// item, so an aggregate placed there would read as one more thing to act on.
test("the receivables totals reach the Director as an aggregate, not as a section entry", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");

  assert.deepEqual(body.summary.aggregates.payments.totalsByCurrency, { MAD: 20500 });
  assert.equal(body.summary.aggregates.payments.tool, "get_receivables_summary");
  assert.equal(body.summary.aggregates.payments.agent, "finance");
  // The aggregate never leaks into the section entries.
  assert.ok(body.summary.minimumSections["A ENCAISSER"].every((entry) => !("totalsByCurrency" in entry)));
  assert.ok(body.summary.minimumSections["A ENCAISSER"].every((entry) => "item" in entry));
});

// Adding a currency must never produce a single merged figure: two amounts in
// two currencies are two amounts, and adding them would invent money.
test("no aggregate ever merges currencies into one figure", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");

  for (const [domain, aggregate] of Object.entries(body.summary.aggregates)) {
    assert.equal("total" in aggregate, false, domain);
    assert.equal("totalAmount" in aggregate, false, domain);
    assert.equal("amount" in aggregate, false, domain);
  }
  assert.equal(Object.keys(body.summary.aggregates.payments.totalsByCurrency).length, 1);
});

// These two figures used to be held back. They are derived from the wall clock,
// and production lateness was anchored on the demo operating date, so reporting
// both would have shown two conventions in one answer. Lot 7 made the two
// references the same one, which is what lets CDC section 29 have its
// receivables rubric beside its collections rubric rather than folded into it.
test("the director reports receivables beside collections", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");
  const aggregate = body.summary.aggregates.payments;

  assert.equal("overdueTotalsByCurrency" in aggregate, true);
  assert.equal("overdue" in aggregate.counts, true);
  assert.deepEqual(aggregate.overdueTotalsByCurrency, { MAD: 20500 });
  assert.equal(aggregate.counts.overdue, 2);
  // The tool computed them all along: what changed is that the Director reports
  // them. This assertion is unchanged, and still says where the figures come
  // from rather than letting the projection invent one.
  const tool = body.results.find((result) => result.tool === "get_receivables_summary");
  assert.ok("overdueTotalsByCurrency" in tool.result.summary);
});

// On the demo set every receivable is overdue, so the two figures read the same
// and a check against that set would pass just as well if both keys pointed at
// one value. The separation is therefore proven where they diverge.
test("collections and receivables are two figures, never one", () => {
  const aggregates = createSummaryAggregates([
    {
      agent: "finance",
      tool: "get_receivables_summary",
      domain: "payments",
      status: "completed",
      result: {
        summary: {
          totalsByCurrency: { MAD: 1000, EUR: 500 },
          overdueTotalsByCurrency: { MAD: 300 },
          counts: { receivables: 3, overdue: 1, deduplicatedInvoices: 0 }
        }
      }
    }
  ]);
  const aggregate = aggregates.payments;

  assert.deepEqual(aggregate.totalsByCurrency, { MAD: 1000, EUR: 500 });
  assert.deepEqual(aggregate.overdueTotalsByCurrency, { MAD: 300 });
  assert.notDeepEqual(aggregate.totalsByCurrency, aggregate.overdueTotalsByCurrency);

  // A currency owed but not late must not appear as a zero among the overdue:
  // nothing is late in euros, and reporting EUR 0 would say something else.
  assert.equal("EUR" in aggregate.overdueTotalsByCurrency, false);

  assert.equal(aggregate.counts.receivables, 3);
  assert.equal(aggregate.counts.overdue, 1);
  assert.ok(aggregate.counts.overdue <= aggregate.counts.receivables, "overdue is a subset");

  // Never added into one figure, and never merged across currencies.
  for (const key of ["total", "totalAmount", "amount", "overdueTotal"]) {
    assert.equal(key in aggregate, false, key);
  }
  const summed = 1000 + 500 + 300;
  assert.equal(JSON.stringify(aggregate).includes(String(summed)), false, "no merged total");
});

test("the material requirements aggregate carries the shortages and the anomalies", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");
  const aggregate = body.summary.aggregates.purchase_needs;

  assert.equal(aggregate.counts.shortages, 2);
  assert.equal(aggregate.counts.covered, 0);
  assert.deepEqual(aggregate.anomalies, []);
  assert.equal(aggregate.tool, "get_material_requirements");
});

// An anomaly is what the tool could not compute. The demo data produces none,
// so this goes through the injectable seam rather than changing the demo data.
test("an anomaly computed by the tool is carried by the aggregate", () => {
  const computed = createMaterialRequirements({
    orders: [{ id: "order-x", status: "in_progress" }],
    billsOfMaterial: [],
    stock: [],
    products: []
  });

  assert.equal(computed.summary.counts.anomalies, 1);
  assert.equal(computed.summary.anomalies[0].reason, "bill_of_material_missing");
});

// An agent contributing several steps is one agent. body.agents names the
// organisation that answered, so it must not repeat it.
test("body.agents carries one entry per agent with the tools it ran", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");
  const ids = body.agents.map((agent) => agent.id);

  assert.equal(ids.length, 10, "director plus nine agents");
  assert.equal(new Set(ids).size, ids.length, "no agent is listed twice");
  assert.deepEqual(
    body.agents.find((agent) => agent.id === "production").tools,
    ["get_delayed_production_orders", "get_production_schedule"]
  );
  // No tool was lost by deduplicating: the flattened list is still the plan.
  assert.equal(body.agents.flatMap((agent) => agent.tools).length, body.results.length);
});

// Two tools of the same agent read the same reality, so the same invoice or the
// same production order reached a section twice. The Director reported four
// receivables where the business has two.
test("a section never reports the same business signal twice", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");

  for (const [name, entries] of Object.entries(body.summary.minimumSections)) {
    if (name === "DECISIONS NECESSAIRES") {
      continue;
    }
    const identities = entries.map((entry) => `${entry.domain}:${entry.item.id ?? entry.item.lineId ?? entry.item.orderId}`);
    assert.equal(new Set(identities).size, identities.length, name);
  }
  assert.equal(body.summary.minimumSections["A ENCAISSER"].length, 2);
  assert.equal(body.summary.minimumSections["RETARDS / PROBLEMES"].length, 2);
});

// Add before replace: deduplication keeps the first occurrence, and steps run
// with the historical tool first, so what the Director already reported stays.
test("deduplication keeps the historical tool, not the computing one", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");

  assert.deepEqual(
    body.summary.minimumSections["A ENCAISSER"].map((entry) => entry.tool),
    ["get_pending_payments", "get_pending_payments"]
  );
  assert.deepEqual(
    body.summary.minimumSections["RETARDS / PROBLEMES"]
      .filter((entry) => entry.agent === "production")
      .map((entry) => entry.tool),
    // Only the dangerous order is reported as late now, and the historical
    // tool is still the one kept by deduplication.
    ["get_delayed_production_orders"]
  );
});

// An item carrying nothing identifying is never assumed to be a duplicate.
test("the headline counts distinct signals, not repeated ones", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");

  assert.match(body.summary.headline, /9 high-priority demo signal\(s\)/);
  assert.equal(body.summary.headline.includes("12 high-priority"), false);
});

// CDC section 6: "Quelles commandes risquent d'etre en retard ?" must reach the
// derived schedule, not only the stored delayed-order list.
test("the production risk question reaches both production tools, historical one first", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Quelles commandes risquent d'etre en retard ?");

  assert.deepEqual(toolsOf(body, "production"), ["get_delayed_production_orders", "get_production_schedule"]);
});

// Lateness is measured against the demo operating date, not the wall clock.
// The schedule measures lateness against the clock, like any real report.
// The demo deadlines sit ahead of today, so the four CDC states stay
// observable without a fixture date deciding what is late.
test("the schedule derives the CDC states from the clock", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Quelles commandes risquent d'etre en retard ?");
  const items = body.results.find((result) => result.tool === "get_production_schedule").result.items;

  assert.deepEqual(items.map((item) => item.classification), ["IN_DANGER", "AT_RISK", "ON_TIME"]);
  assert.equal(items.every((item) => item.late === false), true, "no demo order is past its deadline");
  // No reference was injected: these states come from the clock, and the demo
  // deadlines sit ahead of it rather than behind it.
  assert.ok(
    items.every((item) => item.dueDate >= demoDate(0)),
    "the demo deadlines are ahead of today"
  );
});

test("the demo operating date is today, and a reference stays injectable", () => {
  const data = createDemoCompanyData();

  assert.equal(data.company.operatingDate, demoDate(0));
  assert.equal(demoReferenceDate().toISOString().slice(0, 10), demoDate(0));
  // Far enough ahead that every planned date sits behind it.
  assert.deepEqual(
    createProductionSchedule(data, { referenceDate: new Date(demoDate(30)) }).map((item) => item.classification),
    ["LATE", "LATE", "LATE"],
    "an explicit reference date still drives the derivation"
  );
});

// CDC section 7: "Qu'est-ce que je dois commander ?" must reach the derived
// material requirements, not only the stored purchase need list.
test("the purchasing question reaches both purchasing tools, historical one first", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Qu'est-ce que je dois commander ?");

  assert.deepEqual(toolsOf(body, "purchasing"), ["get_purchase_needs", "get_material_requirements"]);
});

test("the material requirements are derived from the bills of material and the stock", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Qu'est-ce que je dois commander ?");
  const items = body.results.find((result) => result.tool === "get_material_requirements").result.items;
  const missing = Object.fromEntries(items.map((item) => [item.productName, item.shortage]));

  assert.deepEqual(missing, { "Demo Aluminum Sheet A": 20, "Demo Packaging B": 90 });
  assert.ok(items.every((item) => item.required > item.available), "only shortages are reported");
  assert.ok(items.every((item) => item.covered === false));
});

// The demo data completes every step, so this guard has no observable effect
// through the API. It is reached directly: a step that did not complete has an
// absent or partial output, and a half-computed total is worse than none.
test("a step that did not complete never feeds an aggregate", () => {
  const step = {
    agent: "finance",
    tool: "get_receivables_summary",
    domain: "payments",
    result: { summary: { totalsByCurrency: { MAD: 999 }, counts: { receivables: 1 } } }
  };

  assert.deepEqual(createSummaryAggregates([{ ...step, status: "not_executed" }]), {});
  assert.deepEqual(createSummaryAggregates([{ ...step, status: "failed" }]), {});
  assert.deepEqual(
    createSummaryAggregates([{ ...step, status: "completed" }]).payments.totalsByCurrency,
    { MAD: 999 }
  );
});

test("a tool with no projection contributes no aggregate", () => {
  const aggregates = createSummaryAggregates([
    {
      agent: "finance",
      tool: "get_pending_payments",
      domain: "payments",
      status: "completed",
      result: { summary: { totalsByCurrency: { MAD: 1 } } }
    }
  ]);

  assert.deepEqual(aggregates, {});
});

// The first completed step of a domain wins, like deduplication elsewhere.
test("one aggregate per domain, the first one wins", () => {
  const make = (tool, amount) => ({
    agent: "finance",
    tool,
    domain: "payments",
    status: "completed",
    result: { summary: { totalsByCurrency: { MAD: amount }, counts: {} } }
  });
  const aggregates = createSummaryAggregates([
    make("get_receivables_summary", 100),
    make("get_receivables_summary", 200)
  ]);

  assert.deepEqual(aggregates.payments.totalsByCurrency, { MAD: 100 });
});

// Every demo item carries an identifier and no identifier is shared across two
// domains, so these two guards are reached directly as well.
test("an item identity is scoped to its presentation domain", () => {
  assert.notEqual(
    collectedItemIdentity("payments", { id: "shared-001" }),
    collectedItemIdentity("invoices", { id: "shared-001" }),
    "the same identifier in two domains is two different signals"
  );
  assert.equal(
    collectedItemIdentity("payments", { id: "shared-001" }),
    collectedItemIdentity("payments", { id: "shared-001" })
  );
});

test("an item carrying nothing identifying is never assumed to be a duplicate", () => {
  assert.equal(collectedItemIdentity("payments", {}), null);
  assert.equal(collectedItemIdentity("payments", { amount: 10 }), null);
  assert.equal(collectedItemIdentity("payments", null), null);
  // Falsy but present identifiers are still identifiers.
  assert.notEqual(collectedItemIdentity("payments", { id: 0 }), null);
  assert.notEqual(collectedItemIdentity("payments", { label: "" }), null);
});

// The fallback chain is ordered: a record carrying several of them is
// recognised by the most specific one.
test("the identity falls back through id, lineId, orderId, subject, label", () => {
  assert.equal(collectedItemIdentity("d", { id: "a", lineId: "b", orderId: "c" }).endsWith("a"), true);
  assert.equal(collectedItemIdentity("d", { lineId: "b", orderId: "c" }).endsWith("b"), true);
  assert.equal(collectedItemIdentity("d", { orderId: "c", subject: "s" }).endsWith("c"), true);
  assert.equal(collectedItemIdentity("d", { subject: "s", label: "l" }).endsWith("s"), true);
  assert.equal(collectedItemIdentity("d", { label: "l" }).endsWith("l"), true);
});
