import { randomUUID } from "node:crypto";

// M2.1 publication model. It holds the state of a social post inside the
// platform and nothing else: no network client, no scheduler, no writing AI and
// no connector live here. A publication only ever moves through this state
// machine, which is what makes "published" impossible to reach without the
// human decision the approval system already stores.
export const PUBLICATION_STATUSES = Object.freeze([
  "draft",
  "prepared",
  "pending_approval",
  "approved",
  "scheduled",
  "published",
  "failed",
  "rejected",
  "cancelled"
]);

export const PUBLICATION_CHANNELS = Object.freeze(["instagram", "facebook", "tiktok", "linkedin"]);

// Allowed moves, by current status. An empty list is a terminal status.
export const PUBLICATION_TRANSITIONS = Object.freeze({
  draft: Object.freeze(["prepared", "cancelled"]),
  // A prepared post can go back to draft: the content is being reworked before
  // anyone is asked to look at it.
  prepared: Object.freeze(["draft", "pending_approval", "cancelled"]),
  pending_approval: Object.freeze(["approved", "rejected", "cancelled"]),
  approved: Object.freeze(["scheduled", "cancelled"]),
  scheduled: Object.freeze(["published", "failed", "cancelled"]),
  published: Object.freeze([]),
  // A failed send may be scheduled again: the approved content has not changed,
  // so the decision that covered it still covers the retry.
  failed: Object.freeze(["scheduled", "cancelled"]),
  // A rejected post goes back to draft. It must be submitted and approved
  // again; the refused decision never carries over.
  rejected: Object.freeze(["draft", "cancelled"]),
  cancelled: Object.freeze([])
});

// Statuses a publication cannot hold without an approval decision recorded on
// it. Human validation stays the guard: this is what makes it impossible to
// jump straight to APPROVED, SCHEDULED or PUBLISHED.
export const PUBLICATION_STATUSES_REQUIRING_APPROVAL = Object.freeze(["approved", "scheduled", "published"]);

// Fields a transition may carry. Anything else is refused rather than silently
// dropped, and identity fields stay out on purpose.
const MUTABLE_PUBLICATION_FIELDS = Object.freeze([
  "caption",
  "hashtags",
  "scheduledAt",
  "metadata",
  "approvalId",
  "approvalDecision",
  "approvalDecidedById",
  "approvalDecidedAt",
  "approvalReason",
  "publishedAt",
  "externalId",
  "error",
  "updatedAt"
]);

// The decision a human took. A transition may only clear these fields; setting
// them is reserved to applyApprovalDecision, which reads them off an approval
// record. That is what makes an invented decision unusable rather than merely
// discouraged.
const DECISION_FIELDS = Object.freeze([
  "approvalDecision",
  "approvalDecidedById",
  "approvalDecidedAt",
  "approvalReason"
]);

// PostgreSQL hands back Date objects where memory holds the ISO strings it was
// given. Every record entering the model is normalised on these fields, so the
// rules below read one shape and the model keeps one type.
const INSTANT_FIELDS = Object.freeze(["scheduledAt", "publishedAt", "approvalDecidedAt", "createdAt", "updatedAt"]);

const IMMUTABLE_PUBLICATION_FIELDS = Object.freeze([
  "id",
  "status",
  "channel",
  "requestId",
  "authorAgentId",
  "createdById",
  "idempotencyKey",
  "createdAt"
]);

export class PublicationModelError extends Error {
  constructor(message, code = "PUBLICATION_INVALID", details = {}) {
    super(message);
    this.name = "PublicationModelError";
    this.code = code;
    this.details = details;
  }
}

export class PublicationStateError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "PublicationStateError";
    this.code = code;
    this.details = details;
  }
}

export function createPublicationDraft({
  id = randomUUID(),
  requestId = null,
  channel,
  caption = "",
  hashtags = [],
  scheduledAt = null,
  authorAgentId = null,
  createdById = null,
  idempotencyKey = null,
  metadata = {},
  createdAt = new Date().toISOString(),
  updatedAt = createdAt
} = {}) {
  if (!PUBLICATION_CHANNELS.includes(channel)) {
    throw new PublicationModelError(`Unknown publication channel: ${channel}`, "PUBLICATION_CHANNEL_UNKNOWN", {
      channel,
      channels: [...PUBLICATION_CHANNELS]
    });
  }

  return Object.freeze({
    id,
    requestId,
    channel,
    // A draft may still be empty: the caption is required to leave DRAFT, not
    // to create one.
    caption: requireText(caption, "caption"),
    hashtags: normalizeHashtags(hashtags),
    scheduledAt: optionalInstant(scheduledAt, "scheduledAt"),
    status: "draft",
    authorAgentId,
    createdById,
    idempotencyKey: optionalKey(idempotencyKey, "idempotencyKey"),
    approvalId: null,
    approvalDecision: null,
    approvalDecidedById: null,
    approvalDecidedAt: null,
    approvalReason: null,
    publishedAt: null,
    externalId: null,
    error: null,
    metadata: { ...metadata },
    createdAt,
    updatedAt
  });
}

// Pure state move: it returns the next record and never touches storage or a
// network. It cannot record a decision, only clear one.
export function transitionPublication(publication, nextStatus, changes = {}) {
  return moveTo(publication, nextStatus, changes, false);
}

// The only way into APPROVED and REJECTED. The decision is copied off the
// approval the publication is waiting on, so a caller cannot state one: it has
// to produce the approval record that carries it.
export function applyApprovalDecision(publication, approval) {
  const current = normalizeInstants(requirePublication(publication));
  assertDecidedApproval(current, approval);

  return moveTo(
    current,
    approval.status === "approved" ? "approved" : "rejected",
    {
      approvalDecision: approval.status,
      approvalDecidedById: approval.approverId ?? null,
      approvalDecidedAt: instantOf(approval.decidedAt) ?? new Date().toISOString(),
      approvalReason: approval.decisionReason ?? null
    },
    true
  );
}

// What a stored publication must satisfy, whatever wrote it. The repositories
// call it so a row that no state machine produced cannot be stored either.
export function assertPublicationRecord(publication) {
  const record = normalizeInstants(requirePublication(publication));

  if (!PUBLICATION_CHANNELS.includes(record.channel)) {
    throw new PublicationModelError(`Unknown publication channel: ${record.channel}`, "PUBLICATION_CHANNEL_UNKNOWN", {
      publicationId: record.id,
      channel: record.channel
    });
  }

  assertStatusRequirements(record);
  return record;
}

function moveTo(publication, nextStatus, changes, decisionAllowed) {
  const current = normalizeInstants(requirePublication(publication));

  if (!PUBLICATION_STATUSES.includes(nextStatus)) {
    throw new PublicationStateError(`Unknown publication status: ${nextStatus}`, "PUBLICATION_STATUS_UNKNOWN", {
      publicationId: current.id,
      status: nextStatus
    });
  }

  const allowed = PUBLICATION_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(nextStatus)) {
    throw new PublicationStateError(
      `A publication cannot move from ${current.status} to ${nextStatus}.`,
      "PUBLICATION_TRANSITION_REFUSED",
      { publicationId: current.id, from: current.status, to: nextStatus, allowed: [...allowed] }
    );
  }

  const next = Object.freeze({
    ...current,
    ...sanitizeChanges(changes, current, decisionAllowed),
    status: nextStatus,
    updatedAt: changes.updatedAt ?? new Date().toISOString()
  });

  assertStatusRequirements(next);
  return next;
}

// What each status needs to be true. Checked on the record after the move, so a
// caller cannot reach a status by supplying the missing field on the way out of
// it.
function assertStatusRequirements(publication) {
  const { status } = publication;

  if (status === "prepared" && publication.caption.trim().length === 0) {
    throw new PublicationStateError("A prepared publication needs a caption.", "PUBLICATION_CAPTION_MISSING", {
      publicationId: publication.id
    });
  }

  if (status === "pending_approval" && !isText(publication.approvalId)) {
    throw new PublicationStateError(
      "A publication waiting for approval must carry the approval it waits on.",
      "PUBLICATION_APPROVAL_MISSING",
      { publicationId: publication.id }
    );
  }

  if (PUBLICATION_STATUSES_REQUIRING_APPROVAL.includes(status)) {
    assertApproved(publication);
  }

  if (status === "rejected" && (publication.approvalDecision !== "rejected" || !isText(publication.approvalDecidedAt))) {
    throw new PublicationStateError(
      "A rejected publication must keep the refusal that produced it.",
      "PUBLICATION_DECISION_MISSING",
      { publicationId: publication.id, decision: publication.approvalDecision }
    );
  }

  if (status === "scheduled" && !isText(publication.scheduledAt)) {
    throw new PublicationStateError("A scheduled publication needs a date and time.", "PUBLICATION_SCHEDULE_MISSING", {
      publicationId: publication.id
    });
  }

  if (status === "published" && !isText(publication.publishedAt)) {
    throw new PublicationStateError(
      "A published publication must record when it went out.",
      "PUBLICATION_PUBLISHED_AT_MISSING",
      { publicationId: publication.id }
    );
  }

  if (status === "failed" && !isRecordedError(publication.error)) {
    throw new PublicationStateError("A failed publication must record why it failed.", "PUBLICATION_ERROR_MISSING", {
      publicationId: publication.id
    });
  }
}

function assertApproved(publication) {
  if (
    publication.approvalDecision !== "approved" ||
    !isText(publication.approvalId) ||
    !isText(publication.approvalDecidedAt)
  ) {
    throw new PublicationStateError(
      `Status ${publication.status} requires an approved decision recorded on the publication.`,
      "PUBLICATION_APPROVAL_REQUIRED",
      {
        publicationId: publication.id,
        status: publication.status,
        approvalId: publication.approvalId,
        decision: publication.approvalDecision
      }
    );
  }
}

function sanitizeChanges(changes, current, decisionAllowed) {
  const sanitized = {};

  for (const [field, value] of Object.entries(changes)) {
    if (DECISION_FIELDS.includes(field) && value !== null && !decisionAllowed) {
      throw new PublicationStateError(
        `${field} is recorded from an approval, not by a transition.`,
        "PUBLICATION_DECISION_NOT_TRANSITIONABLE",
        { publicationId: current.id, field }
      );
    }

    if (IMMUTABLE_PUBLICATION_FIELDS.includes(field)) {
      if (value === current[field]) {
        continue;
      }
      throw new PublicationStateError(`${field} cannot be changed by a transition.`, "PUBLICATION_FIELD_IMMUTABLE", {
        publicationId: current.id,
        field
      });
    }

    if (!MUTABLE_PUBLICATION_FIELDS.includes(field)) {
      throw new PublicationStateError(`Unknown publication field: ${field}`, "PUBLICATION_FIELD_UNKNOWN", {
        publicationId: current.id,
        field
      });
    }

    sanitized[field] = value;
  }

  if ("caption" in sanitized) {
    sanitized.caption = requireText(sanitized.caption, "caption");
  }
  if ("hashtags" in sanitized) {
    sanitized.hashtags = normalizeHashtags(sanitized.hashtags);
  }
  if ("scheduledAt" in sanitized) {
    sanitized.scheduledAt = optionalInstant(sanitized.scheduledAt, "scheduledAt");
  }
  if ("publishedAt" in sanitized) {
    sanitized.publishedAt = optionalInstant(sanitized.publishedAt, "publishedAt");
  }
  if ("approvalDecidedAt" in sanitized) {
    sanitized.approvalDecidedAt = optionalInstant(sanitized.approvalDecidedAt, "approvalDecidedAt");
  }
  if (
    "approvalDecision" in sanitized &&
    sanitized.approvalDecision !== null &&
    !["approved", "rejected"].includes(sanitized.approvalDecision)
  ) {
    throw new PublicationModelError(
      `Unknown approval decision: ${sanitized.approvalDecision}`,
      "PUBLICATION_DECISION_UNKNOWN",
      { publicationId: current.id, decision: sanitized.approvalDecision }
    );
  }
  if ("metadata" in sanitized) {
    sanitized.metadata = { ...current.metadata, ...sanitized.metadata };
  }

  return sanitized;
}

// The approval must be the one this publication is waiting on, decided, and
// requested for this publication. An approval granted for something else, or
// an object someone assembled, satisfies none of the three.
function assertDecidedApproval(publication, approval) {
  if (!approval || typeof approval !== "object" || !isText(approval.id)) {
    throw new PublicationStateError("An approval record is required.", "PUBLICATION_APPROVAL_MISSING", {
      publicationId: publication.id
    });
  }

  if (publication.approvalId !== approval.id || approval.metadata?.publicationId !== publication.id) {
    throw new PublicationStateError(
      "This approval was not requested for this publication.",
      "PUBLICATION_APPROVAL_MISMATCH",
      { publicationId: publication.id, approvalId: approval.id, awaited: publication.approvalId }
    );
  }

  if (!["approved", "rejected"].includes(approval.status)) {
    throw new PublicationStateError("This publication is still waiting for a decision.", "PUBLICATION_APPROVAL_PENDING", {
      publicationId: publication.id,
      approvalId: approval.id,
      status: approval.status
    });
  }
}

function normalizeInstants(publication) {
  const normalized = {};

  for (const field of INSTANT_FIELDS) {
    const value = publication[field];
    if (value !== null && value !== undefined && typeof value !== "string") {
      normalized[field] = optionalInstant(value, field);
    }
  }

  return Object.keys(normalized).length === 0 ? publication : Object.freeze({ ...publication, ...normalized });
}

function instantOf(value) {
  return value === null || value === undefined ? null : optionalInstant(value, "decidedAt");
}

function requirePublication(publication) {
  if (!publication || typeof publication !== "object" || !PUBLICATION_STATUSES.includes(publication.status)) {
    throw new PublicationStateError("A publication record is required.", "PUBLICATION_RECORD_INVALID", {
      status: publication?.status ?? null
    });
  }
  return publication;
}

function normalizeHashtags(hashtags) {
  if (!Array.isArray(hashtags)) {
    throw new PublicationModelError("hashtags must be an array.", "PUBLICATION_HASHTAGS_INVALID");
  }

  const normalized = [];
  for (const hashtag of hashtags) {
    if (typeof hashtag !== "string") {
      throw new PublicationModelError("A hashtag must be a non-empty string.", "PUBLICATION_HASHTAGS_INVALID", {
        hashtag
      });
    }

    // Stored without the leading "#" and without spaces. Networks read a
    // hashtag without regard to case, so "#HKids" and "hkids" are one tag here
    // too, kept in the spelling it was first written in.
    const cleaned = hashtag.trim().replace(/^#+/, "");
    if (cleaned.length === 0 || /\s/.test(cleaned)) {
      throw new PublicationModelError("A hashtag cannot be empty or contain spaces.", "PUBLICATION_HASHTAGS_INVALID", {
        hashtag
      });
    }
    if (!normalized.some((hashtag) => hashtag.toLowerCase() === cleaned.toLowerCase())) {
      normalized.push(cleaned);
    }
  }

  return Object.freeze(normalized);
}

function requireText(value, field) {
  if (typeof value !== "string") {
    throw new PublicationModelError(`${field} must be a string.`, "PUBLICATION_TEXT_INVALID", { field });
  }
  return value;
}

function optionalInstant(value, field) {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new PublicationModelError(`${field} must be an ISO date and time.`, "PUBLICATION_DATE_INVALID", {
      field,
      value
    });
  }
  return value;
}

function optionalKey(value, field) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PublicationModelError(`${field} must be a non-empty string when provided.`, "PUBLICATION_KEY_INVALID", {
      field
    });
  }
  return value;
}

function isRecordedError(error) {
  return Boolean(error) && typeof error === "object" && isText(error.code) && isText(error.message);
}

function isText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
