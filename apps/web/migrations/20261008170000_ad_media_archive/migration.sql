BEGIN;

-- Stored public bytes are version evidence, not a daily observation. In
-- particular recordedAt is never reconstructed from an old observation date.
CREATE TABLE public."ArchiveMediaCapture" (
  id TEXT NOT NULL DEFAULT pg_catalog.gen_random_uuid()::text,
  "adId" TEXT NOT NULL,
  "mediaObjectId" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  type TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" BIGINT NOT NULL,
  "downloadedAt" TIMESTAMP(3),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC'),
  "captureKind" TEXT NOT NULL,
  CONSTRAINT "ArchiveMediaCapture_pkey" PRIMARY KEY (id),
  CONSTRAINT archive_media_capture_valid CHECK (
    "adId" <> '' AND "mediaObjectId" <> '' AND "sourceUrl" <> ''
    AND "objectKey" ~ '^public-media/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND sha256 ~ '^[a-f0-9]{64}$' AND "mimeType" <> '' AND "sizeBytes" > 0
    AND "captureKind" IN ('READY_CAPTURE','READY_BEFORE_CHANGE_CAPTURE','LEGACY_READY_CAPTURE')),
  -- No FK to mutable MediaObject: deleting/reusing its row must not erase bytes
  -- evidence. Ad identity itself cannot be changed underneath an immutable row.
  CONSTRAINT "ArchiveMediaCapture_adId_fkey" FOREIGN KEY ("adId")
    REFERENCES public."Ad"(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "ArchiveMediaCapture_adId_sourceUrl_sha256_key"
  ON public."ArchiveMediaCapture" ("adId", "sourceUrl", sha256);
CREATE INDEX "ArchiveMediaCapture_adId_recordedAt_id_idx"
  ON public."ArchiveMediaCapture" ("adId", "recordedAt", id);
CREATE INDEX "ArchiveMediaCapture_objectKey_idx" ON public."ArchiveMediaCapture" ("objectKey");

-- Privileged migration identity only. The downloader/collector gets no new
-- direct table access or role membership from this migration.
DO $$
DECLARE capture_role oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='saas_media_archive_capture') THEN
    CREATE ROLE saas_media_archive_capture NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  SELECT oid INTO capture_role FROM pg_catalog.pg_roles WHERE rolname='saas_media_archive_capture';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid=capture_role
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=capture_role OR roleid=capture_role) THEN
    RAISE EXCEPTION 'UNSAFE_MEDIA_ARCHIVE_CAPTURE_ROLE';
  END IF;
END $$;
REVOKE ALL ON public."ArchiveMediaCapture" FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO saas_media_archive_capture;
GRANT INSERT ON public."ArchiveMediaCapture" TO saas_media_archive_capture;

CREATE FUNCTION public.saas_capture_ad_media() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE media public."MediaObject"%ROWTYPE;
BEGIN
  -- Capture OLD first so resetting/replacing metadata cannot lose the previous
  -- READY value, including rows that existed before a trigger was installed.
  IF TG_OP IN ('UPDATE','DELETE') THEN
    media := OLD;
    IF media.status='READY'
      AND media."storageKey" ~ '^public-media/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      AND media.sha256 ~ '^[a-f0-9]{64}$' AND media."mimeType" IS NOT NULL AND media."mimeType"<>'' AND media."sizeBytes">0 THEN
      INSERT INTO public."ArchiveMediaCapture" ("adId","mediaObjectId","sourceUrl","objectKey",sha256,type,"mimeType","sizeBytes","downloadedAt","recordedAt","captureKind")
      VALUES (media."adId",media.id,media."sourceUrl",media."storageKey",media.sha256,media.type,media."mimeType",media."sizeBytes",media."downloadedAt",clock_timestamp() AT TIME ZONE 'UTC','READY_BEFORE_CHANGE_CAPTURE')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    media := NEW;
    IF media.status='READY'
      AND media."storageKey" ~ '^public-media/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
      AND media.sha256 ~ '^[a-f0-9]{64}$' AND media."mimeType" IS NOT NULL AND media."mimeType"<>'' AND media."sizeBytes">0 THEN
      INSERT INTO public."ArchiveMediaCapture" ("adId","mediaObjectId","sourceUrl","objectKey",sha256,type,"mimeType","sizeBytes","downloadedAt","recordedAt","captureKind")
      VALUES (media."adId",media.id,media."sourceUrl",media."storageKey",media.sha256,media.type,media."mimeType",media."sizeBytes",media."downloadedAt",clock_timestamp() AT TIME ZONE 'UTC','READY_CAPTURE')
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
GRANT CREATE ON SCHEMA public TO saas_media_archive_capture;
ALTER FUNCTION public.saas_capture_ad_media() OWNER TO saas_media_archive_capture;
REVOKE CREATE ON SCHEMA public FROM saas_media_archive_capture;
REVOKE ALL ON FUNCTION public.saas_capture_ad_media() FROM PUBLIC;
CREATE TRIGGER media_archive_capture BEFORE INSERT OR UPDATE OR DELETE ON public."MediaObject"
FOR EACH ROW EXECUTE FUNCTION public.saas_capture_ad_media();

CREATE FUNCTION public.saas_reject_media_capture_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_MEDIA_CAPTURE' USING ERRCODE='55000';
END $$;
REVOKE ALL ON FUNCTION public.saas_reject_media_capture_mutation() FROM PUBLIC;
CREATE TRIGGER immutable_media_capture_rows BEFORE UPDATE OR DELETE ON public."ArchiveMediaCapture"
FOR EACH ROW EXECUTE FUNCTION public.saas_reject_media_capture_mutation();
CREATE TRIGGER immutable_media_capture_truncate BEFORE TRUNCATE ON public."ArchiveMediaCapture"
FOR EACH STATEMENT EXECUTE FUNCTION public.saas_reject_media_capture_mutation();

-- The trigger installation locks mutable media during this transaction. This
-- seed preserves known downloadedAt (including NULL when unknown) and records
-- now as the archive capture time. It writes no observations or daily history.
INSERT INTO public."ArchiveMediaCapture" ("adId","mediaObjectId","sourceUrl","objectKey",sha256,type,"mimeType","sizeBytes","downloadedAt","recordedAt","captureKind")
SELECT "adId",id,"sourceUrl","storageKey",sha256,type,"mimeType","sizeBytes","downloadedAt",clock_timestamp() AT TIME ZONE 'UTC','LEGACY_READY_CAPTURE'
FROM public."MediaObject"
WHERE status='READY'
  AND "storageKey" ~ '^public-media/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
  AND sha256 ~ '^[a-f0-9]{64}$' AND "mimeType" IS NOT NULL AND "mimeType"<>'' AND "sizeBytes">0
ON CONFLICT DO NOTHING;

-- Archive retention database guard. This protection survives application/worker
-- rollback: the older retention worker must not delete already archived bytes.
-- Clear only stored-object expiry, never a source URL or source-expiry field.
-- This runs before the guard is installed so preexisting expired tombstones
-- with archive evidence can also have stale expiry metadata removed safely.
UPDATE public."MediaObject" m SET "expiresAt"=NULL
WHERE m."expiresAt" IS NOT NULL
  AND EXISTS (SELECT 1 FROM public."ArchiveMediaCapture" a WHERE a."objectKey"=m."storageKey");

DO $$
DECLARE guard_role oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='saas_media_archive_guard') THEN
    CREATE ROLE saas_media_archive_guard NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  SELECT oid INTO guard_role FROM pg_catalog.pg_roles WHERE rolname='saas_media_archive_guard';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE oid=guard_role
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=guard_role OR roleid=guard_role) THEN
    RAISE EXCEPTION 'UNSAFE_MEDIA_ARCHIVE_GUARD_ROLE';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO saas_media_archive_guard;
REVOKE ALL ON public."ArchiveMediaCapture" FROM saas_media_archive_guard;
GRANT SELECT ON public."ArchiveMediaCapture" TO saas_media_archive_guard;

CREATE FUNCTION public.saas_guard_archived_media() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE old_archived boolean := false; new_archived boolean := false; new_ready boolean := false;
BEGIN
  IF TG_OP='UPDATE' THEN
    SELECT EXISTS (SELECT 1 FROM public."ArchiveMediaCapture" WHERE "objectKey"=OLD."storageKey") INTO old_archived;
  END IF;
  SELECT EXISTS (SELECT 1 FROM public."ArchiveMediaCapture" WHERE "objectKey"=NEW."storageKey") INTO new_archived;
  new_ready := NEW.status='READY'
    AND NEW."storageKey" ~ '^public-media/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
    AND NEW.sha256 ~ '^[a-f0-9]{64}$' AND NEW."mimeType" IS NOT NULL AND NEW."mimeType"<>'' AND NEW."sizeBytes">0;
  -- Check both sides: clearing/replacing the key in the same mutation may not
  -- hide the archived OLD object from a worker about to call storage.delete.
  IF NEW.status IN ('EXPIRED','DELETED') AND (old_archived OR new_archived) THEN
    RAISE EXCEPTION 'ARCHIVED_MEDIA_PROTECTED' USING ERRCODE='55000';
  END IF;
  IF new_ready OR old_archived OR new_archived THEN NEW."expiresAt" := NULL; END IF;
  RETURN NEW;
END $$;
GRANT CREATE ON SCHEMA public TO saas_media_archive_guard;
ALTER FUNCTION public.saas_guard_archived_media() OWNER TO saas_media_archive_guard;
REVOKE CREATE ON SCHEMA public FROM saas_media_archive_guard;
REVOKE ALL ON FUNCTION public.saas_guard_archived_media() FROM PUBLIC;
-- PostgreSQL executes same-kind row triggers by name: capture precedes guard,
-- so the SELECT-only guard can see a freshly inserted capture in this same tx.
CREATE TRIGGER media_archive_guard BEFORE INSERT OR UPDATE ON public."MediaObject"
FOR EACH ROW EXECUTE FUNCTION public.saas_guard_archived_media();

COMMIT;
