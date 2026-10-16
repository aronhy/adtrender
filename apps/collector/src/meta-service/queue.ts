import {SPY_SEED_VERSION,type SeedFamily} from './spy-seeds';
import {keywordSeeds} from '../research-seeds/catalog';
export type Lane=SeedFamily|'ADVERTISER'|'GENERAL';
export interface Job {
 id:string;country:string;language:string;keyword:string;pageId?:string;
 seen:string[];lastAttemptAt:number;dueAt:number;failures:number;exhaustedAt:number|null;error?:string;cycleStartedAt?:number;seedFamilies?:SeedFamily[];seedCategories?:string[];
}
/** Search seeds are discovery context, never a claim about ad category/language. */
export const markets:Record<string,string[]>={en:['US','GB','CA','AU','NZ','IE','SG','ZA','IN','PH'],es:['ES','MX','AR','CO','CL'],pt:['BR','PT'],fr:['FR','BE','CA'],de:['DE','AT','CH'],it:['IT'],nl:['NL','BE'],ja:['JP'],ko:['KR'],zh:['TW','HK','SG'],ar:['SA','AE'],id:['ID'],th:['TH'],vi:['VN']};
export const terms:Record<string,string[]>={
 en:['shop now','sales','sale','free shipping','limited offer','new arrivals'],
 es:['comprar ahora','ofertas','descuento','envío gratis','novedades'],
 pt:['compre agora','promoção','desconto','frete grátis','novidades'],
 fr:['acheter maintenant','soldes','réduction','livraison gratuite','nouveautés'],
 de:['jetzt kaufen','angebote','rabatt','kostenloser versand','neuheiten'],
 it:['acquista ora','saldi','sconto','spedizione gratuita','novità'],
 nl:['shop nu','aanbieding','korting','gratis verzending'],
 ja:['今すぐ購入','セール','割引','送料無料','新商品'],
 ko:['지금 구매','세일','할인','무료 배송','신상품'],
 zh:['立即購買','限時優惠','折扣','免運','新品','立即购买','限时优惠'],
 ar:['تسوق الآن','تخفيضات','خصم','شحن مجاني'],
 id:['beli sekarang','promo','diskon','gratis ongkir'],
 th:['ซื้อเลย','ลดราคา','โปรโมชั่น','ส่งฟรี'],
 vi:['mua ngay','khuyến mãi','giảm giá','miễn phí vận chuyển'],
};
function job(country:string,language:string,keyword:string,pageId?:string):Job{return {id:JSON.stringify([country,language,pageId??'',keyword]),country,language,keyword,...(pageId?{pageId}:{}),seen:[],lastAttemptAt:0,dueAt:0,failures:0,exhaustedAt:null};}
export function seedJobs():Job[]{
 const jobs:Job[]=[];const groups=Object.entries(markets);
 // Interleave languages and countries before trying the next term.
 for(let term=0;term<Math.max(...Object.values(terms).map(t=>t.length));term++)
  for(let market=0;market<Math.max(...groups.map(([,c])=>c.length));market++)
   for(const [language,countries] of groups){const keyword=terms[language][term],country=countries[market];if(keyword&&country)jobs.push({...job(country,language,keyword),seedFamilies:['ECOMMERCE'],seedCategories:['promotions']});}
 for(const country of new Set(Object.values(markets).flat()))for(const keyword of ['shop now','sales'])jobs.push(job(country,'en',keyword));
 const countries=[...new Set(Object.values(markets).flat())];
 // English category searches reach every configured market, with local intent
 // words added independently. No returned ad is dropped by a category heuristic.
 for(const seed of keywordSeeds(countries))jobs.push({...job(seed.country,seed.language,seed.keyword),seedFamilies:[seed.family],seedCategories:[seed.category]});
 const result:Job[]=[];mergeSeedJobs(result,jobs);return result;
}
export function mergeSeedJobs(jobs:Job[],seeds=seedJobs()){
 const index=new Map(jobs.map(j=>[j.id,j]));let added=0;
 for(const seed of seeds){const old=index.get(seed.id);if(old){old.seedFamilies=[...new Set([...(old.seedFamilies??[]),...(seed.seedFamilies??[])])];old.seedCategories=[...new Set([...(old.seedCategories??[]),...(seed.seedCategories??[])])];}else{jobs.push(seed);index.set(seed.id,seed);added++;}}return added;
}
export function jobLane(j:Job):Lane{return j.pageId?'ADVERTISER':j.seedFamilies?.includes('GAMES')?'GAMES':j.seedFamilies?.includes('COMICS')?'COMICS':j.seedFamilies?.includes('ECOMMERCE')?'ECOMMERCE':j.seedFamilies?.includes('INFEED')?'INFEED':'GENERAL';}
export function seedQueueSummary(jobs:Job[]){return {seedCatalogVersion:SPY_SEED_VERSION,scope:'ecommerce-games-comics-research-not-verified-ad-classification',keywordJobs:jobs.filter(j=>!j.pageId).length,advertiserJobs:jobs.filter(j=>j.pageId).length,seedCategoryCount:new Set(jobs.filter(j=>!j.pageId).flatMap(j=>j.seedCategories??[])).size,bySeedFamily:Object.fromEntries(['ECOMMERCE','GAMES','COMICS','INFEED'].map(f=>[f,jobs.filter(j=>!j.pageId&&j.seedFamilies?.includes(f as SeedFamily)).length]))};}
export function nextJob(jobs:Job[],now:number,lastLane?:Lane){
 const due=jobs.filter(j=>j.dueAt<=now).sort((a,b)=>(Number(b.failures>0)-Number(a.failures>0))||a.lastAttemptAt-b.lastAttemptAt);
 if(!lastLane)return due[0];const lanes:Lane[]=['ECOMMERCE','GAMES','COMICS','ADVERTISER','INFEED','GENERAL'];const offset=lanes.indexOf(lastLane)+1;
 for(let i=0;i<lanes.length;i++){const picked=due.find(j=>jobLane(j)===lanes[(offset+i)%lanes.length]);if(picked)return picked;}
}
export function searchDecision(x:{explicitEnd:boolean;noResults:boolean;newCount:number;stalls:number;budgetReached:boolean}){if(x.explicitEnd||x.noResults)return 'exhausted';if(x.budgetReached)return 'continue-later';if(x.stalls>=3)return 'stalled';return 'continue';}
export function restrictionDelay(code:string|null,n:number){return /^(META_HTTP_(403|429)|META_RATE_LIMITED|META_SOURCE_(CHALLENGE|LOGIN_REQUIRED))$/.test(code??'')?Math.min(86400000,3600000*2**Math.min(5,Math.max(0,n-1))):0;}
/** Invoke after durable evidence + database transaction, including replay. */
export function applyBatch(j:Job,b:{ids:string[];status:string;errorCode:string|null;exhausted:boolean},now:number){
 j.seen=[...new Set([...j.seen,...b.ids])];j.lastAttemptAt=now;
 if(b.status==='SUCCEEDED'||b.status==='NO_RESULTS'){j.failures=0;delete j.error;j.exhaustedAt=b.exhausted?now:null;j.dueAt=now+(b.exhausted?6*3600000:60000);}
 else{j.failures++;j.error=b.errorCode??'FAILED';j.dueAt=now+Math.min(6*3600000,60000*2**Math.min(j.failures-1,10));}
}
export function prepareCycle(j:Job,now=Date.now()){if(j.exhaustedAt!==null){j.seen=[];j.exhaustedAt=null;j.cycleStartedAt=now;}j.cycleStartedAt??=now;}
export function pageIdFromUrl(value:string|null){if(!value)return;try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||!['facebook.com','www.facebook.com','m.facebook.com'].includes(u.hostname))return;const id=u.pathname==='/profile.php'?u.searchParams.get('id'):u.pathname.match(/^\/(?:pages\/[^/]+\/)?(\d+)\/?$/)?.[1];return id&&/^\d{5,}$/.test(id)?id:undefined;}catch{return;}}
export function discoverJobs(jobs:Job[],parent:Job,ads:Array<{advertiserPageUrl:string|null}>){for(const a of ads){const pageId=pageIdFromUrl(a.advertiserPageUrl);if(!pageId)continue;const child=job(parent.country,'und','',pageId);if(!jobs.some(j=>j.id===child.id))jobs.push(child);}}
export function buildSearchUrl(j:Job){const u=new URL('https://www.facebook.com/ads/library/');u.search=new URLSearchParams({country:j.country,active_status:'all',ad_type:'all',media_type:'all',...(j.pageId?{search_type:'page',view_all_page_id:j.pageId}:{search_type:'keyword_unordered',q:j.keyword})}).toString();return u.toString();}
