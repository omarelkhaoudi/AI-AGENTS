-- Lot 6 deduplication: one business event, one request.
-- Additive only: no column is dropped or renamed, no data is rewritten.
--
-- The column is nullable and PostgreSQL allows many NULLs in a unique index, so
-- every existing row and every request that carries no business identity keeps
-- working with no backfill and no placeholder value to invent.

ALTER TABLE "Request" ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Request_idempotencyKey_key" ON "Request"("idempotencyKey");
