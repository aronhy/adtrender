-- Existing plans remain unpublished. No existing prices, quotas or subscriptions change.
ALTER TABLE "PlanVersion"
  ADD COLUMN "verifiedProviderMode" TEXT,
  ADD COLUMN "publicConfirmedAt" TIMESTAMP(3),
  ADD CONSTRAINT "PlanVersion_verifiedProviderMode_check"
    CHECK ("verifiedProviderMode" IS NULL OR "verifiedProviderMode" IN ('TEST', 'LIVE')),
  ADD CONSTRAINT "PlanVersion_publicConfirmedAt_check"
    CHECK ("publicConfirmedAt" IS NULL OR (
      "verifiedProviderMode" IS NOT DISTINCT FROM 'LIVE'
      AND "providerPriceId" IS NOT NULL
      AND "currency" IS NOT NULL AND "priceMinor" IS NOT NULL
      AND "priceMinor" > 0 AND "billingInterval" = 'MONTH'
    ));
