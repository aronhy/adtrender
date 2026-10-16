import {SEED_VERSION,COUNTRY_CODES,seedCategories,keywordSeeds,publisherCandidates,platformStrategy} from './catalog';
const seeds=keywordSeeds();
if(process.argv.includes('--publishers'))console.log(JSON.stringify({schema:1,version:SEED_VERSION,generatedAt:new Date().toISOString(),candidates:publisherCandidates()}));
else if(process.argv.includes('--csv')){
 const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';console.log('country,query_language,family,category,keyword');
 for(const s of seeds)console.log([s.country,s.language,s.family,s.category,s.keyword].map(quote).join(','));
}else console.log(JSON.stringify({version:SEED_VERSION,queryCountries:COUNTRY_CODES.length,queryLanguages:new Set(seeds.map(s=>s.language)).size,categories:seedCategories.length,keywords:new Set(seeds.map(s=>s.keyword)).size,expandedQueries:seeds.length,byFamily:Object.fromEntries(['ECOMMERCE','GAMES','COMICS'].map(f=>[f,{categories:seedCategories.filter(s=>s.family===f).length,queries:seeds.filter(s=>s.family===f).length}])),productNameClues:publisherCandidates().length,platforms:Object.fromEntries(['META','GOOGLE','TIKTOK','PINTEREST','SNAPCHAT'].map(p=>[p,platformStrategy(p as Parameters<typeof platformStrategy>[0])]))},null,2));
