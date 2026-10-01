import { randomUUID } from "node:crypto";
import { assertFuturePublicationSlot } from "./publication-calendar.js";
import {
  PublicationStateError,
  applyApprovalDecision,
  createPublicationDraft,
  transitionPublication
} from "./publication.js";

// M2.1 publication service. It moves a publication through its states and
// stores it, and that is the whole of it: no social network is called, no n8n
// workflow is sent, no token is read and nothing is published anywhere. The
// only side effects are repository writes.
export const PUBLICATION_APPROVAL_ACTION = "publish_social_publication";

export async function createPublication(repository, input = {}) {
  return repository.createPublication(createPublicationDraft(input));
}

export async function listPublications(repository, filters = {}) {
  return repository.listPublications(filters);
}

// DRAFT -> PREPARED. The content is complete enough to be read by a human.
export async function preparePublication(repository, publicationId, changes = {}) {
  const publication = await requirePublication(repository, publicationId);
  return repository.savePublication(transitionPublication(publication, "prepared", changes));
}

// PREPARED or REJECTED -> DRAFT. The content goes back to being written.
export async function reworkPublication(repository, publicationId, changes = {}) {
  const publication = await requirePublication(repository, publicationId);
  return repository.savePublication(
    transitionPublication(publication, "draft", {
      ...changes,
      // The refused decision does not follow the content into its next round.
      approvalId: null,
      approvalDecision: null,
      approvalDecidedById: null,
      approvalDecidedAt: null,
      approvalReason: null
    })
  );
}

// PREPARED -> PENDING_APPROVAL. The approval is created through the existing
// approval system, so the publication waits on the same human gate as every
// other sensitive action.
export async function requestPublicationApproval(
  repository,
  publicationId,
  { requestingAgent = "community_manager", requestedByAgentId = null, reason, risk = "high", changes = {} } = {}
) {
  const publication = await requirePublication(repository, publicationId);

  // The move is computed first, on an identifier reserved here. A publication
  // that cannot be submitted throws before anything is created, so a refusal
  // never leaves an approval waiting in someone's queue. Any content the
  // submission carries, such as the calendar slot, travels in that same move.
  const approvalId = randomUUID();
  const pending = transitionPublication(publication, "pending_approval", { ...changes, approvalId });

  const approval = await repository.createApproval({
    id: approvalId,
    requestId: publication.requestId,
    requestingAgent,
    requestedByAgentId,
    requestedAction: PUBLICATION_APPROVAL_ACTION,
    reason: reason ?? `Publication ${publication.channel} à valider avant diffusion.`,
    affectedResource: `publication:${publication.id}`,
    risk,
    status: "pending",
    metadata: { publicationId: publication.id, channel: publication.channel }
  });

  return { publication: await repository.savePublication(pending), approval };
}

// PENDING_APPROVAL -> APPROVED or REJECTED. The decision is read from the
// approval record; this service never decides for a human.
export async function recordPublicationDecision(repository, publicationId) {
  const publication = await requirePublication(repository, publicationId);

  if (!publication.approvalId) {
    throw new PublicationStateError("This publication carries no approval to read.", "PUBLICATION_APPROVAL_MISSING", {
      publicationId
    });
  }

  const approval = await repository.getApproval(publication.approvalId);
  if (!approval) {
    throw new PublicationStateError("The approval of this publication no longer exists.", "PUBLICATION_APPROVAL_MISSING", {
      publicationId,
      approvalId: publication.approvalId
    });
  }

  // The stored approval, and only it, produces the decision. Whether it matches
  // this publication and whether it was actually decided are checked in the
  // model, on the record itself.
  return repository.savePublication(applyApprovalDecision(publication, approval));
}

// APPROVED or FAILED -> SCHEDULED. Storing a date only: no scheduler runs in
// M2.1, nothing will fire on its own.
export async function schedulePublication(repository, publicationId, { scheduledAt } = {}) {
  const publication = await requirePublication(repository, publicationId);
  return repository.savePublication(
    transitionPublication(publication, "scheduled", {
      scheduledAt: scheduledAt ?? publication.scheduledAt,
      error: null
    })
  );
}

// SCHEDULED -> PUBLISHED. Called once a connector has actually sent the post.
// No connector exists yet, so in M2.1 this is only reached from a test or a
// human-driven record of something published by hand.
export async function markPublicationPublished(
  repository,
  publicationId,
  { externalId = null, publishedAt = new Date().toISOString() } = {}
) {
  const publication = await requirePublication(repository, publicationId);
  return repository.savePublication(transitionPublication(publication, "published", { externalId, publishedAt }));
}

// SCHEDULED -> FAILED. The reason is kept on the publication so a retry is a
// decision and not a guess.
export async function markPublicationFailed(repository, publicationId, { code, message } = {}) {
  const publication = await requirePublication(repository, publicationId);
  return repository.savePublication(
    transitionPublication(publication, "failed", {
      error: { code, message, at: new Date().toISOString() }
    })
  );
}

export async function cancelPublication(repository, publicationId, { reason = null } = {}) {
  const publication = await requirePublication(repository, publicationId);
  const cancelled = transitionPublication(
    publication,
    "cancelled",
    reason === null ? {} : { metadata: { cancelReason: reason } }
  );

  // A cancelled publication must not keep a human waiting on it. The decision
  // is closed through the existing approval system, with its own rules, and
  // only while it is still open.
  const approval = publication.approvalId ? await repository.getApproval(publication.approvalId) : null;
  if (approval && ["pending", "requested"].includes(approval.status)) {
    await repository.rejectApproval(approval.id, {
      decisionReason: reason === null ? "Publication annulée." : `Publication annulée : ${reason}`
    });
  }

  return repository.savePublication(cancelled);
}

// M2.2. The one operation the editorial workflow needs: a draft is prepared,
// given its slot in the calendar and submitted for approval, in that order. It
// is built entirely from the M2.1 primitives, creates exactly one approval, and
// leaves none behind when a step refuses. Preparing is internal work and opens
// no approval of its own: the human gate is the submission, and it stays the
// only one.
export async function prepareAndSubmitPublication(
  repository,
  publicationId,
  { scheduledAt, caption, hashtags, metadata, now, ...approvalOptions } = {}
) {
  const publication = await requirePublication(repository, publicationId);

  // The slot is judged before anything is written: a date in the past is not a
  // new plan, and a refusal must leave the publication as it was.
  const slot = assertFuturePublicationSlot(scheduledAt, now === undefined ? {} : { now });

  if (publication.status === "draft") {
    await preparePublication(repository, publicationId, {
      scheduledAt: slot,
      ...(caption === undefined ? {} : { caption }),
      ...(hashtags === undefined ? {} : { hashtags }),
      ...(metadata === undefined ? {} : { metadata })
    });
  }

  return requestPublicationApproval(repository, publicationId, {
    ...approvalOptions,
    changes: { scheduledAt: slot }
  });
}

// M2.3. An approval that names a publication is the human gate of the editorial
// workflow; every other approval is a tool action and is none of this module's
// business. The caller asks this before deciding what a decision means.
export function isPublicationApproval(approval) {
  return typeof approval?.metadata?.publicationId === "string" && approval.metadata.publicationId.length > 0;
}

// M2.3. Carries a decision Hiba has already taken through to the publication it
// was taken on. It decides nothing, it executes nothing, it publishes nothing
// and it never creates an approval: the decision is read from the approval
// record, and the state machine is what accepts or refuses it. A publication
// already approved or rejected refuses a second decision, and an approval that
// does not match its publication is refused by the model.
export async function applyPublicationApprovalDecision(repository, approvalId) {
  const approval = await repository.getApproval(approvalId);
  if (!approval) {
    throw new PublicationStateError(`Approval not found: ${approvalId}`, "PUBLICATION_APPROVAL_MISSING", {
      approvalId
    });
  }

  if (!isPublicationApproval(approval)) {
    throw new PublicationStateError(
      "This approval does not name a publication.",
      "PUBLICATION_APPROVAL_MISMATCH",
      { approvalId }
    );
  }

  return recordPublicationDecision(repository, approval.metadata.publicationId);
}

async function requirePublication(repository, publicationId) {
  const publication = await repository.getPublication(publicationId);
  if (!publication) {
    throw new PublicationStateError(`Publication not found: ${publicationId}`, "PUBLICATION_NOT_FOUND", {
      publicationId
    });
  }
  return publication;
}
