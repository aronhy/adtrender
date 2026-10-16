-- One-time OAuth exchange receipts; no raw JWT, password or new session store.
CREATE TABLE "OAuthCodeUse" (
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "authId" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'GOOGLE',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OAuthCodeUse_pkey" PRIMARY KEY ("tokenHash"),
  CONSTRAINT "OAuthCodeUse_tokenHash_check" CHECK ("tokenHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "OAuthCodeUse_source_check" CHECK ("source" = 'GOOGLE'),
  CONSTRAINT "OAuthCodeUse_expiry_check" CHECK ("expiresAt" > "consumedAt"),
  CONSTRAINT "OAuthCodeUse_authId_check" CHECK (length("authId") BETWEEN 1 AND 100),
  CONSTRAINT "OAuthCodeUse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "OAuthCodeUse_expiresAt_idx" ON "OAuthCodeUse"("expiresAt");
CREATE INDEX "OAuthCodeUse_userId_idx" ON "OAuthCodeUse"("userId");
