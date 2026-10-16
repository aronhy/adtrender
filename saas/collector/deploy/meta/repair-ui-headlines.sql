-- Correct only this service's parsed UI labels; preserve raw observations.
BEGIN;
WITH corrected AS (
 UPDATE public."Ad" SET
  "fieldProvenance"=jsonb_set("fieldProvenance",'{headline,value}','null'::jsonb)||jsonb_build_object('headlineCorrection',jsonb_build_object('reason','SOURCE_UI_LABEL_NOT_CREATIVE','previousValue',headline,'correctedAt',now())),
  headline=NULL,"updatedAt"=now()
 WHERE "fieldProvenance"#>>'{sourceAdId,parserVersion}'='meta-service-dom-1'
 AND headline IN ('Platforms','EU transparency','This ad has multiple versions')
 RETURNING id
), audit AS (
 INSERT INTO public."AuditEvent"(id,action,"targetType",metadata)
 SELECT gen_random_uuid()::text,'META_UI_HEADLINE_CORRECTED','Ad',jsonb_build_object('count',count(*),'reason','SOURCE_UI_LABEL_NOT_CREATIVE') FROM corrected
 RETURNING id
)
SELECT count(*) AS corrected_headlines FROM corrected;
COMMIT;
