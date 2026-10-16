ALTER TABLE "User" ADD COLUMN "firstAdSavedAt" TIMESTAMP(3);
-- Existing saves are a lower bound for the business milestone; these accounts
-- have no new ACCOUNT_CREATED attribution and cannot enter the growth funnel.
UPDATE "User" u SET "firstAdSavedAt" = s."firstSavedAt"
FROM (SELECT "savedByUserId", MIN("createdAt") AS "firstSavedAt" FROM "SavedAd" WHERE "savedByUserId" IS NOT NULL GROUP BY "savedByUserId") s
WHERE u.id = s."savedByUserId";

CREATE TABLE "GrowthVisit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "consentVersion" TEXT NOT NULL DEFAULT 'website-analytics.v2',
  "landingPath" TEXT NOT NULL,
  "source" TEXT, "medium" TEXT, "campaign" TEXT, "content" TEXT,
  "referrerOrigin" TEXT,
  "isTest" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "GrowthVisit_public_path" CHECK ("landingPath" IN ('/', '/pricing', '/help', '/terms', '/privacy')),
  CONSTRAINT "GrowthVisit_consent_version" CHECK ("consentVersion" = 'website-analytics.v2')
);
CREATE UNIQUE INDEX "GrowthVisit_tokenHash_key" ON "GrowthVisit"("tokenHash");
CREATE INDEX "GrowthVisit_createdAt_isTest_idx" ON "GrowthVisit"("createdAt", "isTest");
CREATE INDEX "GrowthVisit_expiresAt_idx" ON "GrowthVisit"("expiresAt");
CREATE TABLE "GrowthEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "visitId" TEXT NOT NULL REFERENCES "GrowthVisit"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT NOT NULL, "pathname" TEXT NOT NULL, "target" TEXT,
  "dedupeKey" TEXT NOT NULL,
  CONSTRAINT "GrowthEvent_public_path" CHECK ("pathname" IN ('/', '/pricing', '/help', '/terms', '/privacy')),
  CONSTRAINT "GrowthEvent_name_target" CHECK (("name" = 'PAGE_VIEW' AND "target" IS NULL) OR ("name" = 'CTA_CLICK' AND "target" IS NOT NULL AND "target" IN ('signup', 'login', 'pricing')))
);
CREATE UNIQUE INDEX "GrowthEvent_dedupeKey_key" ON "GrowthEvent"("dedupeKey");
CREATE INDEX "GrowthEvent_visitId_name_createdAt_idx" ON "GrowthEvent"("visitId", "name", "createdAt");
CREATE TABLE "ConversionEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "visitId" TEXT NOT NULL REFERENCES "GrowthVisit"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "name" TEXT NOT NULL,
  CONSTRAINT "ConversionEvent_name" CHECK ("name" IN ('ACCOUNT_CREATED', 'REGISTRATION_VERIFIED', 'FIRST_AD_SAVED'))
);
CREATE UNIQUE INDEX "ConversionEvent_userId_name_key" ON "ConversionEvent"("userId", "name");
CREATE INDEX "ConversionEvent_visitId_name_idx" ON "ConversionEvent"("visitId", "name");
