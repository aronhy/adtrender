import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {seedCategories,localizedSeeds,publisherCandidates} from '../collector/src/research-seeds/catalog';
import {localeMarkets} from '../collector/src/research-seeds/locales';
import {seedCanonical,type SeedDefinitionInput} from '../contracts/src/seeds';
function normalizeSeedValue(kind:string,value:string){const normalized=value.normalize('NFKC').trim().replace(/\s+/g,' ');return kind==='NATIVE_ADVERTISER'?normalized:normalized.toLowerCase();}
function buildStaticSeedBaseline(){
 const definitions=new Map<string,SeedDefinitionInput>(),evidence:Array<{kind:string;namespace:string;language:string;normalizedValue:string;sourceUrl:string;observedAt:string;originKind:string}>=[];
 const add=(s:SeedDefinitionInput)=>{const normalizedValue=normalizeSeedValue(s.kind,s.rawValue),key=seedCanonical([s.kind,s.namespace,s.language,normalizedValue]),old=definitions.get(key);if(old){old.purposeTags=[...new Map([...old.purposeTags,...s.purposeTags].map(t=>[seedCanonical(t),t])).values()];}else definitions.set(key,{...s,normalizedValue});};
 for(const c of seedCategories)for(const rawValue of c.keywords)add({kind:'KEYWORD',namespace:'research_seed_catalog',rawValue,language:'en',purposeTags:[{family:c.family,category:c.id}],targetScope:{kind:'CONFIGURED_MARKETS'},targetPlatforms:['meta_ad_library','google_ads_transparency'],status:'DRAFT',priority:0});
 for(const [language,countries] of Object.entries(localeMarkets))for(const c of localizedSeeds(language))for(const rawValue of c.keywords)add({kind:'KEYWORD',namespace:'research_seed_catalog',rawValue,language,purposeTags:[{family:c.family,category:c.id}],targetScope:{kind:'EXPLICIT_COUNTRIES',countries},targetPlatforms:['meta_ad_library','google_ads_transparency'],status:'DRAFT',priority:0});
 for(const p of publisherCandidates()){
  for(const [kind,rawValue,platforms] of [['NAME',p.publisher,['meta_ad_library','google_ads_transparency','snapchat_ads_gallery']],...(p.domain?[['DOMAIN',p.domain,['google_ads_transparency']]]:[])] as const){
   add({kind:kind as any,namespace:'research_seed_catalog',rawValue:rawValue as string,language:'und',purposeTags:[{family:p.family,category:p.category}],targetScope:{kind:'CONFIGURED_MARKETS'},targetPlatforms:[...platforms] as any,status:'DRAFT',priority:0});evidence.push({kind:kind as string,namespace:'research_seed_catalog',language:'und',normalizedValue:normalizeSeedValue(kind as string,rawValue as string),sourceUrl:p.sourceUrl,observedAt:p.checkedDate,originKind:'OFFICIAL_PRODUCT'});
  }
 }
 return {definitions:[...definitions.values()],evidence};
}

const files=['catalog.ts','legacy-spy-seeds.ts','locales.ts','products.ts','countries.json'];
const sourceHashes=Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(new URL('../collector/src/research-seeds/'+file,import.meta.url))).digest('hex')]));
const target=new URL('../contracts/src/generated-seed-baseline.json',import.meta.url);
const artifact={generatorVersion:'seed-baseline-1',sourceHashes,...buildStaticSeedBaseline()};
const bytes=JSON.stringify(artifact)+'\n';
if(process.argv.includes('--check')){if(readFileSync(target,'utf8')!==bytes)throw Error('SEED_BASELINE_ARTIFACT_STALE');}
else writeFileSync(target,bytes);
