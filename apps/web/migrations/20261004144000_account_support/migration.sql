-- Add an account-scoped support inbox without changing tenant-owned feedback.
-- This migration does not update or delete existing user or business records.
CREATE TABLE "AccountSupportRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "AccountSupportRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AccountSupportRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "account_support_kind" CHECK ("kind" IN ('FEEDBACK', 'DELETION_REQUEST')),
  CONSTRAINT "account_support_body" CHECK (length(btrim("body")) BETWEEN 1 AND 10000),
  CONSTRAINT "account_support_resolution" CHECK (("status" = 'OPEN' AND "resolvedAt" IS NULL) OR ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL))
);

CREATE INDEX "AccountSupportRequest_userId_createdAt_idx" ON "AccountSupportRequest"("userId", "createdAt" DESC);
CREATE INDEX "AccountSupportRequest_status_createdAt_idx" ON "AccountSupportRequest"("status", "createdAt" DESC);
