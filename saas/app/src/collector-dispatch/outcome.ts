type Outcome = 'HAS_RESULTS' | 'RELIABLE_NO_RESULTS' | 'PARTIAL' | 'RATE_LIMITED' | 'TIMEOUT' | 'FAILED' | 'IDENTITY_FOUND';
/** Native error/coverage facts take precedence over a superficially empty batch. */
export function classifyNativeOutcome(batch: any, run: { fetchedCount: number; errorCode?: string | null; restrictionReason?: string | null; coverage?: any }): { outcome: Outcome; exhausted: boolean; partial: boolean; restrictionReason: string | null } {
  const reasons = [batch.errorCode, batch.restrictionReason, batch.coverage?.reason, run.errorCode, run.restrictionReason].filter(v => typeof v === 'string').join(' ').toUpperCase();
  const hasAds = run.fetchedCount > 0 || (Array.isArray(batch.ads) && batch.ads.length > 0);
  let outcome: Outcome;
  if (/429|RATE_LIMIT/.test(reasons)) outcome = 'RATE_LIMITED';
  else if (/403|CHALLENGE|CAPTCHA|LOGIN_REQUIRED|ACCESS_BLOCKED|FORBIDDEN/.test(reasons)) outcome = 'FAILED';
  else if (/TIMEOUT|TIME_BUDGET/.test(reasons)) outcome = 'TIMEOUT';
  else if (batch.status === 'FAILED') outcome = 'FAILED';
  else if (batch.status === 'PARTIAL') outcome = 'PARTIAL';
  else if (hasAds) outcome = 'HAS_RESULTS';
  else if (batch.sourceKey === 'google_ads_transparency' && batch.query?.kind === 'DISCOVER' && ((Array.isArray(batch.advertisers) && batch.advertisers.length > 0) || Number(run.coverage?.advertisersDiscovered ?? batch.coverage?.advertisersDiscovered) > 0)) outcome = 'IDENTITY_FOUND';
  else if (['SUCCESS', 'SUCCEEDED', 'NO_RESULTS'].includes(batch.status) && ['EXPLICIT_NO_RESULTS', 'SOURCE_EXPLICIT_NO_RESULTS', 'SOURCE_NO_RESULTS'].includes(batch.coverage?.reason)) outcome = 'RELIABLE_NO_RESULTS';
  else outcome = 'PARTIAL';
  return { outcome, exhausted: batch.coverage?.exhausted === true && ['HAS_RESULTS', 'RELIABLE_NO_RESULTS'].includes(outcome), partial: hasAds && !['HAS_RESULTS'].includes(outcome), restrictionReason: ['RATE_LIMITED', 'TIMEOUT', 'FAILED'].includes(outcome) ? String(batch.errorCode ?? run.restrictionReason ?? run.errorCode ?? batch.coverage?.reason ?? outcome) : null };
}
