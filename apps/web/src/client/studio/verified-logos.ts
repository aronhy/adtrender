/** Only use the logo supplied by the configured catalog. Unavailable logos
 * render as initials; the public frontend carries no captured advertiser data. */
export function studioLogoCandidates(observedLogo:string|null|undefined,_domain?:string|null):string[] {
 if(!observedLogo)return [];
 try {const url=new URL(observedLogo);return url.protocol==='https:'&&!url.username&&!url.password?[url.href]:[];}catch{return [];}
}
