-- Two-step sign-in: a six-digit code from an authenticator app, after the
-- password. Additive only: no column is dropped or renamed, no data is rewritten.

ALTER TABLE "UserCredential" ADD COLUMN "totpSecret" TEXT;
ALTER TABLE "UserCredential" ADD COLUMN "totpPendingSecret" TEXT;
ALTER TABLE "UserCredential" ADD COLUMN "totpLastStep" INTEGER;
ALTER TABLE "UserCredential" ADD COLUMN "totpEnabledAt" TIMESTAMP(3);
ALTER TABLE "UserCredential" ADD COLUMN "recoveryCodeHashes" JSONB NOT NULL DEFAULT '[]';
