/** Public destination links retain their disclosed HTTP/HTTPS protocol. */
export function landingPageUrl(value?:string|null) {
 try {const url=new URL(value??'');return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:undefined;}
 catch{return undefined;}
}
