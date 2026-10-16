-- Every active organization has an owner, including writes outside application code.
CREATE FUNCTION saas_require_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org_id text;
BEGIN
  IF TG_TABLE_NAME = 'Organization' THEN
    org_id := COALESCE(NEW.id, OLD.id);
  ELSE
    org_id := COALESCE(NEW."organizationId", OLD."organizationId");
  END IF;
  PERFORM 1 FROM "Organization" WHERE id=org_id FOR UPDATE;
  IF TG_TABLE_NAME = 'OrganizationMember' AND TG_OP='UPDATE' THEN
    IF OLD."organizationId" IS DISTINCT FROM NEW."organizationId" THEN
      RAISE EXCEPTION 'MEMBERSHIP_REPARENT_FORBIDDEN' USING ERRCODE='23514';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM "Organization" WHERE id=org_id AND status='ACTIVE')
    AND NOT EXISTS (SELECT 1 FROM "OrganizationMember" WHERE "organizationId"=org_id AND role='OWNER') THEN
    RAISE EXCEPTION 'LAST_OWNER_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER organization_owner_required AFTER INSERT OR UPDATE ON "Organization"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION saas_require_owner();
CREATE CONSTRAINT TRIGGER membership_owner_required AFTER INSERT OR UPDATE OR DELETE ON "OrganizationMember"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION saas_require_owner();
ALTER TABLE "OrganizationMember" ADD CONSTRAINT org_member_role CHECK (role IN ('OWNER','ADMIN','MEMBER'));
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT workspace_member_role CHECK (role IN ('EDITOR','VIEWER'));
ALTER TABLE "Invitation" ADD CONSTRAINT invitation_scope CHECK (("workspaceId" IS NULL AND "workspaceRole" IS NULL) OR ("workspaceId" IS NOT NULL AND "workspaceRole" IN ('EDITOR','VIEWER')));
ALTER TABLE "Invitation" ADD CONSTRAINT invitation_role CHECK (role IN ('ADMIN','MEMBER'));
ALTER TABLE "Entitlement" ADD CONSTRAINT entitlement_nonnegative CHECK ("limit">=0 AND used>=0 AND reserved>=0);
ALTER TABLE "UsageLedger" ADD CONSTRAINT ledger_valid CHECK (quantity>0 AND status IN ('RESERVED','SETTLED','RELEASED'));
ALTER TABLE "CollectionRun" ADD CONSTRAINT run_valid CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELED') AND attempt>=0 AND "leaseVersion">=0);
ALTER TABLE "CollectionTask" ADD CONSTRAINT collection_limits CHECK ("maxItems">0 AND "maxItems"<=20 AND "maxAttempts">0 AND "maxAttempts"<=5);
ALTER TABLE "CollectionTask" ALTER COLUMN "maxItems" SET DEFAULT 20;
ALTER TABLE "AnalysisJob" ADD CONSTRAINT analysis_valid CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELED') AND attempt>=0 AND "leaseVersion">=0);
ALTER TABLE "PrivateFile" ADD CONSTRAINT private_file_size CHECK ("sizeBytes">=0);
ALTER TABLE "AuditEvent" ADD CONSTRAINT audit_scope CHECK ("workspaceId" IS NULL OR "organizationId" IS NOT NULL);
-- Text search stays in PostgreSQL; never an industry-specific score.
CREATE INDEX ad_content_search ON "Ad" USING GIN (to_tsvector('simple',coalesce(body,'') || ' ' || coalesce(headline,'')));
