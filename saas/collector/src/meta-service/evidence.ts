/** Serialized into anonymous browser context; keep this function self-contained. */
export function sanitizeEvidence(doc:Document){
 const body=doc.body?.cloneNode(true) as HTMLElement|undefined;if(!body)return {html:'',text:''};
 body.querySelectorAll('script,style,noscript,iframe,input,textarea').forEach(e=>e.remove());
 body.querySelectorAll('*').forEach(e=>{for(const a of [...e.attributes])if(!['href','src','alt','title','role','aria-label','aria-disabled','data-testid'].includes(a.name))e.removeAttribute(a.name);});
 return {html:body.outerHTML,text:body.textContent??''};
}
export function accessState(status:number|null,text:string){
 if(status===429||/Security Check|verify you are human|captcha|checkpoint|Enter the code from your image/i.test(text))return 'restricted';
 if(/Log in to Facebook|Log in to continue|登录以继续/i.test(text))return 'login';
 if(/Library ID\s*[:：]\s*\d+|资料库编号\s*[:：]\s*\d+/.test(text))return 'ready';
 if(/No ads match your search criteria|No results found|没有符合搜索条件的广告/i.test(text))return 'empty';
 if(/Search by keyword or advertiser/.test(text))return 'shell';
 if(status===403)return 'restricted';
 return 'loading';
}
export function browserErrorCode(e:unknown){const message=e instanceof Error?e.message:'';if(/profile appears to be in use|user data directory is already in use/i.test(message))return 'META_PROFILE_LOCKED';if(/^META_[A-Z_0-9]+$/.test(message))return message;if(e instanceof Error&&e.name==='TimeoutError')return 'META_TIMEOUT';return 'META_BROWSER_ERROR';}
/** Only interpret public response errors; never persist request bodies or headers. */
export function graphqlErrorCode(text:string):string|null{
 let other=false;
 for(const line of text.split('\n')){
  try{const data=JSON.parse(line.replace(/^for\s*\(;;\);\s*/,''));for(const e of Array.isArray(data.errors)?data.errors:[]){if(e.code===1675004||/rate limit|too many requests/i.test(e.message??''))return 'META_RATE_LIMITED';if(/not logged in|login required|log in to continue/i.test(e.message??''))return 'META_SOURCE_LOGIN_REQUIRED';other=true;}}
  catch{/* A non-JSON response is handled by the page-state checks. */}
 }
 return other?'META_QUERY_ERROR':null;
}
