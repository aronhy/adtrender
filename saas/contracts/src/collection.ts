/** Public source facts only. Null means unavailable from this observation. */
export type CollectionMediaType = 'image' | 'video';
export type CollectionAdStatus = 'active' | 'inactive' | 'unknown';
export interface CollectionQuery {
  keyword: string;
  country: string;
  status: 'active' | 'inactive' | 'all';
  mediaType: CollectionMediaType | 'all';
  limit: number;
}
export interface ParsedMedia { type: CollectionMediaType; url: string; posterUrl: string | null }
export interface ParsedAd {
  source: 'meta'; sourceAdId: string; sourceUrl: string;
  advertiserName: string | null; advertiserPageUrl: string | null;
  /** Observed account avatar; never a creative image or an inferred website icon. */
  advertiserAvatarUrl?: string | null;
  body: string | null; headline: string | null; description: string | null;
  displayUrl: string | null; cta: string | null; landingPageUrl: string | null;
  status: CollectionAdStatus; sourceStatusText: string | null;
  startDate: string | null; endDate: string | null;
  platforms: string[] | null;
  /** Query context, not a claim about every country targeted by the source ad. */
  queryCountry: string;
  media: ParsedMedia[];
}
export type CollectionOutcomeStatus = 'success' | 'no-results' | 'partial' | 'restricted' | 'failed' | 'cancelled';
export interface CollectionOutcome {
  status: CollectionOutcomeStatus; ads: ParsedAd[];
  errorCode: string | null; retryable: boolean;
  observedCardCount: number; parsedAdCount: number; parserVersion: string; collectedAt: string;
}
export function validateCollectionQuery(value: unknown): CollectionQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_COLLECTION_QUERY');
  const q = value as Record<string, unknown>;
  if (typeof q.keyword !== 'string' || !q.keyword.trim() || q.keyword.trim().length > 200 || /[\u0000-\u001f]/.test(q.keyword)) throw new Error('INVALID_COLLECTION_KEYWORD');
  if (typeof q.country !== 'string' || !/^(?:[A-Z]{2}|ALL)$/.test(q.country)) throw new Error('INVALID_COLLECTION_COUNTRY');
  if (!['active','inactive','all'].includes(String(q.status))) throw new Error('INVALID_COLLECTION_STATUS');
  if (!['image','video','all'].includes(String(q.mediaType))) throw new Error('INVALID_COLLECTION_MEDIA_TYPE');
  if (typeof q.limit !== 'number' || !Number.isInteger(q.limit) || q.limit < 1 || q.limit > 20) throw new Error('INVALID_COLLECTION_LIMIT');
  return { keyword:q.keyword.trim(), country:q.country, status:q.status as CollectionQuery['status'], mediaType:q.mediaType as CollectionQuery['mediaType'], limit:q.limit };
}

export interface VerifiedQueryProfile {
  id:string; sourceId:string; adapterVersion:string; query:CollectionQuery;
  verifiedAt:string; expiresAt:string; provenance:'live-meta-probe';
  evidenceReference:string; evidenceSha256:string; probeManifestSha256:string;
  authorization:'operator-signed-probe';
}
export interface SourceCapabilities {version:1;verification:'UNVERIFIED'|'VERIFIED';verifiedQueryProfiles:VerifiedQueryProfile[]}
export function verifiedSourceProfiles(source:{id:string;adapterVersion:string;capabilities:unknown}, now=new Date()):VerifiedQueryProfile[] {
  const caps=source.capabilities as Partial<SourceCapabilities>|null;
  if(!caps||caps.version!==1||caps.verification!=='VERIFIED'||!Array.isArray(caps.verifiedQueryProfiles))return [];
  return caps.verifiedQueryProfiles.filter(profile=>{
    try {
      const query=validateCollectionQuery(profile.query);const verified=Date.parse(profile.verifiedAt),expires=Date.parse(profile.expiresAt);
      return /^[A-Za-z0-9_-]{1,128}$/.test(profile.id)&&profile.sourceId===source.id&&profile.adapterVersion===source.adapterVersion&&profile.provenance==='live-meta-probe'&&profile.authorization==='operator-signed-probe'
        &&Number.isFinite(verified)&&verified<=now.valueOf()&&Number.isFinite(expires)&&expires>now.valueOf()&&expires>verified&&expires-verified<=30*86400000&&query.limit<=3
        &&/^local-private:private-source-evidence\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.html$/.test(profile.evidenceReference)
        &&/^[a-f0-9]{64}$/.test(profile.evidenceSha256)&&/^[a-f0-9]{64}$/.test(profile.probeManifestSha256);
    } catch {return false;}
  });
}
/** One verified sample enables only the exact tested query, up to its tested limit. */
export function assertVerifiedCollectionQuery(source:{id:string;adapterVersion:string;capabilities:unknown}, input:unknown, now=new Date()):CollectionQuery {
  const query=validateCollectionQuery(input);
  if(!verifiedSourceProfiles(source,now).some(profile=>profile.query.keyword===query.keyword&&profile.query.country===query.country&&profile.query.status===query.status&&profile.query.mediaType===query.mediaType&&query.limit<=profile.query.limit))throw new Error('SOURCE_CAPABILITY_UNVERIFIED');
  return query;
}
