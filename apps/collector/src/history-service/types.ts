import {isPinterestAdId} from '../pinterest/parser';
export const SOURCES = ['meta_ad_library','google_ads_transparency','tiktok_commercial_library','pinterest_ads_repository','snapchat_ads_gallery'] as const;
export type SourceKey = typeof SOURCES[number];
export interface Target {attemptId:string;leaseToken:string;adId:string;sourceKey:SourceKey;sourceAdId:string;sourceUrl:string;country:string|null;discoveryQuery:Record<string,unknown>;publisherPlatforms:string[];leaseUntil:string}
export type Outcome = 'OBSERVED'|'NOT_OBSERVED'|'FAILED'|'UNSUPPORTED';
export interface Result {outcome:Outcome;errorCode:string|null;retryAfterMs?:number;batch?:Record<string,any>;evidence?:unknown[]}
/** Never navigate a stored URL until its origin, path and identity match. */
export function fixedUrl(t:Pick<Target,'sourceKey'|'sourceAdId'|'sourceUrl'>):string|null {
 const id=t.sourceAdId;let expected:string;
 if(t.sourceKey==='meta_ad_library'&&/^\d{5,40}$/.test(id))expected=`https://www.facebook.com/ads/library/?id=${id}`;
 else if(t.sourceKey==='tiktok_commercial_library'&&/^\d{5,40}$/.test(id))expected=`https://library.tiktok.com/ads/detail/?ad_id=${id}`;
 else if(t.sourceKey==='pinterest_ads_repository'&&(/^\d{1,40}$/.test(id)||(id.length===64&&isPinterestAdId(id))))expected=`https://ads.pinterest.com/ads-repository/${id}/`;
 else if(t.sourceKey==='snapchat_ads_gallery'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))expected=`https://adsgallery.snap.com/?adId=${id}`;
 else if(t.sourceKey==='google_ads_transparency'&&/^CR\d{5,40}$/.test(id)) {const m=/^https:\/\/adstransparency\.google\.com\/advertiser\/(AR\d{5,40})\/creative\/(CR\d{5,40})$/.exec(t.sourceUrl);if(!m||m[2]!==id)return null;expected=t.sourceUrl;}
 else return null;
 return expected===t.sourceUrl?expected:null;
}
export function restriction(code:string|null){return /(?:403|429|RATE_LIMIT|ACCESS_BLOCK|LOGIN|CHALLENGE|RESTRICTED)/.test(code??'');}
export function safeError(error:unknown){const value=error instanceof Error?error.message:'';return /^[A-Z][A-Z_0-9]{2,100}$/.test(value)?value:error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)?'HISTORY_TIMEOUT':'HISTORY_SOURCE_ERROR';}
