type IntentStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
type Entry={pathname:string;search:string;hash:string};
const key='ad-research:workspace-entry';
const lifetime=30*60*1000;
const paths=new Set(['/app','/app/settings','/app/team','/app/billing']);
const anchors=new Set(['#team','#billing','#profile','#account','#feedback','#danger','#extension-connections-title','#security','#extensions','#workspace']);
const languages=new Set(['zh-CN','zh-TW','en','es']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const session=():IntentStorage|undefined=>{try{return window.sessionStorage;}catch{return undefined;}};

/** Narrow navigation intent only. No arbitrary destination, callback, token
 * issuance or automatic invitation acceptance is represented by this record. */
function validatedEntry(pathname:string,search:string,hash:string):Entry|null{
 if(!paths.has(pathname)||search.length>4096||hash.length>100)return null;
 const input=new URLSearchParams(search),safe=new URLSearchParams();
 const invite=input.get('invite'),plan=input.get('plan'),connect=input.get('connect'),extension=input.get('extId');
 const knownHash=anchors.has(hash)?hash:'';
 const validInvite=!!invite&&/^[a-f0-9]{64}$/.test(invite),validPlan=!!plan&&uuid.test(plan),validExtension=!!extension&&/^[a-p]{32}$/.test(extension);
 if(!validInvite&&!validPlan&&!knownHash&&connect!=='extension'&&!validExtension)return null;
 if(validInvite)safe.set('invite',invite!);
 if(validPlan)safe.set('plan',plan!);
 if(connect==='extension')safe.set('connect','extension');
 if(validExtension)safe.set('extId',extension!);
 const label=input.get('browserLabel')?.trim();
 if((connect==='extension'||validExtension)&&label&&label.length<=60&&/^[A-Za-z0-9 ().\/-]+$/.test(label))safe.set('browserLabel',label);
 for(const name of ['workspace','organization']){const value=input.get(name);if(value&&uuid.test(value))safe.set(name,value);}
 const language=input.get('lang');if(language&&languages.has(language))safe.set('lang',language);
 return {pathname,search:safe.toString(),hash:knownHash};
}

export function rememberWorkspaceEntryIntent(pathname:string,search:string,hash:string,storage:IntentStorage|undefined=session(),now=Date.now()):void{
 try{
  if(!Number.isFinite(now))return;
  const entry=validatedEntry(pathname,search,hash);if(!entry)return;
  storage?.setItem(key,JSON.stringify({...entry,createdAt:now}));
 }catch{/* Disabled session storage must not interrupt login. */}
}

export function consumeWorkspaceEntryIntent(storage:IntentStorage|undefined=session(),now=Date.now()):string|null{
 try{
  const raw=storage?.getItem(key);storage?.removeItem(key);
  const value:unknown=raw?JSON.parse(raw):null;
  if(!value||typeof value!=='object'||!('pathname'in value)||typeof value.pathname!=='string'||!('search'in value)||typeof value.search!=='string'||!('hash'in value)||typeof value.hash!=='string'||!('createdAt'in value)||typeof value.createdAt!=='number'||!Number.isFinite(value.createdAt)||!Number.isFinite(now)||now<value.createdAt||now-value.createdAt>=lifetime)return null;
  const entry=validatedEntry(value.pathname,value.search,value.hash);if(!entry)return null;
  return entry.pathname+(entry.search?'?'+entry.search:'')+entry.hash;
 }catch{return null;}
}
