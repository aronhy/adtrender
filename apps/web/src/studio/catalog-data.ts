import type { AdView } from '../client/types';

export const studioChannels = [
  ['facebook','Facebook'],['instagram','Instagram'],['tiktok','TikTok'],['pinterest','Pinterest'],['google','Google'],['youtube','YouTube'],['snapchat','Snapchat'],['audience_network','Audience Network'],['threads','Threads'],['messenger','Messenger'],
] as const;
export type CatalogAdvertiser = {id:string;name:string;sourceKey:string;sourceAdvertiserId:string;domain:string|null;sourcePageDomain?:string|null;logo:string|null;ads:number;active:number;channels:string[];lastObservedAt:string|null};
export type CatalogRow = {id:string;advertiserId:string|null;publisherPlatforms:string[];mediaType:string;sourceStatus:string;firstObservedAt:Date|string|null;lastObservedAt:Date|string|null;landingPageUrl:string|null;createdAt:Date|string};
export type StudioCatalogArgs = {snapshotId?:string;workspaceId:string;kind:'overview'|'ads'|'advertisers'|'advertiser'|'channel'|'landing'|'activity'|'products';advertiserId?:string;advertiserIds?:string[];sourceKey?:string;channel?:string;domain?:string;query?:string;page?:number;limit?:number;days?:number;format?:string;status?:string};
export type CatalogSource = {key:string;name:string;ads:number;lastObservedAt:string|null};
export type StudioCatalog = {snapshotId?:string;asOf:string;sources:CatalogSource[];kind:StudioCatalogArgs['kind'];stats:{ads:number;advertisers:number;active:number;images:number;videos:number;landingPages:number};channels:Array<{id:string;name:string;count:number}>;trend:Array<{date:string;count:number}>;advertisers:CatalogAdvertiser[];advertiser:CatalogAdvertiser|null;ads:AdView[];total:number;page:number;pageCount:number;activity:Array<{id:string;adId:string;advertiserId:string|null;advertiserName:string;title:string;description:string;at:string}>;landingPages:Array<{url:string;domain:string;count:number}>;products:never[]};
export const dateString=(value:Date|string|null|undefined)=>value?new Date(value).toISOString():null;
export function safeLandingUrl(value:string|null|undefined):string|null {
  if(!value)return null;
  try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
export function landingDomain(value:string|null|undefined):string|null {const safe=safeLandingUrl(value);return safe?new URL(safe).hostname.toLowerCase().replace(/^www\./,''):null;}
const sourceRoots=['facebook.com','fb.com','fb.me','instagram.com','tiktok.com','pinterest.com','pin.it','google.com','youtube.com','youtu.be','snapchat.com','apps.apple.com','microsoft.com','bing.com','bit.ly','linktr.ee'];
export function catalogAdvertiserDomains(landings:Array<string|null>,declared?:string|null,sourceUrl?:string|null) {
  const isSource=(host:string)=>sourceRoots.some(root=>host===root||host.endsWith('.'+root));
  const destinations=landings.map(landingDomain).filter((v):v is string=>Boolean(v));
  const declaredHost=declared?landingDomain(declared.includes('://')?declared:'https://'+declared):null;
  return {domain:destinations.find(host=>!isSource(host))||(declaredHost&&!isSource(declaredHost)?declaredHost:null),sourcePageDomain:destinations.find(isSource)||(declaredHost&&isSource(declaredHost)?declaredHost:null)||landingDomain(sourceUrl)};
}
export function normalizedPlatforms(values:string[]):string[] {
  const known=new Set(studioChannels.map(([id])=>String(id)));
  return [...new Set(values.map(v=>v.trim().toLowerCase().replace(/[ -]+/g,'_')).map(v=>['search','display','shopping','maps','other'].includes(v)?'google':v).filter(v=>known.has(v)))];
}
/** History uses the exact same public-ad scope as the cards and totals. */
export function catalogHistoryWhere<T extends object>(where:T,matchedDomainIds?:string[]) {
  return {ad:{...where,...(matchedDomainIds!==undefined?{id:{in:matchedDomainIds}}:{})}};
}
export function observationTrend(rows:Array<{day:string;observationCount:number}>) {
  const days=new Map<string,number>();
  for(const row of rows)days.set(row.day,(days.get(row.day)||0)+row.observationCount);
  return [...days].sort(([a],[b])=>a.localeCompare(b)).map(([date,count])=>({date,count}));
}
export function captureSpan(first:Date|string|null|undefined,now=new Date()):{start:string;end:string;days:number}|null {
  if(!first||!Number.isFinite(new Date(first).getTime())||!Number.isFinite(now.getTime()))return null;
  const shanghai=(value:Date)=>new Date(value.getTime()+8*3600000).toISOString().slice(0,10);
  const start=shanghai(new Date(first)),end=shanghai(now),span=(Date.parse(end)-Date.parse(start))/86400000;
  return span<0?null:{start,end,days:Math.floor(span)+1};
}
export function aggregateCatalog(rows:CatalogRow[],now=new Date()) {
  const channels=new Map<string,number>(),landings=new Map<string,{url:string;domain:string;count:number}>(),brands=new Set<string>(),days=new Map<string,number>();
  const trend=Array.from({length:30},(_,i)=>({date:new Date(now.getTime()+8*3600000-(29-i)*86400000).toISOString().slice(0,10),count:0}));
  for(const row of rows){
    if(row.advertiserId)brands.add(row.advertiserId);
    for(const channel of normalizedPlatforms(row.publisherPlatforms))channels.set(channel,(channels.get(channel)||0)+1);
    const url=safeLandingUrl(row.landingPageUrl);if(url){const prior=landings.get(url);landings.set(url,{url,domain:landingDomain(url)!,count:(prior?.count||0)+1});}
    const first=row.firstObservedAt||row.createdAt;if(first){const date=new Date(new Date(first).getTime()+8*3600000).toISOString().slice(0,10);days.set(date,(days.get(date)||0)+1);}
  }
  return {stats:{ads:rows.length,advertisers:brands.size,active:rows.filter(r=>r.sourceStatus==='ACTIVE').length,images:rows.filter(r=>r.mediaType==='IMAGE').length,videos:rows.filter(r=>r.mediaType==='VIDEO').length,landingPages:landings.size},channels:studioChannels.map(([id,name])=>({id,name,count:channels.get(id)||0})),trend:trend.map(day=>({...day,count:days.get(day.date)||0})),landingPages:[...landings.values()].sort((a,b)=>b.count-a.count||a.url.localeCompare(b.url))};
}
