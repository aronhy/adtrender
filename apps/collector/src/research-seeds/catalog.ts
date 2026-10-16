import countryCatalog from './countries.json';
import {seedCategories as legacyCategories,localizedSeeds as legacyLocalized} from './legacy-spy-seeds';
import {localeMarkets,slotTerms,comicTerms} from './locales';import {products,PRODUCT_CHECKED_DATE} from './products';
export type ResearchFamily='ECOMMERCE'|'GAMES'|'COMICS';
export type SeedFamily=ResearchFamily|'INFEED'; // Persisted v2 query compatibility only.
export interface SeedCategory {id:string;family:ResearchFamily;keywords:string[]}
export interface KeywordSeed {country:string;language:string;keyword:string;family:ResearchFamily;category:string}
export const SEED_VERSION='research-seeds-3';
export const COUNTRY_CODES=[...new Set([...countryCatalog.codes,'TW'])].sort();
const games:Record<string,string[]>={
 slots:['slots','slot games','slot machine','online slots','casino slots','vegas slots','777 slots','jackpot','free spins','spin now','free coins','casino bonus','welcome bonus','no deposit bonus','cash out'],
 'mobile-games':['mobile game','download app','install now','play now'],puzzle:['puzzle game','match 3','brain game'],casual:['casual game','mini games'],
 merge:['merge game'],idle:['idle game','idle RPG'],strategy:['strategy game','tower defense'],rpg:['RPG game','role playing game'],action:['action game','shooter game'],
 simulation:['simulation game','farming game','tycoon game'],sports:['sports game','football game'],racing:['racing game','car game'],cards:['card game','solitaire'],board:['board game','bingo'],arcade:['arcade game'],
};
const comics:Record<string,string[]>={
 'motion-comics':['motion comic','animated comic','manga animation','webtoon animation'],
 'animated-drama':['anime short drama','animated short drama','anime mini series'],
 'ai-comics':['AI motion comic','AI comic drama','AI animation'],vertical:['vertical anime','vertical animation'],
 romance:['romance anime','werewolf anime'],fantasy:['fantasy anime','reincarnation anime','cultivation animation'],
 'story-hooks':['revenge anime','anime comeback story'],comedy:['comedy animation','animated comedy shorts'],
};
const commerce=legacyCategories.filter(c=>c.family==='ECOMMERCE').map(c=>({...c,family:'ECOMMERCE' as const}));
export const seedCategories:SeedCategory[]=[...commerce,...Object.entries(games).map(([id,keywords])=>({id,family:'GAMES' as const,keywords})),...Object.entries(comics).map(([id,keywords])=>({id,family:'COMICS' as const,keywords}))];
export function localizedSeeds(language:string):SeedCategory[]{
 const commerce=legacyLocalized(language).filter(c=>c.family==='ECOMMERCE').map(c=>({...c,family:'ECOMMERCE' as const}));
 return [...commerce,...(slotTerms[language]?[{id:'slots',family:'GAMES' as const,keywords:slotTerms[language]}]:[]),...(comicTerms[language]?[{id:'motion-comics',family:'COMICS' as const,keywords:comicTerms[language]}]:[])];
}
export function keywordSeeds(countries:string[]=COUNTRY_CODES):KeywordSeed[]{
 if(!countries.length||countries.some(c=>!COUNTRY_CODES.includes(c)))throw Error('SEED_COUNTRIES_INVALID');
 const result=new Map<string,KeywordSeed>();const add=(country:string,language:string,keyword:string,family:ResearchFamily,category:string)=>{keyword=keyword.trim();if(!keyword||keyword.length>200)throw Error('SEED_KEYWORD_INVALID');const key=JSON.stringify([country,language,keyword]);if(!result.has(key))result.set(key,{country,language,keyword,family,category});};
 for(const country of new Set(countries)){
  for(const c of seedCategories)for(const word of c.keywords)add(country,'en',word,c.family,c.id);
  for(const [language,markets] of Object.entries(localeMarkets))if(markets.includes(country))for(const c of localizedSeeds(language))for(const word of c.keywords)add(country,language,word,c.family,c.id);
  for(const p of products)for(const alias of p.aliases)add(country,'en',alias,p.family,p.category);
 }return [...result.values()];
}
export function publisherCandidates(){return products.flatMap(p=>p.aliases.map(publisher=>({publisher,sources:['research_seed_catalog'],sourceUrl:p.sourceUrl,checkedDate:PRODUCT_CHECKED_DATE,family:p.family,category:p.category,domain:p.domain})));}
export function platformStrategy(platform:'META'|'GOOGLE'|'TIKTOK'|'PINTEREST'|'SNAPCHAT'){
 return {META:'KEYWORD',GOOGLE:'NAME_AND_DOMAIN',TIKTOK:'COUNTRY_DATE_SWEEP',PINTEREST:'COUNTRY_DATE_SWEEP',SNAPCHAT:'PUBLISHER_NAME'}[platform];
}
