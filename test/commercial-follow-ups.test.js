import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_QUOTE_FOLLOW_UP_DAYS,
  InMemoryRepository,
  ToolExecutionService,
  ToolExecutionServiceError,
  createMvpAgentPermissions,
  createMvpToolRegistry,
  createQuoteFollowUps,
  isQuoteClosed,
  isQuoteFollowUpDue
} from "../src/index.js";

const REFERENCE = new Date("2026-08-19");

function quote(overrides = {}) {
  return { id: "q", status: "pending_customer_reply", noResponseDays: 10, ...overrides };
}

function due(overrides = {}, options = {}) {
  return isQuoteFollowUpDue(quote(overrides), { referenceDate: REFERENCE, ...options });
}

function createHarness() {
  const repository = new InMemoryRepository();
  return {
    repository,
    service: new ToolExecutionService({ repository, toolRegistry: createMvpToolRegistry({ repository }) })
  };
}

function execute(service, agentId = "commercial") {
  return service.execute({
    agentId,
    agentPermissions: createMvpAgentPermissions(agentId),
    toolId: "get_quote_follow_ups",
    input: { requestId: "req-fu" },
    requestId: "req-fu"
  });
}

test("the tool is scoped to quotes only", () => {
  const tool = createMvpToolRegistry().get("get_quote_follow_ups");

  assert.deepEqual([...tool.securityDomains], ["quotes"]);
  assert.deepEqual([...tool.allowedAgents], ["commercial"]);
  assert.equal(tool.requiredPermission, "read_analyze");
});

test("the default threshold is five days", () => {
  assert.equal(DEFAULT_QUOTE_FOLLOW_UP_DAYS, 5);
});

// CDC section 4 says "more than 5 days". The threshold is inclusive, so a quote
// sitting exactly five days is already due rather than waiting one more day.
test("the threshold is inclusive at exactly five days", () => {
  assert.equal(due({ noResponseDays: 4 }), false);
  assert.equal(due({ noResponseDays: 5 }), true);
  assert.equal(due({ noResponseDays: 6 }), true);
});

test("a custom threshold is honoured, still inclusive", () => {
  assert.equal(due({ noResponseDays: 9 }, { thresholdDays: 10 }), false);
  assert.equal(due({ noResponseDays: 10 }, { thresholdDays: 10 }), true);
});

test("a closed quote is never followed up", () => {
  for (const status of ["accepted", "rejected", "cancelled", "closed", "won", "lost", "expired"]) {
    assert.equal(due({ status }), false, status);
    assert.equal(isQuoteClosed({ status }), true, status);
  }

  // A quote accepted but still awaiting its deposit is not closed: it is exactly
  // the case that needs chasing.
  assert.equal(isQuoteClosed({ status: "accepted_pending_deposit" }), false);
  assert.equal(due({ status: "accepted_pending_deposit" }), true);
});

test("a quote with no usable delay is not followed up", () => {
  assert.equal(due({ noResponseDays: undefined }), false);
  assert.equal(due({ noResponseDays: null }), false);
  assert.equal(due({ noResponseDays: "8" }), false);
  assert.equal(due({ noResponseDays: Number.NaN }), false);
  assert.equal(isQuoteFollowUpDue(null, { referenceDate: REFERENCE }), false);
});

// lastFollowUpAt is deliberately absent from the persisted model. The rule is
// honoured when a caller supplies it, and only fixtures exercise it here.
test("a quote chased within the window is skipped, using fixtures only", () => {
  assert.equal(due({ lastFollowUpAt: "2026-08-18" }), false);
  assert.equal(due({ lastFollowUpAt: "2026-08-15" }), false);
  // Exactly the threshold away: due again.
  assert.equal(due({ lastFollowUpAt: "2026-08-14" }), true);
  assert.equal(due({ lastFollowUpAt: "2026-08-01" }), true);
  // An unusable value must not silence a legitimate follow-up.
  assert.equal(due({ lastFollowUpAt: "not-a-date" }), true);
  assert.equal(due({ lastFollowUpAt: 20260818 }), true);
});

test("lastFollowUpAt is not part of the demo business data", async () => {
  const { service } = createHarness();
  const result = await execute(service);

  assert.equal(
    result.output.result.items.some((item) => "lastFollowUpAt" in item),
    false,
    "the persisted model must not carry a follow-up date in this lot"
  );
});

test("commercial reads the demo quotes that are due", async () => {
  const { service } = createHarness();
  const result = await execute(service);
  const items = result.output.result.items;

  assert.equal(result.status, "completed");
  assert.equal(result.output.result.dataSource, "demo_mock");
  // Demo quotes sit at 8 and 5 days: both are due with an inclusive threshold.
  assert.deepEqual(items.map((item) => item.id).sort(), ["quote-atlas-001", "quote-solar-002"]);
  assert.ok(items.every((item) => item.noResponseDays >= DEFAULT_QUOTE_FOLLOW_UP_DAYS));
});

test("no aggregate is produced for follow-ups", async () => {
  const { service } = createHarness();
  const result = await execute(service);

  assert.equal("summary" in result.output.result, false);
});

test("an empty quote list yields no follow-up", () => {
  assert.deepEqual(createQuoteFollowUps({ quotes: [] }, { referenceDate: REFERENCE }), []);
  assert.deepEqual(createQuoteFollowUps({}, { referenceDate: REFERENCE }), []);
});

test("an agent without the quotes scope is denied", async () => {
  const { service } = createHarness();

  await assert.rejects(
    () => service.execute({
      agentId: "commercial",
      agentPermissions: createMvpAgentPermissions("purchasing"),
      toolId: "get_quote_follow_ups",
      input: { requestId: "req-fu" },
      requestId: "req-fu"
    }),
    (error) => {
      assert.equal(error.code, "DOMAIN_NOT_ALLOWED");
      assert.deepEqual(error.details.missingDomains, ["quotes"]);
      return true;
    }
  );
});

test("an agent other than commercial cannot use the tool", async () => {
  const { service } = createHarness();

  await assert.rejects(
    () => execute(service, "finance"),
    (error) => error instanceof ToolExecutionServiceError && error.code === "AGENT_NOT_ALLOWED"
  );
});
