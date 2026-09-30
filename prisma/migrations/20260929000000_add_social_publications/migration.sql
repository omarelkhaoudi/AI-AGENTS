-- M2.1 social publications: the state of a post inside the platform.
-- Strictly additive: no table is dropped, renamed or altered, and no existing
-- row is read or written by this migration.
--
-- No foreign key is declared. The request and the approval are referenced by
-- id so this table can be created on a live database without locking or
-- altering the tables it points at.
--
-- The idempotency key is nullable and PostgreSQL allows many NULLs in a unique
-- index, so a publication that carries no business identity needs no
-- placeholder value.

-- CreateTable
CREATE TABLE "social_publications" (
    "id" TEXT NOT NULL,
    "requestId" TEXT,
    "channel" TEXT NOT NULL,
    "caption" TEXT NOT NULL DEFAULT '',
    "hashtags" JSONB,
    "scheduledAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'draft',
    "authorAgentId" TEXT,
    "createdById" TEXT,
    "idempotencyKey" TEXT,
    "approvalId" TEXT,
    "approvalDecision" TEXT,
    "approvalDecidedById" TEXT,
    "approvalDecidedAt" TIMESTAMP(3),
    "approvalReason" TEXT,
    "publishedAt" TIMESTAMP(3),
    "externalId" TEXT,
    "error" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "social_publications_idempotencyKey_key" ON "social_publications"("idempotencyKey");

-- CreateIndex
CREATE INDEX "social_publications_status_idx" ON "social_publications"("status");

-- CreateIndex
CREATE INDEX "social_publications_channel_idx" ON "social_publications"("channel");

-- CreateIndex
CREATE INDEX "social_publications_scheduledAt_idx" ON "social_publications"("scheduledAt");

-- CreateIndex
CREATE INDEX "social_publications_requestId_idx" ON "social_publications"("requestId");

-- CreateIndex
CREATE INDEX "social_publications_approvalId_idx" ON "social_publications"("approvalId");
