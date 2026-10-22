/** Keep search state only for our local ad-library route; never accept an external return URL. */
export function safeStudioAdsReturn(value:string|null|undefined):string|null {
  if(!value||value.length>12000||!value.startsWith('/')||value.startsWith('//')||/[\u0000-\u001f\\]/.test(value))return null;
  try {
    const target=new URL(value,'http://studio.invalid');
    if(target.origin!=='http://studio.invalid'||!/^\/app\/ads\/?$/.test(target.pathname))return null;
    const allowed=new Set(['workspace','q','channel','platform','format','mediaType','status','domain','cursor','page','country','days','startedFrom','startedTo','observedFrom','observedTo','sort','unique']);
    if(target.searchParams.has('source')){target.searchParams.delete('cursor');target.searchParams.delete('page');}
    for(const key of [...target.searchParams.keys()])if(!allowed.has(key))target.searchParams.delete(key);
    return '/app/ads'+(target.searchParams.size?'?'+target.searchParams.toString():'');
  }catch{return null;}
}
