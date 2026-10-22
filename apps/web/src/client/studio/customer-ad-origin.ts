import {landingDomain,safeLandingUrl} from '../../studio/catalog-data';
const supplierDomains=['bigspy.com','adflex.io','adflex.com','minea.com','pipiads.com','trendtrack.io'];
const platformDomains=['facebook.com','instagram.com','google.com','tiktok.com','pinterest.com','snapchat.com','microsoft.com','linkedin.com','youtube.com','youtu.be'];
const belongs=(host:string,domain:string)=>host===domain||host.endsWith('.'+domain);
const secretQuery=/^(?:access_token|authorization|api_key|apikey|token|secret|password|x-amz-signature|x-amz-credential)$/i;
/** Public platform evidence is useful to customers; procurement portals are internal. */
export function customerAdOriginUrl(ad:{sourceUrl?:string|null}):string|null {
 const safe=customerLandingUrl(ad.sourceUrl);if(!safe)return null;
 const url=new URL(safe);return url.protocol==='https:'&&platformDomains.some(domain=>belongs(url.hostname,domain))?safe:null;
}
export function customerLandingUrl(value:string|null|undefined):string|null {
 const safe=safeLandingUrl(value);if(!safe)return null;
 const url=new URL(safe);if(supplierDomains.some(domain=>belongs(url.hostname,domain))||[...url.searchParams.keys()].some(key=>secretQuery.test(key)))return null;
 return safe;
}

export function customerAdvertiserDomain(value:string|null|undefined):string|null {
 if(!value?.trim())return null;
 return landingDomain(customerLandingUrl(value.includes('://')?value:'https://'+value));
}
export function customerAdvertiserSiteLabel(advertiser:{domain?:string|null;sourcePageDomain?:string|null}|null|undefined):string {
 const domain=customerAdvertiserDomain(advertiser?.domain);if(domain)return domain;
 const source=customerAdvertiserDomain(advertiser?.sourcePageDomain);return source?source+'（来源页）':'网站未提供';
}
