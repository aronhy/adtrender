BEGIN;
-- CreateTable
CREATE TABLE "AdDailySnapshot" (
    "id" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "scopeHash" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "queryCountry" TEXT,
    "queryLanguage" TEXT,
    "observationCount" INTEGER NOT NULL,
    "activeObservationCount" INTEGER NOT NULL DEFAULT 0,
    "inactiveObservationCount" INTEGER NOT NULL DEFAULT 0,
    "firstObservedAt" TIMESTAMP(3) NOT NULL,
    "lastObservedAt" TIMESTAMP(3) NOT NULL,
    "latestObservationId" TEXT NOT NULL,
    "latestSourceStatus" TEXT NOT NULL,
    "hasStateConflict" BOOLEAN NOT NULL DEFAULT false,
    "contentKey" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdDailySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdHistoryEvent" (
    "id" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "beforeObservationId" TEXT NOT NULL,
    "afterObservationId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "scopeHash" TEXT NOT NULL,

    CONSTRAINT "AdHistoryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdHistoryProjectionTask" (
    "adId" TEXT NOT NULL,
    "dataSourceId" TEXT NOT NULL,
    "revision" BIGINT NOT NULL DEFAULT 1,
    "completedRevision" BIGINT NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseVersion" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdHistoryProjectionTask_pkey" PRIMARY KEY ("adId")
);

-- CreateTable
CREATE TABLE "AdHistoryBackfillCursor" (
    "id" TEXT NOT NULL,
    "scopeAdIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastAdId" TEXT,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdHistoryBackfillCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdDailySnapshot_adId_day_scopeHash_idx" ON "AdDailySnapshot"("adId", "day", "scopeHash");

-- CreateIndex
CREATE UNIQUE INDEX "AdDailySnapshot_adId_day_timezone_scopeHash_key" ON "AdDailySnapshot"("adId", "day", "timezone", "scopeHash");

-- CreateIndex
CREATE INDEX "AdHistoryEvent_adId_observedAt_id_idx" ON "AdHistoryEvent"("adId", "observedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AdHistoryEvent_evidence_key" ON "AdHistoryEvent"("adId", "beforeObservationId", "afterObservationId", "type", "scopeHash");

-- CreateIndex
CREATE INDEX "AdHistoryProjectionTask_nextAttemptAt_leaseExpiresAt_idx" ON "AdHistoryProjectionTask"("nextAttemptAt", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdHistoryProjectionTask_adId_dataSourceId_key" ON "AdHistoryProjectionTask"("adId", "dataSourceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdObservation_id_adId_dataSourceId_key" ON "AdObservation"("id", "adId", "dataSourceId");

-- AddForeignKey
ALTER TABLE "AdDailySnapshot" ADD CONSTRAINT "AdDailySnapshot_adId_dataSourceId_fkey" FOREIGN KEY ("adId", "dataSourceId") REFERENCES "Ad"("id", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdDailySnapshot" ADD CONSTRAINT "AdDailySnapshot_latestObservationId_adId_dataSourceId_fkey" FOREIGN KEY ("latestObservationId", "adId", "dataSourceId") REFERENCES "AdObservation"("id", "adId", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdHistoryEvent" ADD CONSTRAINT "AdHistoryEvent_adId_dataSourceId_fkey" FOREIGN KEY ("adId", "dataSourceId") REFERENCES "Ad"("id", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdHistoryEvent" ADD CONSTRAINT "AdHistoryEvent_beforeObservationId_adId_dataSourceId_fkey" FOREIGN KEY ("beforeObservationId", "adId", "dataSourceId") REFERENCES "AdObservation"("id", "adId", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdHistoryEvent" ADD CONSTRAINT "AdHistoryEvent_afterObservationId_adId_dataSourceId_fkey" FOREIGN KEY ("afterObservationId", "adId", "dataSourceId") REFERENCES "AdObservation"("id", "adId", "dataSourceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdHistoryProjectionTask" ADD CONSTRAINT "AdHistoryProjectionTask_adId_dataSourceId_fkey" FOREIGN KEY ("adId", "dataSourceId") REFERENCES "Ad"("id", "dataSourceId") ON DELETE CASCADE ON UPDATE CASCADE;


-- This migration must run as a privileged migration identity, never as ingestion.
-- The trigger has only task-table privileges even when ingestion has no access there.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'saas_history_enqueue') THEN
    CREATE ROLE saas_history_enqueue NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'saas_history_enqueue'
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.member WHERE r.rolname = 'saas_history_enqueue') THEN
    RAISE EXCEPTION 'UNSAFE_HISTORY_ENQUEUE_ROLE';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO saas_history_enqueue;
GRANT SELECT, INSERT, UPDATE ON public."AdHistoryProjectionTask" TO saas_history_enqueue;
REVOKE ALL ON public."AdDailySnapshot", public."AdHistoryEvent", public."AdHistoryProjectionTask", public."AdHistoryBackfillCursor" FROM PUBLIC;

CREATE FUNCTION public.saas_enqueue_ad_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public."AdHistoryProjectionTask" ("adId", "dataSourceId", "revision", "completedRevision", "updatedAt", "nextAttemptAt")
  VALUES (NEW."adId", NEW."dataSourceId", 1, 0, clock_timestamp() AT TIME ZONE 'UTC', clock_timestamp() AT TIME ZONE 'UTC')
  ON CONFLICT ("adId") DO UPDATE SET
    "revision" = public."AdHistoryProjectionTask"."revision" + 1,
    "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC',
    "nextAttemptAt" = clock_timestamp() AT TIME ZONE 'UTC';
  RETURN NEW;
END $$;
-- Transfer requires CREATE, immediately revoked in the migration transaction.
GRANT CREATE ON SCHEMA public TO saas_history_enqueue;
ALTER FUNCTION public.saas_enqueue_ad_history() OWNER TO saas_history_enqueue;
REVOKE CREATE ON SCHEMA public FROM saas_history_enqueue;
REVOKE ALL ON FUNCTION public.saas_enqueue_ad_history() FROM PUBLIC;
CREATE TRIGGER ad_observation_history_enqueue AFTER INSERT ON public."AdObservation"
FOR EACH ROW EXECUTE FUNCTION public.saas_enqueue_ad_history();

ALTER TABLE public."AdDailySnapshot" ADD CONSTRAINT history_day_valid CHECK (
  "timezone" = 'Asia/Shanghai' AND "observationCount" > 0 AND "activeObservationCount" >= 0 AND "inactiveObservationCount" >= 0 AND "activeObservationCount" + "inactiveObservationCount" <= "observationCount" AND "latestSourceStatus" IN ('ACTIVE','INACTIVE','UNKNOWN')
  AND "scopeKind" IN ('DISCOVERY','HISTORY_RECHECK','MEDIA_REFRESH','LEGACY_UNKNOWN'));
ALTER TABLE public."AdHistoryEvent" ADD CONSTRAINT history_event_valid CHECK (
  "beforeObservationId" <> "afterObservationId" AND "type" IN ('STATUS_CHANGED','BODY_CHANGED','HEADLINE_CHANGED','CTA_CHANGED','LANDING_PAGE_CHANGED','MEDIA_CHANGED'));
ALTER TABLE public."AdHistoryProjectionTask" ADD CONSTRAINT history_task_valid CHECK (
  "revision" > 0 AND "completedRevision" >= 0 AND "leaseVersion" >= 0 AND "attempts" >= 0);
CREATE INDEX history_projection_pending ON public."AdHistoryProjectionTask" ("nextAttemptAt", "adId") WHERE "revision" > "completedRevision";
CREATE INDEX history_observation_replay ON public."AdObservation" ("adId", "observedAt", "id");

COMMIT;
