import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TOOLS_BY_AGENT, InMemoryRepository } from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

async function ask(inject, message) {
  const response = await inject({ method: "POST", url: "/api/director/requests", payload: { message } });
  assert.equal(response.statusCode, 201, message);
  return JSON.parse(response.body);
}

function toolsOf(body, agentId) {
  return body.results.filter((result) => result.agent === agentId).map((result) => result.tool);
}

// CDC section 5: "Qu'est-ce qu'on doit encaisser cette semaine ?" must reach the
// receivables computation, not only the raw payment list.
test("the cash collection question reaches both finance tools, historical one first", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Qu'est-ce qu'on doit encaisser cette semaine ?");

  assert.deepEqual(toolsOf(body, "finance"), ["get_pending_payments", "get_receivables_summary"]);
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

  assert.deepEqual(toolsOf(body, "commercial"), ["get_pending_quotes", "get_quote_follow_ups"]);
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

test("the company overview runs eleven steps for nine distinct agents", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");

  assert.equal(body.results.length, 11);
  assert.equal(new Set(body.results.map((result) => result.agent)).size, 9);
  assert.deepEqual(toolsOf(body, "finance"), ["get_pending_payments", "get_receivables_summary"]);
  assert.deepEqual(toolsOf(body, "commercial"), ["get_pending_quotes", "get_quote_follow_ups"]);
});

// The headline names agents, so it must count agents and not steps.
test("the headline counts distinct agents, not steps", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");

  assert.match(body.summary.headline, /Point complete: 9\/9 agents responded/);
  assert.equal(body.summary.headline.includes("11/11"), false);
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

test("no agent other than finance and commercial gained a step", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");
  const stepsByAgent = new Map();

  for (const result of body.results) {
    stepsByAgent.set(result.agent, (stepsByAgent.get(result.agent) ?? 0) + 1);
  }

  for (const [agentId, count] of stepsByAgent) {
    assert.equal(count, ["finance", "commercial"].includes(agentId) ? 2 : 1, agentId);
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
  assert.deepEqual([...DEFAULT_TOOLS_BY_AGENT.finance], ["get_pending_payments", "get_receivables_summary"]);
  assert.deepEqual([...DEFAULT_TOOLS_BY_AGENT.commercial], ["get_pending_quotes", "get_quote_follow_ups"]);
});

// The summary of the computing tools is not consumed by the Director yet: that
// is the object of a later commit, and pinning it here keeps the scope honest.
test("the receivables totals are not yet reflected in the Director sections", async (t) => {
  const { app, inject } = await buildAuthenticatedApi({ repository: new InMemoryRepository() });
  t.after(() => app.close());

  const body = await ask(inject, "Fais-moi le point sur mon entreprise aujourd'hui.");

  assert.equal("totalsByCurrency" in body.summary, false);
  assert.ok(body.summary.minimumSections["A ENCAISSER"].every((entry) => !("totalsByCurrency" in entry)));
});
