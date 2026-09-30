import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  IdempotencyConflictError,
  InMemoryRepository,
  RecordConflictError,
  PUBLICATION_APPROVAL_ACTION,
  PUBLICATION_STATUSES,
  PUBLICATION_STATUSES_REQUIRING_APPROVAL,
  PUBLICATION_TRANSITIONS,
  PrismaRepository,
  PublicationModelError,
  PublicationStateError,
  applyApprovalDecision,
  assertPublicationRecord,
  assertRepositoryContract,
  cancelPublication,
  createPublication,
  createPublicationDraft,
  listPublications,
  markPublicationFailed,
  markPublicationPublished,
  preparePublication,
  recordPublicationDecision,
  requestPublicationApproval,
  reworkPublication,
  schedulePublication,
  transitionPublication
} from "../src/index.js";

const DRAFT = Object.freeze({
  channel: "instagram",
  caption: "Nouvelle chambre enfant livrée à Casablanca.",
  hashtags: ["#HKids", "hkids", "chambre_enfant"],
  authorAgentId: "community_manager",
  createdById: "leader-1"
});

test("a draft is created with the submitted content and nothing decided yet", async () => {
  const repository = new InMemoryRepository();

  const publication = await createPublication(repository, DRAFT);

  assert.equal(publication.status, "draft");
  assert.equal(publication.channel, "instagram");
  assert.equal(publication.caption, DRAFT.caption);
  // "#HKids" and "hkids" are the same tag, stored once and without the hash.
  assert.deepEqual([...publication.hashtags], ["HKids", "chambre_enfant"]);
  assert.equal(publication.authorAgentId, "community_manager");
  assert.equal(publication.approvalId, null);
  assert.equal(publication.approvalDecision, null);
  assert.equal(publication.publishedAt, null);
  assert.equal(publication.externalId, null);
  assert.equal(publication.error, null);
  assert.ok(publication.id);
  assert.ok(publication.createdAt);
  assert.deepEqual(await repository.listPublications({ status: "draft" }), [publication]);
});

test("a draft refuses an unknown channel and unusable content", () => {
  assert.throws(() => createPublicationDraft({ ...DRAFT, channel: "threads" }), (error) => {
    assert.ok(error instanceof PublicationModelError);
    assert.equal(error.code, "PUBLICATION_CHANNEL_UNKNOWN");
    return true;
  });

  assert.throws(() => createPublicationDraft({ ...DRAFT, hashtags: ["deux mots"] }), (error) => {
    assert.equal(error.code, "PUBLICATION_HASHTAGS_INVALID");
    return true;
  });

  assert.throws(() => createPublicationDraft({ ...DRAFT, scheduledAt: "mardi prochain" }), (error) => {
    assert.equal(error.code, "PUBLICATION_DATE_INVALID");
    return true;
  });
});

test("the full cycle runs from draft to published, one state at a time", async () => {
  const repository = new InMemoryRepository();
  const scheduledAt = "2026-10-05T09:00:00.000Z";

  const draft = await createPublication(repository, DRAFT);
  const prepared = await preparePublication(repository, draft.id, { scheduledAt });
  const { publication: pending, approval } = await requestPublicationApproval(repository, draft.id, {
    reason: "Publication Instagram à valider avant diffusion."
  });

  assert.equal(prepared.status, "prepared");
  assert.equal(pending.status, "pending_approval");
  assert.equal(pending.approvalId, approval.id);
  assert.equal(approval.requestedAction, PUBLICATION_APPROVAL_ACTION);
  assert.equal(approval.status, "pending");
  assert.equal(approval.metadata.publicationId, draft.id);

  // The decision is taken through the existing approval system, not here.
  await repository.approveApproval(approval.id, { approverId: "leader-1", decisionReason: "Validé par Hiba." });

  const approved = await recordPublicationDecision(repository, draft.id);
  const scheduled = await schedulePublication(repository, draft.id, { scheduledAt });
  const published = await markPublicationPublished(repository, draft.id, { externalId: "ig-123" });

  assert.equal(approved.status, "approved");
  assert.equal(scheduled.status, "scheduled");
  assert.equal(scheduled.scheduledAt, scheduledAt);
  assert.equal(published.status, "published");
  assert.equal(published.externalId, "ig-123");
  assert.ok(published.publishedAt);
  assert.equal((await listPublications(repository, { channel: "instagram" })).length, 1);
});

test("invalid transitions are refused", async () => {
  const repository = new InMemoryRepository();
  const draft = await createPublication(repository, DRAFT);

  for (const status of ["pending_approval", "approved", "scheduled", "published", "failed", "rejected"]) {
    assert.throws(() => transitionPublication(draft, status), (error) => {
      assert.ok(error instanceof PublicationStateError);
      assert.equal(error.code, "PUBLICATION_TRANSITION_REFUSED");
      assert.equal(error.details.from, "draft");
      return true;
    });
  }

  const prepared = transitionPublication(draft, "prepared");
  assert.throws(() => transitionPublication(prepared, "scheduled"), { code: "PUBLICATION_TRANSITION_REFUSED" });
  assert.throws(() => transitionPublication(prepared, "sent"), { code: "PUBLICATION_STATUS_UNKNOWN" });

  // Terminal states stay terminal.
  const cancelled = transitionPublication(prepared, "cancelled");
  for (const status of PUBLICATION_STATUSES) {
    assert.throws(() => transitionPublication(cancelled, status), { code: "PUBLICATION_TRANSITION_REFUSED" });
  }
  assert.deepEqual(PUBLICATION_TRANSITIONS.published, []);

  // A draft cannot leave DRAFT without content, and identity cannot be rewritten
  // on the way through.
  const empty = createPublicationDraft({ channel: "facebook" });
  assert.throws(() => transitionPublication(empty, "prepared"), { code: "PUBLICATION_CAPTION_MISSING" });
  assert.throws(() => transitionPublication(draft, "prepared", { channel: "tiktok" }), {
    code: "PUBLICATION_FIELD_IMMUTABLE"
  });
  assert.throws(() => transitionPublication(draft, "prepared", { publishedBy: "someone" }), {
    code: "PUBLICATION_FIELD_UNKNOWN"
  });
});

test("approval is mandatory before APPROVED, SCHEDULED and PUBLISHED", async () => {
  const repository = new InMemoryRepository();
  const draft = await createPublication(repository, DRAFT);
  await preparePublication(repository, draft.id);
  const { publication: pending, approval } = await requestPublicationApproval(repository, draft.id);

  // No decision recorded: the three statuses are unreachable, even by hand.
  for (const status of PUBLICATION_STATUSES_REQUIRING_APPROVAL) {
    assert.throws(() => transitionPublication(pending, status, {}), (error) => {
      assert.ok(["PUBLICATION_APPROVAL_REQUIRED", "PUBLICATION_TRANSITION_REFUSED"].includes(error.code));
      return true;
    });
  }

  await assert.rejects(recordPublicationDecision(repository, draft.id), { code: "PUBLICATION_APPROVAL_PENDING" });

  // An approval granted for another publication does not approve this one.
  const other = await createPublication(repository, DRAFT);
  const foreign = await repository.createApproval({
    requestingAgent: "community_manager",
    requestedAction: PUBLICATION_APPROVAL_ACTION,
    reason: "Autre publication.",
    affectedResource: `publication:${other.id}`,
    metadata: { publicationId: other.id }
  });
  await repository.approveApproval(foreign.id, { approverId: "leader-1" });
  await repository.savePublication({ ...(await repository.getPublication(draft.id)), approvalId: foreign.id });
  await assert.rejects(recordPublicationDecision(repository, draft.id), { code: "PUBLICATION_APPROVAL_MISMATCH" });

  // Back to the real approval, refused this time.
  await repository.savePublication({ ...(await repository.getPublication(draft.id)), approvalId: approval.id });
  await repository.rejectApproval(approval.id, { approverId: "leader-1", decisionReason: "Photo à refaire." });
  const rejected = await recordPublicationDecision(repository, draft.id);

  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.approvalReason, "Photo à refaire.");
  await assert.rejects(schedulePublication(repository, draft.id, { scheduledAt: "2026-10-05T09:00:00.000Z" }), {
    code: "PUBLICATION_TRANSITION_REFUSED"
  });
});

test("the validation information is kept and a rework clears it", async () => {
  const repository = new InMemoryRepository();
  const draft = await createPublication(repository, DRAFT);
  await preparePublication(repository, draft.id);
  const { approval } = await requestPublicationApproval(repository, draft.id);
  await repository.approveApproval(approval.id, { approverId: "leader-1", decisionReason: "Validé par Hiba." });
  await recordPublicationDecision(repository, draft.id);
  await schedulePublication(repository, draft.id, { scheduledAt: "2026-10-05T09:00:00.000Z" });
  const published = await markPublicationPublished(repository, draft.id, { externalId: "ig-777" });

  assert.equal(published.approvalId, approval.id);
  assert.equal(published.approvalDecision, "approved");
  assert.equal(published.approvalDecidedById, "leader-1");
  assert.equal(published.approvalReason, "Validé par Hiba.");
  assert.ok(published.approvalDecidedAt);

  // A refused publication that goes back to draft loses its decision, so it
  // must be approved again before it can move on.
  const second = await createPublication(repository, DRAFT);
  await preparePublication(repository, second.id);
  const { approval: secondApproval } = await requestPublicationApproval(repository, second.id);
  await repository.rejectApproval(secondApproval.id, { approverId: "leader-1", decisionReason: "À revoir." });
  await recordPublicationDecision(repository, second.id);
  const reworked = await reworkPublication(repository, second.id, { caption: "Version corrigée." });

  assert.equal(reworked.status, "draft");
  assert.equal(reworked.approvalId, null);
  assert.equal(reworked.approvalDecision, null);
  assert.equal(reworked.approvalDecidedAt, null);
  assert.equal(reworked.caption, "Version corrigée.");
});

test("a failed send keeps its reason and can be scheduled again", async () => {
  const repository = new InMemoryRepository();
  const scheduledAt = "2026-10-06T09:00:00.000Z";
  const draft = await createPublication(repository, DRAFT);
  await preparePublication(repository, draft.id);
  const { approval } = await requestPublicationApproval(repository, draft.id);
  await repository.approveApproval(approval.id, { approverId: "leader-1" });
  await recordPublicationDecision(repository, draft.id);
  await schedulePublication(repository, draft.id, { scheduledAt });

  const failed = await markPublicationFailed(repository, draft.id, {
    code: "CONNECTOR_UNAVAILABLE",
    message: "Aucun connecteur n'est branché."
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "CONNECTOR_UNAVAILABLE");

  const retried = await schedulePublication(repository, draft.id, { scheduledAt });
  assert.equal(retried.status, "scheduled");
  assert.equal(retried.error, null);

  const cancelled = await cancelPublication(repository, draft.id, { reason: "Report demandé." });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.metadata.cancelReason, "Report demandé.");
});

test("an idempotency key holds one publication and identifiers stay unique", async () => {
  const repository = new InMemoryRepository();
  const idempotencyKey = "hkids-instagram-2026-10-05";

  const first = await createPublication(repository, { ...DRAFT, idempotencyKey });

  await assert.rejects(createPublication(repository, { ...DRAFT, idempotencyKey }), (error) => {
    assert.ok(error instanceof IdempotencyConflictError);
    assert.equal(error.code, "IDEMPOTENCY_KEY_TAKEN");
    assert.equal(error.details.publication.id, first.id);
    return true;
  });

  const others = [await createPublication(repository, DRAFT), await createPublication(repository, DRAFT)];
  const ids = new Set([first.id, ...others.map((publication) => publication.id)]);

  assert.equal(ids.size, 3);
  assert.equal((await repository.listPublications()).length, 3);
});

test("both repositories carry the publication methods", () => {
  assert.equal(assertRepositoryContract(new InMemoryRepository()), true);
  assert.equal(assertRepositoryContract(PrismaRepository.prototype), true);
});

test("no publication state ever reaches a social network", async () => {
  // Comments are stripped first: they state what these modules must not do, and
  // the code is what is being checked.
  const sources = ["src/social/publication.js", "src/social/publication-service.js"]
    .map((file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8"))
    .join("\n")
    .replace(/^\s*\/\/.*$/gm, "");

  // No client, no workflow, no credential: M2.1 stores state and nothing else.
  for (const forbidden of ["fetch(", "http", "n8n", "instagram.com", "graph.facebook", "token", "oauth"]) {
    assert.ok(!sources.toLowerCase().includes(forbidden.toLowerCase()), `unexpected ${forbidden} in the social modules`);
  }

  // And the whole cycle runs with the network taken away.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("A publication must not call any network.");
  };

  try {
    const repository = new InMemoryRepository();
    const draft = await createPublication(repository, DRAFT);
    await preparePublication(repository, draft.id);
    const { approval } = await requestPublicationApproval(repository, draft.id);
    await repository.approveApproval(approval.id, { approverId: "leader-1" });
    await recordPublicationDecision(repository, draft.id);
    await schedulePublication(repository, draft.id, { scheduledAt: "2026-10-07T09:00:00.000Z" });
    const published = await markPublicationPublished(repository, draft.id);

    assert.equal(published.status, "published");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// A repository that hands records back the way PostgreSQL does: instants as
// Date objects. Everything else is the real in-memory repository, so the
// service runs against real approvals and real writes.
function postgresShaped(repository) {
  const asDates = (publication) =>
    publication === null
      ? null
      : Object.freeze({
          ...publication,
          scheduledAt: publication.scheduledAt === null ? null : new Date(publication.scheduledAt),
          publishedAt: publication.publishedAt === null ? null : new Date(publication.publishedAt),
          approvalDecidedAt: publication.approvalDecidedAt === null ? null : new Date(publication.approvalDecidedAt),
          createdAt: new Date(publication.createdAt),
          updatedAt: new Date(publication.updatedAt)
        });

  return Object.freeze({
    createApproval: (input) => repository.createApproval(input),
    getApproval: (approvalId) => repository.getApproval(approvalId),
    approveApproval: (approvalId, decision) => repository.approveApproval(approvalId, decision),
    rejectApproval: (approvalId, decision) => repository.rejectApproval(approvalId, decision),
    createPublication: (publication) => asDates(repository.createPublication(publication)),
    savePublication: (publication) => asDates(repository.savePublication(publication)),
    getPublication: (publicationId) => asDates(repository.getPublication(publicationId))
  });
}

test("a publication read back from PostgreSQL runs approved -> scheduled -> published", async () => {
  const memory = new InMemoryRepository();
  const repository = postgresShaped(memory);
  const scheduledAt = new Date("2026-10-05T09:00:00.000Z");

  const draft = await createPublication(repository, DRAFT);
  await preparePublication(repository, draft.id);
  const { approval } = await requestPublicationApproval(repository, draft.id);
  await repository.approveApproval(approval.id, { approverId: "leader-1", decisionReason: "Validé." });

  const approved = await recordPublicationDecision(repository, draft.id);
  assert.equal(approved.status, "approved");
  assert.ok(approved.approvalDecidedAt instanceof Date, "the repository hands dates back");

  const scheduled = await schedulePublication(repository, draft.id, { scheduledAt });
  assert.equal(scheduled.status, "scheduled");

  const published = await markPublicationPublished(repository, draft.id, {
    externalId: "ig-postgres",
    publishedAt: new Date("2026-10-05T09:01:00.000Z")
  });
  assert.equal(published.status, "published");
  assert.equal(published.externalId, "ig-postgres");

  // Whatever shape came in, one type is stored: the model keeps ISO strings.
  const stored = memory.getPublication(draft.id);
  assert.equal(stored.scheduledAt, "2026-10-05T09:00:00.000Z");
  assert.equal(stored.publishedAt, "2026-10-05T09:01:00.000Z");
  assert.equal(typeof stored.approvalDecidedAt, "string");
  assert.equal(stored.approvalDecision, "approved");

  // And the record checker accepts the PostgreSQL shape rather than refusing it.
  assert.equal(typeof assertPublicationRecord(published).approvalDecidedAt, "string");
});

test("asking for approval from an impossible state creates no approval at all", async () => {
  const repository = new InMemoryRepository();

  // Valid case: from PREPARED, one approval, carried by the publication.
  const ready = await createPublication(repository, DRAFT);
  await preparePublication(repository, ready.id);
  const { publication, approval } = await requestPublicationApproval(repository, ready.id);

  assert.equal(publication.status, "pending_approval");
  assert.equal(publication.approvalId, approval.id);
  assert.equal(approval.status, "pending");
  assert.equal((await repository.listApprovals()).length, 1);

  // Invalid case: a draft cannot be submitted, and nothing is left behind.
  const draft = await createPublication(repository, DRAFT);
  await assert.rejects(requestPublicationApproval(repository, draft.id), { code: "PUBLICATION_TRANSITION_REFUSED" });

  assert.equal((await repository.listApprovals()).length, 1, "no orphan approval was created");
  assert.equal((await repository.listPendingApprovals()).length, 1);
  assert.equal((await repository.getPublication(draft.id)).status, "draft");
});

test("cancelling a publication closes the approval waiting on it", async () => {
  const repository = new InMemoryRepository();
  const draft = await createPublication(repository, DRAFT);
  await preparePublication(repository, draft.id);
  const { approval } = await requestPublicationApproval(repository, draft.id);

  const cancelled = await cancelPublication(repository, draft.id, { reason: "Report demandé." });
  const closed = await repository.getApproval(approval.id);

  assert.equal(cancelled.status, "cancelled");
  assert.equal(closed.status, "rejected");
  assert.match(closed.decisionReason, /annul/i);
  assert.deepEqual(await repository.listPendingApprovals(), []);
});

// The PostgreSQL driver reports a unique violation as P2002, sometimes naming
// the constraint in meta.target, sometimes only inside the driver message.
// Both shapes are reproduced here, on the real PrismaRepository.
function prismaRaising(cause, existing = null) {
  return new PrismaRepository({
    prisma: {
      socialPublication: {
        create: async () => {
          throw cause;
        },
        findUnique: async () => existing
      }
    }
  });
}

function driverConflict(constraint) {
  return {
    code: "P2002",
    meta: {
      driverAdapterError: {
        cause: { originalMessage: `duplicate key value violates unique constraint "${constraint}"` }
      }
    }
  };
}

test("the same identifier is refused the same way in both repositories", async () => {
  const memory = new InMemoryRepository();
  const first = await createPublication(memory, { ...DRAFT, id: "pub-1" });

  await assert.rejects(createPublication(memory, { ...DRAFT, id: "pub-1", caption: "Écrasée" }), (error) => {
    assert.ok(error instanceof RecordConflictError);
    assert.equal(error.code, "RECORD_ID_TAKEN");
    return true;
  });
  assert.equal((await memory.getPublication("pub-1")).caption, first.caption, "the stored publication is untouched");
  assert.equal((await memory.listPublications()).length, 1);

  const draft = createPublicationDraft({ ...DRAFT, id: "pub-1" });
  for (const cause of [{ code: "P2002", meta: { target: ["id"] } }, driverConflict("social_publications_pkey")]) {
    await assert.rejects(prismaRaising(cause).createPublication(draft), (error) => {
      assert.ok(error instanceof RecordConflictError);
      assert.equal(error.code, "RECORD_ID_TAKEN");
      return true;
    });
  }
});

test("a duplicated idempotency key is recognised however the driver reports it", async () => {
  const draft = createPublicationDraft({ ...DRAFT, idempotencyKey: "hkids-instagram-2026-10-05" });
  const winner = { id: "pub-winner" };

  // Named in meta.target, and named only in the driver message: the second
  // shape is the one the pg adapter actually produces.
  for (const cause of [
    { code: "P2002", meta: { target: ["idempotencyKey"] } },
    driverConflict("social_publications_idempotencyKey_key")
  ]) {
    await assert.rejects(prismaRaising(cause, winner).createPublication(draft), (error) => {
      assert.ok(error instanceof IdempotencyConflictError);
      assert.equal(error.code, "IDEMPOTENCY_KEY_TAKEN");
      assert.equal(error.details.publication.id, "pub-winner");
      return true;
    });
  }

  // A unique violation that is neither of those two keeps its own error.
  await assert.rejects(
    prismaRaising({ code: "P2002", meta: { target: ["externalId"] } }).createPublication(draft),
    (error) => {
      assert.ok(!(error instanceof IdempotencyConflictError));
      assert.ok(!(error instanceof RecordConflictError));
      assert.equal(error.code, "P2002");
      return true;
    }
  );
});

test("an invented approval never approves a publication", async () => {
  const repository = new InMemoryRepository();
  const draft = await createPublication(repository, DRAFT);
  await preparePublication(repository, draft.id);
  const { publication: pending, approval } = await requestPublicationApproval(repository, draft.id);
  const decidedAt = new Date().toISOString();

  // A transition cannot state a decision, whatever it carries.
  assert.throws(
    () =>
      transitionPublication(pending, "approved", {
        approvalDecision: "approved",
        approvalDecidedAt: decidedAt,
        approvalDecidedById: "leader-1"
      }),
    { code: "PUBLICATION_DECISION_NOT_TRANSITIONABLE" }
  );

  // An approval the publication is not waiting on is refused.
  assert.throws(
    () =>
      applyApprovalDecision(pending, {
        id: "approbation-inventee",
        status: "approved",
        approverId: "leader-1",
        decidedAt,
        metadata: { publicationId: pending.id }
      }),
    { code: "PUBLICATION_APPROVAL_MISMATCH" }
  );

  // The awaited approval, but granted for something else, is refused too.
  assert.throws(
    () =>
      applyApprovalDecision(pending, {
        id: approval.id,
        status: "approved",
        approverId: "leader-1",
        decidedAt,
        metadata: { publicationId: "une-autre-publication" }
      }),
    { code: "PUBLICATION_APPROVAL_MISMATCH" }
  );

  // And the real one, while it is still undecided, is refused as well.
  assert.throws(() => applyApprovalDecision(pending, approval), { code: "PUBLICATION_APPROVAL_PENDING" });
  assert.equal((await repository.getPublication(draft.id)).status, "pending_approval");
});

test("a state that no decision produced cannot be stored either", async () => {
  const repository = new InMemoryRepository();
  const draft = await createPublication(repository, DRAFT);

  for (const forged of [
    { ...draft, status: "published", publishedAt: new Date().toISOString() },
    { ...draft, status: "approved" },
    { ...draft, status: "scheduled", scheduledAt: "2026-10-05T09:00:00.000Z" }
  ]) {
    assert.throws(() => repository.savePublication(forged), { code: "PUBLICATION_APPROVAL_REQUIRED" });
  }

  assert.throws(() => repository.savePublication({ ...draft, status: "pending_approval" }), {
    code: "PUBLICATION_APPROVAL_MISSING"
  });
  assert.throws(() => repository.savePublication({ ...draft, status: "pending" }), {
    code: "PUBLICATION_RECORD_INVALID"
  });
  assert.equal((await repository.getPublication(draft.id)).status, "draft");

  // savePublication stays low level by design: it stores a valid record in the
  // state that record is in. What it cannot do is invent a business state.
  const returned = repository.savePublication({ ...draft, caption: "Corrigée." });
  assert.equal(returned.caption, "Corrigée.");
  assert.equal(returned.status, "draft");
});
