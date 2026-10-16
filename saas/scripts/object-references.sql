-- Inventory from the caller's transaction snapshot. Never silently omit a READY
-- row with a missing storage key: the joint-backup verifier must reject it.
-- Legacy imports may have no AdObservation. Their original JSON digest must
-- therefore come from the archived receipt on CollectionRun itself. A missing
-- or inconsistent receipt emits invalid metadata, never an unverified null.
WITH legacy_source_evidence AS (
  SELECT id, "idempotencyKey", "evidenceReference", coverage,
    coverage -> 'sourceEvidenceArchive' AS receipt,
    (SELECT value FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(coverage #> '{sourceEvidenceArchive,objects}') = 'array'
        THEN coverage #> '{sourceEvidenceArchive,objects}' ELSE '[]'::jsonb END
    ) WHERE value ->> 'kind' = 'SOURCE') AS source
  FROM public."CollectionRun"
  WHERE "adapterVersion" = 'legacy-public-v1' AND "evidenceReference" LIKE 's3:%'
), legacy_source_metadata AS (
  SELECT id, CASE WHEN receipt ->> 'schemaVersion' = '1'
    AND receipt ->> 'classification' = 'public'
    AND receipt ->> 'runId' = id
    AND receipt ->> 'manifestHash' ~ '^[a-f0-9]{64}$'
    AND receipt ->> 'publicPlanHash' = coverage ->> 'planHash'
    AND receipt ->> 'inventoryManifestHash' = coverage ->> 'inventoryManifestHash'
    AND "idempotencyKey" = 'legacy-public:' || (receipt ->> 'inputSha256')
    AND source ->> 'sha256' = receipt ->> 'inputSha256'
    AND source ->> 'sha256' ~ '^[a-f0-9]{64}$'
    AND 's3:' || (source ->> 'key') = "evidenceReference"
    AND source ->> 'mimeType' = 'application/json'
    AND jsonb_typeof(source -> 'sizeBytes') = 'number'
    AND source ->> 'sizeBytes' ~ '^[1-9][0-9]{0,8}$'
    THEN source END AS metadata
  FROM legacy_source_evidence
)
SELECT COALESCE(json_agg(json_build_object(
  'kind', kind,
  'id', id,
  'reference', reference,
  'sha256', sha256,
  'sizeBytes', size_bytes,
  'mimeType', mime_type
) ORDER BY kind COLLATE "C", id COLLATE "C"), '[]'::json)
FROM (
  SELECT 'MediaObject'::text AS kind, id, "storageKey" AS reference, sha256,
    "sizeBytes"::text AS size_bytes, "mimeType" AS mime_type
  FROM public."MediaObject" WHERE status = 'READY'
  UNION ALL
  SELECT 'PrivateFile', id, "storageKey", sha256, "sizeBytes"::text, "mimeType"
  FROM public."PrivateFile" WHERE status = 'READY'
  UNION ALL
  SELECT 'CollectionRun', run.id, "evidenceReference",
    CASE WHEN legacy.id IS NOT NULL THEN COALESCE(metadata ->> 'sha256', 'INVALID_LEGACY_SOURCE_RECEIPT') END,
    CASE WHEN legacy.id IS NOT NULL THEN COALESCE(metadata ->> 'sizeBytes', 'INVALID_LEGACY_SOURCE_RECEIPT') END,
    'application/json'
  FROM public."CollectionRun" AS run LEFT JOIN legacy_source_metadata AS legacy ON legacy.id = run.id
  WHERE "evidenceReference" IS NOT NULL
  UNION ALL
  SELECT 'RunItem', id, "evidenceReference", "evidenceSha256", NULL::text, 'application/json'
  FROM public."RunItem" WHERE "evidenceReference" IS NOT NULL
  UNION ALL
  SELECT 'AdObservation', id, "evidenceReference", "evidenceSha256", NULL::text, 'application/json'
  FROM public."AdObservation" WHERE "evidenceReference" IS NOT NULL
) AS object_references;
