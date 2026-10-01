import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryRepository,
  applyPublicationApprovalDecision,
  createMvpToolRegistry,
  createPublication,
  isPublicationApproval,
  loadFoundationConfig,
  prepareAndSubmitPublication,
  readPublicationCalendar,
  recordPublicationDecision
} from "../src/index.js";
import { buildAuthenticatedApi } from "../test-support/api-auth.js";

// M2.3 closes the loop between Hiba's decision and the publication it was taken
// on. Everything here runs against the real API, the real approval system and
// the real state machine: no network, no connector, nothing published.
const SLOT = "2026-10-20T09:00:00.000Z";
const WINDOW = Object.freeze({ from: "2026-10-19", to: "2026-10-21" });

async function submitted(overrides = {}) {
  const repository = new InMemoryRepository();
  const api = await buildAuthenticatedApi({ repository });
  const publication = await createPublication(repository, {
    channel: "instagram",
    caption: "Nouvelle chambre enfant livrée à Casablanca.",
    authorAgentId: "community_manager",
    ...overrides
  });
  const { approval } = await prepareAndSubmitPublication(repository, publication.id, { scheduledAt: SLOT });

  return { repository, api, publication, approval };
}

function decide(api, approvalId, decision, decisionReason = "Décision de Hiba.") {
  return api.inject({ method: "POST", url: `/api/approvals/${approvalId}/${decision}`, payload: { decisionReason } });
}

async function eventsOf(repository, type) {
  return (await repository.listAuditEvents()).filter((event) => event.type === type);
}

test("Hiba approves: the decision reaches the publication", async () => {
  const { repository, api, publication, approval } = await submitted();

  const response = await decide(api, approval.id, "approve");
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.approval.status, "approved");
  assert.equal(body.publication.status, "approved");
  assert.equal((await repository.getApproval(approval.id)).status, "approved");

  const stored = await repository.getPublication(publication.id);
  assert.equal(stored.status, "approved");
  assert.equal(stored.approvalDecision, "approved");
  assert.equal(stored.approvalDecidedById, "test-leader");
  assert.equal(stored.approvalReason, "Décision de Hiba.");
  assert.equal(stored.approvalId, approval.id);

  // A tool approval answers with an execution; a publication approval must not,
  // because nothing was executed.
  assert.equal(body.execution, undefined);
  await api.app.close();
});

test("an approved publication does not schedule itself", async () => {
  const { repository, api, publication, approval } = await submitted();

  await decide(api, approval.id, "approve");
  const stored = await repository.getPublication(publication.id);

  assert.equal(stored.status, "approved", "approved is where the decision stops");
  assert.notEqual(stored.status, "scheduled");
  assert.equal(stored.publishedAt, null, "nothing was published");
  assert.equal(stored.externalId, null);

  // Scheduling stays a separate, deliberate operation.
  assert.deepEqual((await readPublicationCalendar(repository, WINDOW)).entries.map((entry) => entry.status), [
    "approved"
  ]);
  await api.app.close();
});

test("Hiba refuses: the publication is refused and leaves the calendar, not the database", async () => {
  const { repository, api, publication, approval } = await submitted();

  const response = await decide(api, approval.id, "reject", "Photo à refaire.");
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.approval.status, "rejected");
  assert.equal(body.publication.status, "rejected");

  const stored = await repository.getPublication(publication.id);
  assert.equal(stored.status, "rejected");
  assert.equal(stored.approvalDecision, "rejected");
  assert.equal(stored.approvalReason, "Photo à refaire.");
  assert.equal(stored.scheduledAt, SLOT, "the refused plan is kept as it was");

  assert.deepEqual((await readPublicationCalendar(repository, WINDOW)).entries, [], "off the calendar");
  assert.equal((await repository.listPublications()).length, 1, "still stored");
  await api.app.close();
});

test("the journal says which publication a decision was taken on", async () => {
  const approved = await submitted();
  await decide(approved.api, approved.approval.id, "approve");

  const granted = await eventsOf(approved.repository, "approval_granted");
  assert.equal(granted.length, 1);
  assert.equal(granted[0].metadata.publicationId, approved.publication.id);
  assert.equal(granted[0].metadata.approvalId, approved.approval.id);
  assert.equal(granted[0].metadata.status, "approved");
  assert.equal(granted[0].actorUserId, "test-leader");
  await approved.api.app.close();

  const refused = await submitted();
  await decide(refused.api, refused.approval.id, "reject");

  const rejected = await eventsOf(refused.repository, "approval_rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].metadata.publicationId, refused.publication.id);
  assert.equal(rejected[0].metadata.approvalId, refused.approval.id);
  assert.equal(rejected[0].metadata.status, "rejected");
  await refused.api.app.close();
});

test("a tool approval still executes its tool, exactly as before", async () => {
  // The delay alert is the existing end-to-end tool approval: raised through its
  // endpoint, decided through the same approval route. The client is a stub that
  // records what it was handed, so execution is proved without a network.
  const calls = [];
  const repository = new InMemoryRepository();
  const api = await buildAuthenticatedApi({
    repository,
    config: loadFoundationConfig({
      NODE_ENV: "test",
      WORKFLOW_PROVIDER: "n8n",
      WORKFLOW_ENABLED: "true",
      WORKFLOW_BASE_URL: "https://n8n.example.test",
      N8N_WEBHOOK_PATH: "delay-alert",
      N8N_API_KEY_HEADER: "X-AI-Agents-Token",
      N8N_API_KEY: "token-de-test-jamais-committe"
    }),
    toolRegistry: createMvpToolRegistry({
      repository,
      workflowClient: {
        postWorkflowEvent: async (event) => {
          calls.push(event);
          return { httpStatus: 200, body: { status: "received" }, durationMs: 3 };
        }
      }
    })
  });

  const raised = await api.inject({
    method: "POST",
    url: "/api/production/delay-alerts",
    payload: { orderId: "order-atlas-001", delayRisk: "high" }
  });
  const approvalId = JSON.parse(raised.body).approval.id;
  const approval = await repository.getApproval(approvalId);

  assert.equal(raised.statusCode, 202);
  assert.equal(isPublicationApproval(approval), false, "this approval names no publication");
  assert.equal(calls.length, 0, "nothing was sent before the decision");

  const response = await decide(api, approvalId, "approve");
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.approval.status, "approved");
  assert.ok(body.execution, "a tool approval still answers with its execution");
  assert.equal(body.publication, undefined, "and with no publication");
  assert.equal(calls.length, 1, "the tool really ran");
  assert.equal((await repository.listExecutions()).length, 1);
  await api.app.close();
});

test("an approval that names no publication is refused by the publication primitive", async () => {
  const repository = new InMemoryRepository();
  const approval = await repository.createApproval({
    requestingAgent: "finance",
    requestedAction: "execute_invoice_payment",
    reason: "Paiement à valider.",
    affectedResource: "invoice:demo",
    metadata: { toolId: "execute_invoice_payment" }
  });

  assert.equal(isPublicationApproval(approval), false);
  await assert.rejects(applyPublicationApprovalDecision(repository, approval.id), {
    code: "PUBLICATION_APPROVAL_MISMATCH"
  });
  await assert.rejects(applyPublicationApprovalDecision(repository, "approbation-inconnue"), {
    code: "PUBLICATION_APPROVAL_MISSING"
  });
});

test("a second decision on the same publication is refused", async () => {
  const { repository, api, publication, approval } = await submitted();

  await decide(api, approval.id, "approve");

  // The approval system refuses to decide twice.
  const again = await decide(api, approval.id, "approve");
  assert.equal(again.statusCode, 409);
  assert.equal(JSON.parse(again.body).details.code, "APPROVAL_ALREADY_APPROVED");

  // And applying the stored decision a second time is refused by the state
  // machine, since approved no longer accepts a decision.
  await assert.rejects(applyPublicationApprovalDecision(repository, approval.id), {
    code: "PUBLICATION_TRANSITION_REFUSED"
  });
  await assert.rejects(recordPublicationDecision(repository, publication.id), {
    code: "PUBLICATION_TRANSITION_REFUSED"
  });

  assert.equal((await repository.getPublication(publication.id)).status, "approved");
  assert.equal((await repository.listApprovals()).length, 1, "no approval was created by applying a decision");
  await api.app.close();
});

test("an approval pointing at the wrong publication is refused", async () => {
  const repository = new InMemoryRepository();
  const mine = await createPublication(repository, { channel: "instagram", caption: "La mienne." });
  const other = await createPublication(repository, { channel: "instagram", caption: "Une autre." });
  await prepareAndSubmitPublication(repository, mine.id, { scheduledAt: SLOT });

  // An approval decided for another publication: its metadata names a different
  // record than the one waiting on it.
  const foreign = await repository.createApproval({
    requestingAgent: "community_manager",
    requestedAction: "publish_social_publication",
    reason: "Autre publication.",
    affectedResource: `publication:${other.id}`,
    metadata: { publicationId: other.id }
  });
  await repository.approveApproval(foreign.id, { approverId: "leader-1" });

  // other is still a draft, so the decision has nothing to apply to.
  await assert.rejects(applyPublicationApprovalDecision(repository, foreign.id), {
    code: "PUBLICATION_APPROVAL_MISSING"
  });
  assert.equal((await repository.getPublication(other.id)).status, "draft");
  assert.equal((await repository.getPublication(mine.id)).status, "pending_approval");

  // A second approval claiming the same publication decides nothing either: the
  // decision applied is always the one the publication is waiting on, never the
  // one handed to the function. That approval is still pending, so the answer is
  // that the publication is still waiting, and its state does not move.
  const second = await repository.createApproval({
    requestingAgent: "community_manager",
    requestedAction: "publish_social_publication",
    reason: "Deuxième approbation pour la même publication.",
    affectedResource: `publication:${mine.id}`,
    metadata: { publicationId: mine.id }
  });
  await repository.approveApproval(second.id, { approverId: "leader-1" });

  await assert.rejects(applyPublicationApprovalDecision(repository, second.id), {
    code: "PUBLICATION_APPROVAL_PENDING"
  });
  const untouched = await repository.getPublication(mine.id);
  assert.equal(untouched.status, "pending_approval", "untouched");
  assert.notEqual(untouched.approvalId, second.id, "it still waits on its own approval");
  assert.equal(untouched.approvalDecision, null);
});

test("deciding a publication reaches no network and publishes nothing", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("Deciding a publication must not call any network.");
  };

  try {
    const { repository, api, publication, approval } = await submitted();
    const response = await decide(api, approval.id, "approve");

    assert.equal(response.statusCode, 200);
    const stored = await repository.getPublication(publication.id);
    assert.equal(stored.status, "approved");
    assert.equal(stored.publishedAt, null);
    assert.equal(stored.externalId, null);
    assert.equal((await repository.listExecutions()).length, 0, "no execution was created");
    await api.app.close();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the submission itself still creates exactly one approval", async () => {
  const repository = new InMemoryRepository();
  const publication = await createPublication(repository, { channel: "facebook", caption: "Texte." });
  const { approval } = await prepareAndSubmitPublication(repository, publication.id, { scheduledAt: SLOT });

  assert.equal(isPublicationApproval(approval), true);
  assert.equal((await repository.listApprovals()).length, 1);

  // Submitting through the lower-level primitive carries the same marker, so the
  // route recognises both paths.
  const second = await createPublication(repository, { channel: "facebook", caption: "Texte." });
  await prepareAndSubmitPublication(repository, second.id, { scheduledAt: SLOT });
  const pending = await repository.listPendingApprovals();

  assert.equal(pending.length, 2);
  assert.ok(pending.every((entry) => isPublicationApproval(entry)));
  assert.deepEqual(
    pending.map((entry) => entry.requestedAction),
    ["publish_social_publication", "publish_social_publication"]
  );
});
