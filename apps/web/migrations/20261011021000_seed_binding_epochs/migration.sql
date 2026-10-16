BEGIN;

-- Content revision is distinct from the publication epoch. Restoring unchanged
-- seed content creates a new historical range, never reopens a closed row.
-- DropIndex
DROP INDEX "SeedQueryBinding_queryId_seedId_ownerRevision_key";

-- DropIndex
DROP INDEX "SeedQueryBinding_queryId_scanPlanId_ownerRevision_key";

-- DropIndex
DROP INDEX "SeedQueryBinding_queryId_legacyOwnerKey_ownerRevision_key";

-- CreateIndex
CREATE UNIQUE INDEX "SeedQueryBinding_queryId_seedId_ownerRevision_validFromRevi_key" ON "SeedQueryBinding"("queryId", "seedId", "ownerRevision", "validFromRevision");

-- CreateIndex
CREATE UNIQUE INDEX "SeedQueryBinding_queryId_scanPlanId_ownerRevision_validFrom_key" ON "SeedQueryBinding"("queryId", "scanPlanId", "ownerRevision", "validFromRevision");

-- CreateIndex
CREATE UNIQUE INDEX "SeedQueryBinding_queryId_legacyOwnerKey_ownerRevision_valid_key" ON "SeedQueryBinding"("queryId", "legacyOwnerKey", "ownerRevision", "validFromRevision");

CREATE UNIQUE INDEX seed_binding_current_seed ON "SeedQueryBinding" ("queryId", "seedId") WHERE "ownerKind"='SEED' AND "validToRevision" IS NULL;
CREATE UNIQUE INDEX seed_binding_current_scan_plan ON "SeedQueryBinding" ("queryId", "scanPlanId") WHERE "ownerKind"='SCAN_PLAN' AND "validToRevision" IS NULL;
CREATE UNIQUE INDEX seed_binding_current_legacy ON "SeedQueryBinding" ("queryId", "legacyOwnerKey") WHERE "ownerKind"='LEGACY' AND "validToRevision" IS NULL;

CREATE FUNCTION public.saas_guard_seed_binding_history() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_SEED_BINDING_HISTORY' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND ((NEW."queryId",NEW."ownerKind",NEW."seedId",NEW."scanPlanId",NEW."legacyOwnerKey",NEW."ownerRevision",NEW."validFromRevision",NEW."purposeSnapshot")
    IS DISTINCT FROM (OLD."queryId",OLD."ownerKind",OLD."seedId",OLD."scanPlanId",OLD."legacyOwnerKey",OLD."ownerRevision",OLD."validFromRevision",OLD."purposeSnapshot")
    OR (OLD."validToRevision" IS NOT NULL AND NEW."validToRevision" IS DISTINCT FROM OLD."validToRevision")) THEN
    RAISE EXCEPTION 'IMMUTABLE_SEED_BINDING_HISTORY' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.saas_guard_seed_binding_history() FROM PUBLIC;
CREATE TRIGGER seed_binding_history BEFORE UPDATE OR DELETE ON "SeedQueryBinding" FOR EACH ROW EXECUTE FUNCTION public.saas_guard_seed_binding_history();
COMMIT;

