import type { MediaView } from '../types';
export type StudioMediaCandidate={id:string;url:string;type:'IMAGE'|'VIDEO';poster?:string;expiresAt?:number};
const expiry=(media:MediaView)=>{const value=media.displayUrlExpiresAt?new Date(media.displayUrlExpiresAt).valueOf():NaN;return Number.isFinite(value)?{expiresAt:value}:{};};
export function studioMediaCandidates(media:MediaView[]):StudioMediaCandidate[] {
  const ready=media.filter(m=>m.status==='READY'&&Boolean(m.displayUrl)),poster=ready.find(m=>m.type==='IMAGE')?.displayUrl||undefined;
  return [...ready.filter(m=>m.type==='VIDEO').map(m=>({id:m.id,url:m.displayUrl!,type:'VIDEO' as const,poster:m.posterUrl||poster,...expiry(m)})),...ready.filter(m=>m.type==='IMAGE').map(m=>({id:m.id,url:m.displayUrl!,type:'IMAGE' as const,...expiry(m)}))];
}
export function nextStudioMedia(candidates:StudioMediaCandidate[],failed:string[]):StudioMediaCandidate|undefined{return candidates.find(item=>!failed.includes(item.url));}
