CREATE TABLE "AuthLink" (
  id TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "tokenHash" TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('VERIFY','RESET')),
  "recipientEmail" TEXT NOT NULL,
  "encryptedPayload" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "AuthLink_tokenHash_key" ON "AuthLink"("tokenHash");
CREATE INDEX "AuthLink_expiresAt_idx" ON "AuthLink"("expiresAt");
