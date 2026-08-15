import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AGENT_SOPS,
  InMemorySopRepository,
  SopAccessError,
  SopContractError,
  createSopDefinition,
  listDefaultSops,
  validateSopDefinition
} from "../src/index.js";

const EXPECTED_SOP_BY_AGENT = Object.freeze({
  commercial: "commercial-quote-follow-up-draft",
  finance: "finance-receivables-follow-up-draft",
  production: "production-delay-follow-up-draft",
  purchasing: "purchasing-needs-identification-draft",
  after_sales: "after-sales-claim-resolution-draft",
  hr: "hr-administrative-follow-up-draft",
  marketing: "marketing-content-preparation-draft",
  community_manager: "community-publication-preparation-draft",
  legal: "legal-attention-identification-draft"
});

test("default SOP catalog provides draft procedures for the CDC MVP agents", () => {
  const sops = listDefaultSops();

  assert.equal(sops.length, 9);
  assert.deepEqual(
    Object.fromEntries(sops.map((sop) => [sop.agentId, sop.id])),
    EXPECTED_SOP_BY_AGENT
  );

  for (const sop of sops) {
    assert.equal(validateSopDefinition(sop), true);
    assert.equal(sop.status, "draft");
    assert.equal(sop.metadata.draft, true);
    assert.equal(sop.metadata.confirmedByClient, false);
    assert.equal(sop.metadata.operationalUse, "planning_reference_only");
    assert.equal(sop.metadata.executesTools, false);
    assert.equal(sop.steps.every((step) => step.toolId === undefined && step.execute === undefined), true);
  }
});

test("SOP repository allows agents to read only their own SOPs", () => {
  const repository = new InMemorySopRepository();

  assert.deepEqual(repository.listSops({ agentId: "finance" }).map((sop) => sop.id), [
    "finance-receivables-follow-up-draft"
  ]);
  assert.equal(
    repository.getSop("finance-receivables-follow-up-draft", { agentId: "finance" }).agentId,
    "finance"
  );

  assert.throws(
    () => repository.getSop("finance-receivables-follow-up-draft", { agentId: "marketing" }),
    (error) => error instanceof SopAccessError && error.code === "SOP_ACCESS_DENIED"
  );
  assert.throws(
    () => repository.getSop("hr-administrative-follow-up-draft", { agentId: "production" }),
    (error) => error instanceof SopAccessError && error.code === "SOP_ACCESS_DENIED"
  );
});

test("Director can inspect the SOP catalog without making SOPs executable", () => {
  const repository = new InMemorySopRepository();
  const allSops = repository.listAllSopsForDirector({ agentId: "director" });

  assert.equal(allSops.length, DEFAULT_AGENT_SOPS.length);
  assert.equal(repository.getSop("legal-attention-identification-draft", { agentId: "director" }).agentId, "legal");
  assert.equal(allSops.every((sop) => sop.metadata.executesTools === false), true);
  assert.throws(
    () => repository.listAllSopsForDirector({ agentId: "finance" }),
    (error) => error instanceof SopAccessError && error.code === "SOP_ACCESS_DENIED"
  );
});

test("sensitive SOPs explicitly require human approval", () => {
  const repository = new InMemorySopRepository();
  const finance = repository.getSop("finance-receivables-follow-up-draft", { agentId: "finance" });
  const hr = repository.getSop("hr-administrative-follow-up-draft", { agentId: "hr" });
  const legal = repository.getSop("legal-attention-identification-draft", { agentId: "legal" });

  for (const sop of [finance, hr, legal]) {
    assert.equal(sop.requiredApprovals.length > 0, true, sop.id);
    assert.equal(sop.requiredApprovals.every((approval) => approval.required === true), true, sop.id);
    assert.match(JSON.stringify(sop.requiredApprovals), /human validation/i);
  }
});

test("Community Manager SOP stays under Marketing supervision", () => {
  const repository = new InMemorySopRepository();
  const marketing = repository.getSop("marketing-content-preparation-draft", { agentId: "marketing" });
  const community = repository.getSop("community-publication-preparation-draft", { agentId: "community_manager" });

  assert.deepEqual(marketing.metadata.supervisedAgentIds, ["community_manager"]);
  assert.equal(community.metadata.supervisorAgentId, "marketing");
  assert.equal(community.agentId, "community_manager");
  assert.throws(
    () => repository.getSop("community-publication-preparation-draft", { agentId: "marketing" }),
    (error) => error instanceof SopAccessError && error.code === "SOP_ACCESS_DENIED"
  );
});

test("SOP contract rejects non-draft claims and direct tool execution declarations", () => {
  assert.throws(
    () => createSopDefinition({
      id: "bad-sop",
      agentId: "finance",
      name: "Bad SOP",
      description: "Invalid",
      status: "final",
      steps: [{ id: "step-1", order: 1, description: "Bad" }],
      inputs: [{ name: "payments" }],
      outputs: [{ name: "summary" }],
      requiredApprovals: [{ action: "execute_payment", required: true, reason: "Human validation is required." }],
      relatedDomains: ["payments"],
      metadata: { draft: false, executesTools: false }
    }),
    (error) => error instanceof SopContractError && error.code === "INVALID_SOP"
  );

  assert.throws(
    () => createSopDefinition({
      id: "tool-execution-sop",
      agentId: "finance",
      name: "Tool execution SOP",
      description: "Invalid",
      status: "draft",
      steps: [{ id: "step-1", order: 1, description: "Run a tool", toolId: "get_pending_payments" }],
      inputs: [{ name: "payments" }],
      outputs: [{ name: "summary" }],
      requiredApprovals: [{ action: "execute_payment", required: true, reason: "Human validation is required." }],
      relatedDomains: ["payments"],
      metadata: { draft: true, executesTools: false }
    }),
    (error) => error instanceof SopContractError && error.code === "INVALID_SOP"
  );
});
