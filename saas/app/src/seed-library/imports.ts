import {createHash} from 'node:crypto';
import {validateSeedDefinition,seedCanonical,type SeedDefinitionInput} from '@ad-research/contracts/seeds';
import {normalizeSeedValue} from './catalog';
export interface SeedImportPreview {definitions:SeedDefinitionInput[];rowResults:{row:number;status:string;error?:string;rawValue?:string}[];fileHash:string}
function parseRows(csv:string):string[][]{
 if(Buffer.byteLength(csv)>25*1024*1024)throw Error('SEED_CSV_TOO_LARGE');
 const result:string[][]=[];let row:string[]=[],value='',quote=false,afterQuote=false;
 for(let i=0;i<csv.length;i++){const c=csv[i];
  if(quote){if(c==='"'){if(csv[i+1]==='"'){value+='"';i++;}else{quote=false;afterQuote=true;}}else value+=c;continue;}
  if(c==='"'){if(value||afterQuote)throw Error('SEED_CSV_INVALID');quote=true;continue;}
  if(afterQuote&&!['\r','\n',','].includes(c))throw Error('SEED_CSV_INVALID');
  if(c===','||c==='\n'){row.push(value);value='';afterQuote=false;if(c==='\n'){result.push(row);row=[];}continue;}
  if(c==='\r'&&csv[i+1]==='\n')continue;value+=c;
 }
 if(quote)throw Error('SEED_CSV_INVALID');if(value||row.length){row.push(value);result.push(row);}return result;
}
export function parseSeedCsv(text:string):SeedImportPreview{
 const rows=parseRows(text.replace(/^\uFEFF/,''));if(!rows.length)throw Error('SEED_CSV_INVALID');const headers=rows.shift()!;if(new Set(headers).size!==headers.length)throw Error('SEED_CSV_INVALID');
 const definitions=new Map<string,SeedDefinitionInput>(),rowResults:SeedImportPreview['rowResults']=[];
 rows.forEach((cells,index)=>{
  if(cells.every(c=>!c.trim()))return;try{
   if(cells.length!==headers.length)throw Error('SEED_CSV_COLUMNS');const row=Object.fromEntries(headers.map((h,i)=>[h,cells[i]]));
   const rawValue=row.encoding_version==='spreadsheet-safe-v1'&&row.raw_value_b64?Buffer.from(row.raw_value_b64,'base64').toString('utf8'):row.value??row.keyword;
   if(typeof rawValue!=='string')throw Error('SEED_VALUE_MISSING');const country=row.countries??row.country??'',kind=(row.kind||'KEYWORD') as SeedDefinitionInput['kind'];
   const scope=country==='ALL'?{kind:'SOURCE_GLOBAL'}:country?{kind:'EXPLICIT_COUNTRIES',countries:[...new Set(country.split(';'))].sort()}:{kind:'CONFIGURED_MARKETS'};
   const value=validateSeedDefinition({kind,namespace:row.namespace||(kind==='NATIVE_ADVERTISER'?row.platform:'public'),rawValue,normalizedValue:normalizeSeedValue(kind,rawValue),language:row.language||row.query_language||'und',purposeTags:row.family?[{family:row.family,category:row.category}]:[],targetScope:scope,targetPlatforms:row.platform?row.platform.split(';'):['meta_ad_library','google_ads_transparency','snapchat_ads_gallery','tiktok_commercial_library','pinterest_ads_repository'],status:'DRAFT',priority:0});
   const key=seedCanonical([value.kind,value.namespace,value.language,value.normalizedValue]);const prior=definitions.get(key);
   if(prior){if(seedCanonical(prior.targetScope)!==seedCanonical(value.targetScope)&&!(prior.targetScope.kind==='EXPLICIT_COUNTRIES'&&value.targetScope.kind==='EXPLICIT_COUNTRIES'))throw Error('SEED_CSV_SCOPE_CONFLICT');prior.purposeTags=[...new Map([...prior.purposeTags,...value.purposeTags].map(t=>[seedCanonical(t),t])).values()];prior.targetPlatforms=[...new Set([...prior.targetPlatforms,...value.targetPlatforms])];if(prior.targetScope.kind==='EXPLICIT_COUNTRIES'&&value.targetScope.kind==='EXPLICIT_COUNTRIES')prior.targetScope.countries=[...new Set([...prior.targetScope.countries,...value.targetScope.countries])].sort();rowResults.push({row:index+2,status:'MERGED',rawValue});}
   else{definitions.set(key,value);rowResults.push({row:index+2,status:'VALID',rawValue});}
  }catch(e){rowResults.push({row:index+2,status:'INVALID',error:e instanceof Error?e.message:'SEED_CSV_INVALID'});}
 });
 return {definitions:[...definitions.values()],rowResults,fileHash:createHash('sha256').update(text).digest('hex')};
}
export {getStaticSeedBaseline as buildStaticSeedBaseline} from '@ad-research/contracts/seed-baseline';
export function exportSeedCsv(seeds:ReadonlyArray<SeedDefinitionInput|any>):string{
 const headers=['kind','namespace','value','language','family','category','countries','platform','encoding_version','raw_value_b64'];const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
 const rows=seeds.flatMap(s=>(s.purposeTags.length?s.purposeTags:[{family:'',category:''}]).map((p:any)=>{const raw=s.rawValue;return [s.kind,s.namespace,/^[=+\-@]/.test(raw)?"'"+raw:raw,s.language,p.family,p.category,s.targetScope.kind==='EXPLICIT_COUNTRIES'?s.targetScope.countries.join(';'):s.targetScope.kind==='SOURCE_GLOBAL'?'ALL':'',s.targetPlatforms.join(';'),'spreadsheet-safe-v1',Buffer.from(raw).toString('base64')].map(quote).join(',');}));return [headers.join(','),...rows].join('\n');
}
