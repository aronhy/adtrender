import {createHash} from 'node:crypto';
export type QueryQuality='HISTORICAL_QUERY'|'UNATTRIBUTED';
export function canonicalJson(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>JSON.stringify(k)+':'+canonicalJson(v)).join(',')+'}';
 return JSON.stringify(value)??'null';
}
export function legacyQueryIdentity(sourceKey:string,input:unknown):{key:string;channel:string;quality:QueryQuality;params:Record<string,unknown>} {
 const q=(input&&typeof input==='object'&&!Array.isArray(input)?input:{}) as Record<string,unknown>;
 let channel='UNKNOWN',params:Record<string,unknown>={},valid=false;
 const text=(k:string)=>typeof q[k]==='string'?q[k] as string:'';
 const country=text('country');
 if(sourceKey==='meta_ad_library'){
  channel='META';params={country,language:text('language')||'und',keyword:text('keyword'),pageId:text('pageId'),status:text('status')||'all',mediaType:text('mediaType')||'all'};
  valid=/^[A-Z]{2}$/.test(country)&&!!(text('keyword')||text('pageId'));
 }else if(sourceKey==='google_ads_transparency'){
  channel=text('kind')==='SERP'?'SERP':'ATC';params={kind:text('kind'),country,language:text('language')||'und',term:text('term'),advertiserId:text('advertiserId'),domain:text('domain')};
  valid=/^[A-Z]{2}$/.test(country)&&['DISCOVER','SEARCH','YOUTUBE','SERP'].includes(text('kind'));
 }else if(sourceKey==='snapchat_ads_gallery'){
  channel='PUBLISHER';params={country,publisher:text('publisher').trim().toLowerCase()};valid=/^(ALL|[A-Z]{2})$/.test(country)&&!!text('publisher');
 }else if(sourceKey==='tiktok_commercial_library'||sourceKey==='pinterest_ads_repository'){
  channel='SWEEP';params={country,start:text('startDate')||text('dateStart'),end:text('endDate')||text('dateEnd'),category:'ALL',keyword:''};valid=/^[A-Z]{2}$/.test(country)&&/^\d{4}-\d{2}-\d{2}$/.test(String(params.start))&&/^\d{4}-\d{2}-\d{2}$/.test(String(params.end));
 }
 if(!valid)params={unresolvedQuery:q};
 return {key:createHash('sha256').update(canonicalJson({sourceKey,channel,keyVersion:'legacy-1',params})).digest('hex'),channel,quality:valid?'HISTORICAL_QUERY':'UNATTRIBUTED',params};
}
