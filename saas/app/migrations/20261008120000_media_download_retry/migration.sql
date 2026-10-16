-- Add bounded retry bookkeeping without changing source facts or object retention.
ALTER TABLE "MediaObject"
  ADD COLUMN "downloadAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastDownloadAttemptAt" TIMESTAMP(3),
  ADD COLUMN "nextDownloadAttemptAt" TIMESTAMP(3);

ALTER TABLE "MediaObject" ADD CONSTRAINT "MediaObject_download_attempts_bounds"
  CHECK ("downloadAttempts" >= 0 AND "downloadAttempts" <= 5);

CREATE INDEX "MediaObject_status_nextDownloadAttemptAt_idx"
  ON "MediaObject"("status", "nextDownloadAttemptAt");
