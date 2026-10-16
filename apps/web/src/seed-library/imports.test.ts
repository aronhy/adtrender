import {describe,it,expect} from 'vitest';import {parseSeedCsv,buildStaticSeedBaseline,exportSeedCsv} from './imports';
describe('seed import codecs',()=>{
 it('parses old country expansion into definitions without multiplying identity',()=>{
  const rows=parseSeedCsv('country,query_language,family,category,keyword\nUS,en,GAMES,slots,"slots"\nGB,en,GAMES,slots,"slots"');expect(rows.definitions).toHaveLength(1);expect(rows.definitions[0].targetScope).toEqual({kind:'EXPLICIT_COUNTRIES',countries:['GB','US']});
 });
 it('round trips dangerous spreadsheet prefixes without losing raw value',()=>{
  const input={kind:'NAME',namespace:'public',rawValue:'=Example,"Brand"',language:'en',purposeTags:[],targetScope:{kind:'CONFIGURED_MARKETS'},targetPlatforms:['snapchat_ads_gallery'],status:'DRAFT',priority:0};const out=exportSeedCsv([input]);expect(out).toContain('spreadsheet-safe-v1');expect(parseSeedCsv(out).definitions[0].rawValue).toBe(input.rawValue);
 });
 it('rejects malformed quotes and preserves original baseline purpose unions',()=>{
  expect(()=>parseSeedCsv('country,keyword\nUS,"bad')).toThrow('SEED_CSV_INVALID');const b=buildStaticSeedBaseline();expect(b.definitions.some(d=>d.purposeTags.some(p=>p.family==='GAMES'&&p.category==='slots'))).toBe(true);expect(b.definitions.every(d=>d.status==='DRAFT')).toBe(true);expect(b.evidence.every(e=>e.originKind==='OFFICIAL_PRODUCT')).toBe(true);
 });
});
