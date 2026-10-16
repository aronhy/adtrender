import { describe, expect, it } from 'vitest';
import { dayWindow, normalizeHistoryFact, projectAdHistory } from './normalize';
import type { HistoryFact } from './types';

const hashA = 'a'.repeat(64), hashB = 'b'.repeat(64);
function input(id = 'o1', at = '2026-10-08T01:00:00Z', extra: Record<string, unknown> = {}) {
  return {
    observation: { id, collectionRunId: 'r1', observedAt: at, sourceStatus: 'ACTIVE', queryCountry: 'US', parserVersion: 'meta-dom-1', snapshot: { source: 'meta', body: 'Original body', headline: 'Original title', cta: 'Shop now', landingPageUrl: 'https://shop.example/item', platforms: ['Facebook'] }, fieldProvenance: { body: { value: 'Original body', source: 'meta-public-dom' }, headline: { value: 'Original title' }, cta: { value: 'Shop now' }, landingPageUrl: { value: 'https://shop.example/item' } }, ...extra },
    run: { id: 'r1', sourceKey: 'meta_ad_library', querySnapshot: { keyword: ' bags ', country: 'US', language: 'en', status: 'active', mediaType: 'all' } }, media: [] as unknown[],
  };
}
function fact(id: string, at: string, extra: Record<string, unknown> = {}): HistoryFact {
  return normalizeHistoryFact(input(id, at, extra));
}

describe('UTC+8 history windows', () => {
  it('uses a left-closed right-open UTC window for a Shanghai date', () => {
    expect(dayWindow('2026-10-08')).toEqual({ from: new Date('2026-10-07T16:00:00Z'), to: new Date('2026-10-08T16:00:00Z') });
    const result = projectAdHistory({ adId: 'ad', facts: [fact('start', '2026-10-07T16:00:00Z'), fact('end', '2026-10-08T16:00:00Z')] });
    expect(result.days.map(d => [d.day, d.observationIds])).toEqual([['2026-10-08', ['start']], ['2026-10-09', ['end']]]);
  });
  it.each(['2026-02-30', '2026-13-01', '26-10-08', '2026-10-08T00:00:00Z', '2026-1-08'])('rejects invalid day %s', day => {
    expect(() => dayWindow(day)).toThrow('INVALID_HISTORY_DAY');
  });
  it('requires real observation time rather than creation or source start time', () => {
    expect(() => normalizeHistoryFact(input('o', 'invalid', { createdAt: '2026-10-08T01:00:00Z' }))).toThrow('INVALID_OBSERVATION_TIME');
  });
  it('rejects timezone-less timestamps rather than using the server local timezone', () => {
    expect(() => normalizeHistoryFact(input('o','2026-10-08T01:00:00'))).toThrow('INVALID_OBSERVATION_TIME');
  });
});

describe('query scope and heterogeneous evidence', () => {
  it('canonicalizes allowed query values and excludes pagination, secrets, notes and URLs', () => {
    const a = input();
    a.run.querySnapshot = { ...a.run.querySnapshot, page: 4, limit: 20, token: 'secret-value', notes: 'private-note', sourceUrl: 'https://cdn.example/?signature=secret' } as typeof a.run.querySnapshot;
    const b = input(); b.run.querySnapshot = { mediaType: 'all', status: 'active', country: 'us', keyword: 'bags', language: 'EN' };
    const first = normalizeHistoryFact(a), second = normalizeHistoryFact(b);
    expect(first.scope).toEqual(second.scope);
    expect(first.scope.kind).toBe('DISCOVERY');
    expect(first.scope.queryIdentity).not.toMatch(/secret|private-note|signature|page|limit/);
  });
  it('keeps query country/language, discovery, recheck and media refresh scopes separate', () => {
    const a = input('a'), b = input('b'), c = input('c'), d = input('d'), e = input('e');
    b.observation.queryCountry = 'GB'; b.run.querySnapshot.country = 'GB';
    c.run.querySnapshot.language = 'es';
    Object.assign(d.run, { historyKind: 'HISTORY_RECHECK' });
    Object.assign(e.run, { coverage: { reason: 'MEDIA_REFRESH_DETAIL' } });
    expect(new Set([a,b,c,d,e].map(value => normalizeHistoryFact(value).scope.hash)).size).toBe(5);
    expect(normalizeHistoryFact(e).scope.kind).toBe('MEDIA_REFRESH');
    expect(projectAdHistory({ adId: 'ad', facts: [normalizeHistoryFact(a), normalizeHistoryFact(b), normalizeHistoryFact(c)] }).days).toHaveLength(3);
  });
  it('uses LEGACY_UNKNOWN for missing original query context', () => {
    const value = input(); Object.assign(value.run, { querySnapshot: null });
    expect(normalizeHistoryFact(value).scope.kind).toBe('LEGACY_UNKNOWN');
  });
  it.each(['google_ads_transparency', 'tiktok_commercial_library', 'pinterest_ads_repository'])('does not invent ACTIVE/INACTIVE for %s', sourceKey => {
    const value = input(); value.run.sourceKey = sourceKey;
    Object.assign(value.observation, { sourceStatus: 'ACTIVE', snapshot: { body: 'Sample', sourceLastShown: 'October 1, 2026', firstShown: '2026-09-01', lastShown: '2026-10-01', sourceFields: { 'Ad status': 'Disapproved' } } });
    expect(normalizeHistoryFact(value).sourceStatus).toBe('UNKNOWN');
  });
  it('preserves source disclosures independently of query context and first/last shown labels', () => {
    const value = input(); value.run.sourceKey = 'tiktok_commercial_library';
    Object.assign(value.observation, { snapshot: { body: 'Sample', firstShown: '2026-09-01', lastShown: '2026-10-01', reportedCountries: ['DE', 'GB'], languages: ['de'] } });
    expect(normalizeHistoryFact(value)).toMatchObject({ sourceFirstShown: '2026-09-01', sourceLastShown: '2026-10-01', sourceStartedAt: null, sourceEndedAt: null, reportedCountries: ['DE','GB'], publisherPlatforms: ['TIKTOK'], adLanguages: ['de'], scope: { queryCountry: 'US', queryLanguage: 'en' } });
  });
  it('preserves Snapchat source state and dates without treating delivery countries as query countries', () => {
    const value = input(); value.run.sourceKey = 'snapchat_ads_gallery';
    Object.assign(value.observation, { sourceStatus: 'INACTIVE', snapshot: { sourceStatus: 'INACTIVE', sourceState: 'ENDED', sourceStartedAt: '2026-09-01T12:00:00Z', sourceEndedAt: '2026-10-01T12:00:00Z', reportedCountries: ['DE'], publisherPlatform: 'SNAPCHAT' } });
    expect(normalizeHistoryFact(value)).toMatchObject({ sourceStatus: 'INACTIVE', sourceStartedAt: '2026-09-01T12:00:00Z', sourceEndedAt: '2026-10-01T12:00:00Z', reportedCountries: ['DE'], publisherPlatforms: ['SNAPCHAT'] });
  });
});

describe('immutable projections and comparable changes', () => {
  it('orders tied timestamps by ID, deduplicates replay, and does not fill unobserved dates', () => {
    const a = fact('a', '2026-10-08T01:00:00Z'), b = fact('b', '2026-10-08T01:00:00Z');
    const c = fact('c', '2026-10-10T01:00:00Z');
    const values = [c,b,a,a]; const order = values.map(f => f.observationId);
    const result = projectAdHistory({ adId: 'ad', facts: values });
    expect(result.days.map(d => [d.day, d.observationCount, d.latestObservationId])).toEqual([['2026-10-08',2,'b'],['2026-10-10',1,'c']]);
    expect(values.map(f => f.observationId)).toEqual(order);
    result.days[0].observationIds.push('mutated'); result.days[0].lastObservedAt.setTime(0);
    expect(projectAdHistory({ adId:'ad', facts: values }).days[0].observationIds).toEqual(['a','b']);
    expect(b.observedAt.toISOString()).toBe('2026-10-08T01:00:00.000Z');
  });
  it('keeps unknown distinct from inactive, and retains conflicting explicit states', () => {
    const facts = [fact('a', '2026-10-08T01:00:00Z'), fact('b', '2026-10-08T02:00:00Z', { sourceStatus: 'UNKNOWN' })];
    const result = projectAdHistory({adId:'ad', facts});
    expect(result.changes).toEqual([]);
    expect(result.days[0]).toMatchObject({ latestSourceStatus:'UNKNOWN', hasStateConflict:false, observationCount:2, activeObservationCount:1, inactiveObservationCount:0 });
    const conflict = projectAdHistory({adId:'ad', facts:[...facts, fact('c','2026-10-08T03:00:00Z',{sourceStatus:'INACTIVE'})]});
    expect(conflict.days[0].hasStateConflict).toBe(true);
    expect(conflict.days[0]).toMatchObject({activeObservationCount:1,inactiveObservationCount:1});
    expect(conflict.changes).toEqual([]); // the adjacent UNKNOWN cannot prove a state transition
  });
  it('reports explicit status and all comparable content changes against their exact evidence IDs', () => {
    const a = fact('a', '2026-10-08T01:00:00Z');
    const value = input('b','2026-10-09T01:00:00Z',{ sourceStatus:'INACTIVE', snapshot:{body:'New body',headline:'New title',cta:'Learn more',landingPageUrl:'https://shop.example/new'}, comparableFields:['body','headline','cta','landingPageUrl'] });
    const result = projectAdHistory({adId:'ad',facts:[normalizeHistoryFact(value),a]});
    expect(result.changes.map(e=>e.type)).toEqual(['STATUS_CHANGED','BODY_CHANGED','HEADLINE_CHANGED','CTA_CHANGED','LANDING_PAGE_CHANGED']);
    expect(result.changes.every(e=>e.beforeObservationId==='a'&&e.afterObservationId==='b')).toBe(true);
  });
  it.each([
    { snapshot: { body: 'Different...' }, fieldProvenance: {body:{value:'Different...',truncated:true}} },
    { snapshot: { body: 'Different', bodyTruncated: true } },
    { snapshot: { body: 'Different', redactedFields: ['body'] } },
    { snapshot: { body: '[REDACTED]' } },
    { snapshot: { body: null } },
    { snapshot: { body: 'Different', contentAvailability:'SOURCE_UNAVAILABLE' } },
    { snapshot: { body: 'Different' }, fieldProvenance:{} },
    { snapshot: { body: 'Different' }, comparableFields:[] },
  ])('does not treat unavailable, truncated, redacted or legacy fields as edits (%j)', extra => {
    const result = projectAdHistory({adId:'ad',facts:[fact('a','2026-10-08T01:00:00Z'),fact('b','2026-10-09T01:00:00Z',extra)]});
    expect(result.changes).toEqual([]);
  });
  it('recognizes Pinterest provenance while rejecting its truncated caption', () => {
    const value = input(); value.run.sourceKey='pinterest_ads_repository';
    Object.assign(value.observation,{parserVersion:'pinterest-public-dom-1', snapshot:{headline:'Pin title',body:'Pin body…',bodyTruncated:true},fieldProvenance:{source:'pinterest-public-dom',evidenceSha256:hashA}});
    expect(normalizeHistoryFact(value).comparableFields).toEqual(['headline']);
  });
  it('does not compare translated text or different Google variants', () => {
    const a=fact('a','2026-10-08T01:00:00Z',{snapshot:{body:'Original',languages:['en']}});
    const b=fact('b','2026-10-09T01:00:00Z',{snapshot:{body:'Traducido',languages:['es']}});
    expect(projectAdHistory({adId:'ad',facts:[a,b]}).changes).toEqual([]);
    const first=input('g1'), second=input('g2','2026-10-09T01:00:00Z');
    for(const value of [first,second]){value.run.sourceKey='google_ads_transparency';Object.assign(value.observation,{sourceStatus:'UNKNOWN',snapshot:{body:value===first?'A':'B',variantsComplete:true,variant:{index:value===first?1:2,total:2}},comparableFields:['body']});}
    expect(projectAdHistory({adId:'ad',facts:[normalizeHistoryFact(first),normalizeHistoryFact(second)]}).changes).toEqual([]);
  });
  it('uses only media linked to the observation and ignores signed URL rotation with equal SHA', () => {
    const first=input('a'), second=input('b','2026-10-09T01:00:00Z');
    for(const [i,value] of [first,second].entries()){
      Object.assign(value.observation,{snapshot:{body:'Original body',media:[{url:`https://cdn.example/item?signature=${i}`,type:'image'}]}});
      value.media=[{observationId:i===0?'a':'b',sourceUrl:`https://cdn.example/item?signature=${i}`,sha256:hashA,status:'READY'},{observationId:'unrelated',sha256:hashB}];
    }
    const a=normalizeHistoryFact(first),b=normalizeHistoryFact(second);
    expect(a.mediaHashes).toEqual([hashA]);expect(a.contentKey).toBe(b.contentKey);
    expect(projectAdHistory({adId:'ad',facts:[a,b]}).changes).toEqual([]);
    first.media=[{observationId:'unrelated',sha256:hashB}];
    expect(normalizeHistoryFact(first).mediaHashes).toEqual([]);
  });
  it('reports a changed complete associated media set, but never partial or failed downloads', () => {
    const make=(id:string,sha:string,extra=false)=>{const value=input(id,id==='a'?'2026-10-08T01:00:00Z':'2026-10-09T01:00:00Z');Object.assign(value.observation,{snapshot:{media:[{url:'https://cdn.example/one.jpg'},...(extra?[{url:'https://cdn.example/missing.jpg'}]:[])]}});value.media=[{observationId:id,sourceUrl:'https://cdn.example/one.jpg',sha256:sha,status:'READY'}];return normalizeHistoryFact(value);};
    expect(projectAdHistory({adId:'ad',facts:[make('a',hashA),make('b',hashB)]}).changes.map(e=>e.type)).toEqual(['MEDIA_CHANGED']);
    expect(projectAdHistory({adId:'ad',facts:[make('a',hashA),make('b',hashB,true)]}).changes).toEqual([]);
  });
  it('blocks landing URLs containing credentials or token/signature parameters from comparable content', () => {
    const value=input();Object.assign(value.observation,{snapshot:{landingPageUrl:'https://shop.example/?access_token=secret'},comparableFields:['landingPageUrl']});
    const result=normalizeHistoryFact(value);expect(result.landingPageUrl).toBeNull();expect(result.comparableFields).toEqual([]);
  });
});

describe('known historical parser defects',()=>{
  it('does not revive corrected Meta UI labels as headline evidence',()=>{
    for(const headline of ['Platforms','EU transparency','This ad has multiple versions']){
      const value=input();value.observation.parserVersion='meta-service-dom-1';value.observation.snapshot.headline=headline;value.observation.fieldProvenance.headline={value:headline};
      const normalized=normalizeHistoryFact(value);expect(normalized.headline).toBeNull();expect(normalized.comparableFields).not.toContain('headline');
    }
  });
  it('retains unknown query scope for legacy imports with import metadata',()=>{
    const value=input();value.observation.parserVersion='legacy-public-import-1';
    expect(normalizeHistoryFact(value).scope.kind).toBe('LEGACY_UNKNOWN');
  });
});
