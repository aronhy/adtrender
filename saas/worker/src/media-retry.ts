import { adapterPendingRules } from '../../app/src/media/source-policy';

export const MEDIA_MAX_DOWNLOAD_ATTEMPTS = 5;
export const MEDIA_RETRYABLE_ERRORS = ['MEDIA_NETWORK_FAILED', 'MEDIA_TIMEOUT', 'MEDIA_HTTP_FAILED', 'MEDIA_STORAGE_FAILED'] as const;
const retryDelays = [30_000, 120_000, 480_000, 1_800_000] as const;

/** The count is persisted with the failed transfer, so restarts cannot reset its budget. */
export function nextMediaDownloadAttempt(errorCode: string, attempts: number, now: Date): Date | null {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts >= MEDIA_MAX_DOWNLOAD_ATTEMPTS
    || !(MEDIA_RETRYABLE_ERRORS as readonly string[]).includes(errorCode)) return null;
  return new Date(now.valueOf() + retryDelays[attempts - 1]);
}

// Meta keeps its existing host policy. These initial URL candidates still pass
// isMediaUrlAllowed before a transfer; redirect-only hosts are never candidates.
const legacyMetaRules = ['IMAGE', 'VIDEO', 'UNKNOWN'].map(type => ({
  sourceKey: 'meta_ad_library', type,
  urlPattern: "^https://([a-z0-9-]+[.])*(facebook[.]com|fbcdn[.]net|cdninstagram[.]com)/[^[:space:]\\\\]*$",
}));

export function mediaEligibilityParameters() {
  return [JSON.stringify(adapterPendingRules), JSON.stringify([...adapterPendingRules, ...legacyMetaRules]),
    JSON.stringify(MEDIA_RETRYABLE_ERRORS), MEDIA_MAX_DOWNLOAD_ATTEMPTS] as const;
}

// Fixed SQL shared by the background worker and the bounded recovery command.
// $1/$2 are JSON policy rules, $3 is the JSON transient error list, $4 the budget.
export const MEDIA_DOWNLOAD_ELIGIBILITY_SQL = `
  m."storageKey" IS NULL AND m."downloadAttempts" < $4 AND (
    m.status='PENDING' OR (
      m.status='UNAVAILABLE' AND m."errorCode"='PLATFORM_MEDIA_ADAPTER_PENDING'
      AND EXISTS (SELECT 1 FROM jsonb_to_recordset($1::jsonb)
        AS policy("sourceKey" text,type text,"urlPattern" text)
        WHERE policy."sourceKey"=s.key AND policy.type=m.type AND m."sourceUrl" ~ policy."urlPattern")
    ) OR (
      m.status='FAILED' AND (
        (m."errorCode" IN (SELECT jsonb_array_elements_text($3::jsonb))
          AND ((m."downloadAttempts"=0 AND m."nextDownloadAttemptAt" IS NULL)
            OR m."nextDownloadAttemptAt"<=CURRENT_TIMESTAMP))
        OR (m."errorCode" IN ('MEDIA_URL_REJECTED','MEDIA_TOO_LARGE') AND m."downloadAttempts"=0
          AND EXISTS (SELECT 1 FROM jsonb_to_recordset($2::jsonb)
            AS policy("sourceKey" text,type text,"urlPattern" text)
            WHERE policy."sourceKey"=s.key AND policy.type=m.type AND m."sourceUrl" ~ policy."urlPattern"))
      )
    )
  )`;
