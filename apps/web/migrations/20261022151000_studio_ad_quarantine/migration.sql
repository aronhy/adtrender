ALTER TABLE "Ad" ADD COLUMN "quarantinedAt" TIMESTAMP(3);
CREATE INDEX "Ad_quarantinedAt_idx" ON "Ad"("quarantinedAt");
