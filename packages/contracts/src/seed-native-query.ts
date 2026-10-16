import type {SourceKey} from './seeds.js';
const modes:Record<SourceKey,string[]>={meta_ad_library:['KEYWORD','NAME','PAGE_ID','NATIVE_ADVERTISER'],google_ads_transparency:['DISCOVER','SEARCH','YOUTUBE','SERP'],snapchat_ads_gallery:['PUBLISHER','NAME'],tiktok_commercial_library:['SWEEP','DATE_SWEEP','MEDIA_REFRESH'],pinterest_ads_repository:['SWEEP','DATE_SWEEP']};
const channelFor=(source:SourceKey,mode:string)=>source==='snapchat_ads_gallery'?'PUBLIC_API':source==='google_ads_transparency'&&mode==='SERP'?'SERP':'PUBLIC_DOM';
const channels:Record<SourceKey,string[]>={meta_ad_library:['META','PUBLIC_DOM'],google_ads_transparency:['ATC','PUBLIC_DOM','SERP'],snapchat_ads_gallery:['PUBLISHER','PUBLIC_API'],tiktok_commercial_library:['SWEEP','PUBLIC_DOM'],pinterest_ads_repository:['SWEEP','PUBLIC_DOM']};
function text(value:unknown,fallback=''){if(value===undefined||value===null)return fallback;if(typeof value!=='string'||/[\u0000-\u001f\u007f]/.test(value))throw Error('COLLECTOR_NATIVE_PARAMS_INVALID');return value;}
/** Compare the actual supported source dimensions, including collection mode.
 * Progress (cursor, seen and page) is deliberately outside query identity. */
export function canonicalNativeParams(source:SourceKey,mode:string,p:Record<string,unknown>):Record<string,unknown>{
 if(!modes[source]?.includes(mode))throw Error('COLLECTOR_UNSUPPORTED_MODE');
 const country=text(p.country,'ALL'),channel=text(p.channel,channelFor(source,mode));
 if(!/^(?:[A-Z]{2}|ALL)$/.test(country)||!channels[source].includes(channel)||(source==='google_ads_transparency'&&(mode==='SERP')!==(channel==='SERP')))throw Error('COLLECTOR_NATIVE_PARAMS_INVALID');
 const common={mode,channel,country};
 if(source==='meta_ad_library'){
  if(!['all',undefined].includes(p.status as any)||!['all',undefined].includes(p.mediaType as any))throw Error('COLLECTOR_UNSUPPORTED_NATIVE_FILTER');
  const pageId=text(p.pageId??p.nativeAdvertiserId),keyword=text(p.keyword??p.name),language=text(p.language,pageId?'und':'en');
  if(['PAGE_ID','NATIVE_ADVERTISER'].includes(mode)?!/^\d{5,}$/.test(pageId)||!!keyword:!!pageId||!keyword)throw Error('COLLECTOR_NATIVE_PARAMS_INVALID');
  return {...common,language,keyword,pageId,status:'all',mediaType:'all'};
 }
 if(source==='google_ads_transparency'){if(p.kind!==undefined&&p.kind!==mode)throw Error('COLLECTOR_NATIVE_PARAMS_INVALID');return {...common,kind:mode,language:text(p.language,'en'),term:text(p.term??p.keyword??p.name),advertiserId:text(p.advertiserId),domain:text(p.domain)};}
 if(source==='snapchat_ads_gallery'){const publisher=text(p.publisher??p.name).trim();if(!publisher||publisher.length>200)throw Error('COLLECTOR_NATIVE_PARAMS_INVALID');return {...common,publisher};}
 if(text(p.keyword)||text(p.publisher)||text(p.advertiserId)||![undefined,'ALL'].includes(p.category as any))throw Error('COLLECTOR_UNSUPPORTED_NATIVE_FILTER');
 const start=text(p.startDate??p.dateStart??p.start),end=text(p.endDate??p.dateEnd??p.end);
 for(const date of [start,end])if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(Date.parse(date)).toISOString().slice(0,10)!==date)throw Error('COLLECTOR_NATIVE_PARAMS_INVALID');
 if(start>end||(source==='tiktok_commercial_library'&&start===end))throw Error('COLLECTOR_NATIVE_PARAMS_INVALID');
 const ids=mode==='MEDIA_REFRESH'?p.sourceAdIds:undefined;if(mode==='MEDIA_REFRESH'&&(!Array.isArray(ids)||!ids.length||ids.length>2||ids.some(id=>typeof id!=='string'||!/^\d{5,40}$/.test(id))))throw Error('COLLECTOR_NATIVE_PARAMS_INVALID');
 return {...common,startDate:start,endDate:end,keyword:'',category:'ALL',...(ids?{sourceAdIds:ids}:{})};
}
