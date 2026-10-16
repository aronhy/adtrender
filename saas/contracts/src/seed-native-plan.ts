/** Native date partition keys, independent of cursor/progress state. */
export function nativeScanWindows(sourceKey:string,countries:string[],start:string,end:string):Array<{country:string;start:string;end:string}>{
 const day=86400000,first=Date.parse(start),last=Date.parse(end),iso=(at:number)=>new Date(at).toISOString().slice(0,10);
 if(!countries.length||countries.some(c=>!/^[A-Z]{2}$/.test(c))||!Number.isFinite(first)||!Number.isFinite(last)||iso(first)!==start||iso(last)!==end||first>last)throw Error('SEED_NATIVE_RANGE_INVALID');
 const result:Array<{country:string;start:string;end:string}>=[];
 if(sourceKey==='tiktok_commercial_library'){
  if(first>=last||last-first>3660*day)throw Error('TIKTOK_RANGE_INVALID');
  for(let to=last;to>first;){const from=Math.max(first,to-7*day);for(const country of new Set(countries))result.push({country,start:iso(from),end:iso(to)});to=from;}
 }else if(sourceKey==='pinterest_ads_repository'){
  for(let to=last;to>=first;to-=7*day){const from=Math.max(first,to-6*day);for(const country of new Set(countries))result.push({country,start:iso(from),end:iso(to)});}
 }else throw Error('SEED_NATIVE_SCAN_UNSUPPORTED');
 return result;
}
