// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { parseMetaDocument, classifyMetaPage, parseMetaEmbeddedAdvertisers } from './meta-parser';
import { validateCollectionQuery } from '../../../packages/contracts/src/collection';
import { collectMetaAds, buildMetaSearchUrl, configuredMetaBrowserChannel } from './meta-adapter';

const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/meta-cards.synthetic.html'), 'utf8');
const query = {keyword:'furniture',country:'US',status:'all' as const,mediaType:'all' as const,limit:20};
const browserState = vi.hoisted(() => ({status:200,launchError:null as string|null,launchOptions:{} as Record<string,unknown>,readinessTimeout:false,pages:[] as string[],index:0,failAfter:undefined as number|undefined,launches:0,closed:0,laterHttp:undefined as number|undefined,responseHandler:undefined as undefined|((response:{status:()=>number;url:()=>string;request:()=>{resourceType:()=>string}})=>void)}));
vi.mock('playwright', () => ({chromium:{launch:async(options:Record<string,unknown>)=>{
  browserState.launchOptions=options; if(browserState.launchError)throw new Error(browserState.launchError);
  browserState.launches++;
  return {close:async()=>{browserState.closed++;},newContext:async()=>({newPage:async()=>({
    on:(_event:string,handler:typeof browserState.responseHandler)=>{browserState.responseHandler=handler;},
    goto:async()=>({status:()=>browserState.status}),
    url:()=> 'https://www.facebook.com/ads/library/',
    content:async()=>browserState.pages[browserState.index]??'',
    waitForFunction:async()=>{if(browserState.readinessTimeout)throw new Error('Timeout awaiting source readiness');},
    locator:()=>({innerText:async()=>new DOMParser().parseFromString(browserState.pages[browserState.index]??'','text/html').body.textContent??''}),
    evaluate:async(expression:string|unknown)=>{
      if(typeof expression!=='string')return;
      if(browserState.failAfter===browserState.index)throw new Error('Timeout fixture transport');
      const doc=new DOMParser().parseFromString(browserState.pages[browserState.index]??'','text/html');
      return new Function('document',`return ${expression}`)(doc);
    },
    waitForTimeout:async()=>{browserState.index=Math.min(browserState.index+1,browserState.pages.length-1);if(browserState.laterHttp)browserState.responseHandler?.({status:()=>browserState.laterHttp!,url:()=>"https://www.facebook.com/api/graphql/",request:()=>({resourceType:()=>"xhr"})});},
  })})};
}}}));
beforeEach(()=>{browserState.status=200;browserState.launchError=null;browserState.launchOptions={};browserState.readinessTimeout=false;browserState.pages=[fixture];browserState.index=0;browserState.failAfter=undefined;browserState.launches=0;browserState.closed=0;browserState.laterHttp=undefined;browserState.responseHandler=undefined;});
function parse(html:string){return parseMetaDocument(new DOMParser().parseFromString(html,'text/html'),'US');}

describe('Meta DOM source evidence',()=>{
  it('keeps the advertiser avatar separate from creative media for an Instagram placement',()=>{
    const ad=parse(fixture).ads.find(ad=>ad.sourceAdId==='100001')!;
    expect(ad.advertiserAvatarUrl).toBe('https://cdn.example/avatar.jpg');
    expect(ad.platforms).toContain('Instagram');
    expect(ad.media.some(media=>media.url===ad.advertiserAvatarUrl)).toBe(false);
  });
  it('does not accept an unsafe avatar or use the large creative image as the brand',()=>{
    const ad=parse(fixture.replaceAll('https://cdn.example/avatar.jpg','javascript:alert(1)')).ads[0];
    expect(ad.advertiserAvatarUrl??null).toBeNull();
    const withoutAvatar=parse(fixture.replace(/<img alt="Sample Studio"[^>]*>/g,''));
    expect(withoutAvatar.ads[0].advertiserAvatarUrl??null).toBeNull();
  });
  it('retains text-only cards, merging repeated source IDs without splitting media into ads',()=>{
    const result=parse(fixture);
    expect(result.observedCardCount).toBe(3);
    expect(result.ads).toHaveLength(2);
    expect(result.ads[1]).toMatchObject({sourceAdId:'100002',body:'Text-only source ad must survive.',media:[],advertiserName:null,status:'unknown',startDate:null,platforms:null});
  });
  it('keeps mixed image/video media and source URLs while excluding avatars',()=>{
    const ad=parse(fixture).ads[0];
    expect(ad).toMatchObject({source:'meta',sourceAdId:'100001',advertiserName:'Sample Studio',advertiserPageUrl:'https://www.facebook.com/sample.studio',body:'Furniture for independent shops.',headline:'Chairs made to last',description:'Available in natural oak',cta:'Shop Now',platforms:['Instagram'],queryCountry:'US',startDate:'2026-08-01',landingPageUrl:'https://shop.example/chairs'});
    expect(ad.media.map(m=>[m.type,m.url])).toEqual([['image','https://cdn.example/chair.jpg'],['video','https://cdn.example/chair.mp4'],['image','https://cdn.example/second.jpg']]);
  });
  it('leaves missing fields null and does not invent Facebook from a page URL',()=>{
    const ad=parse('<div><span>Library ID: 300001</span><a href="https://www.facebook.com/shop">Shop</a></div>').ads[0];
    expect(ad).toMatchObject({body:null,headline:null,description:null,cta:null,platforms:null,status:'unknown',startDate:null,endDate:null});
  });
  it('rejects unsafe source protocols including encoded redirect targets',()=>{
    const ad=parse('<div><span>Library ID: 400001</span><div style="white-space: pre-wrap">Copy</div><a href="https://l.facebook.com/l.php?u=javascript%3Aalert(1)"><img alt="" width="600" src="data:image/png,abc"></a><video src="blob:local" poster="file:///tmp/a"></video></div>').ads[0];
    expect(ad.media).toEqual([]);expect(ad.landingPageUrl).toBeNull();
  });
  it('rejects impossible dates and detects English inactive without active substring confusion',()=>{
    const ad=parse('<div><span>Inactive</span><span>Library ID: 500001</span><span>2026年2月31日开始投放</span><span>Stopped running on Sep 2, 2026</span></div>').ads[0];
    expect(ad).toMatchObject({status:'inactive',startDate:null,endDate:'2026-09-02'});
  });
  it('counts malformed source IDs as rejected cards instead of silently losing evidence',()=>{
    const result=parse('<section><div><span>Library ID: 100009</span><div style="white-space: pre-wrap">Valid copy</div></div><div><span>Library ID: missing</span></div></section>');
    expect(result).toMatchObject({observedCardCount:2,rejectedCardCount:1});expect(result.ads).toHaveLength(1);
  });
  it('gives restrictions priority over stale cards and explicit zero results',()=>{
    expect(classifyMetaPage('Library ID: 123456 Security Check')).toBe('challenge');
    expect(classifyMetaPage('No results found Log in to Facebook')).toBe('login-required');
    expect(classifyMetaPage('No ads match your search criteria')).toBe('no-results');
  });
});
describe('bounded collection adapter',()=>{
  it.each([{...query,limit:21},{...query,limit:0},{...query,limit:1.5},{...query,country:'../../../'},{...query,keyword:' '},{...query,status:'unknown'},{...query,mediaType:'html'}])('rejects an unsupported query before browser work: %j',(invalid)=>{
    expect(()=>validateCollectionQuery(invalid)).toThrow();
  });
  it('reads only a whitelisted environment browser channel',()=>{
    expect(configuredMetaBrowserChannel({})).toBeUndefined();expect(configuredMetaBrowserChannel({META_BROWSER_CHANNEL:' chrome '})).toBe('chrome');expect(configuredMetaBrowserChannel({META_BROWSER_CHANNEL:'chromium'})).toBe('chromium');expect(()=>configuredMetaBrowserChannel({META_BROWSER_CHANNEL:'/private/arbitrary'})).toThrow('META_BROWSER_CHANNEL_INVALID');
  });
  it('accepts only the allowed browser channels before launch',async()=>{
    expect(await collectMetaAds(query,{browserChannel:'firefox'})).toMatchObject({status:'failed',errorCode:'META_BROWSER_CHANNEL_INVALID',retryable:false});expect(browserState.launches).toBe(0);
    await collectMetaAds(query,{browserChannel:'chrome'});expect(browserState.launchOptions.channel).toBe('chrome');
    await collectMetaAds(query,{browserChannel:'chromium'});expect(browserState.launchOptions.channel).toBe('chromium');expect(browserState.launchOptions.chromiumSandbox).toBe(true);
  });
  it('reports missing browser installation without retrying or exposing local paths',async()=>{
    browserState.launchError='browserType.launch: Executable does not exist at /private/secret/path/chromium';
    expect(await collectMetaAds(query)).toMatchObject({status:'failed',errorCode:'META_BROWSER_NOT_INSTALLED',retryable:false});
  });
  it('constructs one fixed public origin and escapes keyword query values',()=>{
    const url=new URL(buildMetaSearchUrl({...query,keyword:'chairs & country=XX'}));
    expect(url.origin).toBe('https://www.facebook.com');expect(url.searchParams.get('q')).toBe('chairs & country=XX');expect(url.searchParams.get('country')).toBe('US');
  });
  it('returns explicit no-results only from explicit source evidence',async()=>{
    browserState.pages=['<body>No ads match your search criteria</body>'];
    expect(await collectMetaAds(query)).toMatchObject({status:'no-results',ads:[],retryable:false,errorCode:null});
    browserState.pages=['<body>Library ID: 777777</body>'];
    expect(await collectMetaAds(query)).toMatchObject({status:'failed',errorCode:'META_PARSE_EMPTY',retryable:false});
  });
  it.each([403,429])('reports HTTP %i restriction without retrying',async(status)=>{
    browserState.status=status;
    expect(await collectMetaAds(query)).toMatchObject({status:'restricted',errorCode:`META_HTTP_${status}`,retryable:false});
    expect(browserState.launches).toBe(1);expect(browserState.closed).toBe(1);
  });
  it('preserves collected ads when a later scroll reaches a source restriction',async()=>{
    browserState.pages=[fixture,'<body>Security Check</body>'];
    expect(await collectMetaAds(query)).toMatchObject({status:'partial',ads:expect.arrayContaining([expect.objectContaining({sourceAdId:'100001'})]),errorCode:'META_SOURCE_CHALLENGE',retryable:false});
  });
  it('preserves ads and stops when a later source request returns HTTP 429',async()=>{
    browserState.laterHttp=429;
    expect(await collectMetaAds(query)).toMatchObject({status:'partial',parsedAdCount:2,errorCode:'META_HTTP_429',retryable:false});
  });
  it('reports a partly broken source page as partial',async()=>{
    browserState.pages=['<section><div><span>Library ID: 100009</span></div><div><span>Library ID: missing</span></div></section>'];
    expect(await collectMetaAds(query)).toMatchObject({status:'partial',parsedAdCount:1,observedCardCount:2,errorCode:'META_PARSE_PARTIAL',retryable:false});
  });
  it('fills formerly unknown fields when the same source card finishes loading',async()=>{
    browserState.pages=['<div><span>Library ID: 100001</span></div>',fixture];
    const result=await collectMetaAds(query);
    expect(result.ads.find(ad=>ad.sourceAdId==='100001')).toMatchObject({body:'Furniture for independent shops.',advertiserName:'Sample Studio',platforms:['Instagram']});
  });
  it('distinguishes a later transport failure from a successful collection',async()=>{
    browserState.pages=[fixture,fixture];browserState.failAfter=1;
    expect(await collectMetaAds(query)).toMatchObject({status:'partial',parsedAdCount:2,errorCode:'META_TIMEOUT',retryable:true});
  });
  it('fails explicitly when raw source evidence cannot be stored',async()=>{
    expect(await collectMetaAds(query,{onEvidence:async()=>{throw new Error('secret-bearing vendor failure');}})).toMatchObject({status:'failed',errorCode:'EVIDENCE_STORAGE_FAILED',ads:[]});
  });
  it('provides raw DOM evidence only to the storage hook',async()=>{
    const evidence:any[]=[];const result=await collectMetaAds(query,{onEvidence:async snapshot=>{evidence.push(snapshot);}});
    expect(evidence[0]).toMatchObject({url:'https://www.facebook.com/ads/library/',html:fixture,parserVersion:'meta-dom-1',httpStatus:200});expect(result).not.toHaveProperty('html');
  });
  it('persists initial source evidence even when source readiness times out',async()=>{
    browserState.pages=['<body>Unexpected public source response</body>'];browserState.readinessTimeout=true;
    const evidence:any[]=[];const result=await collectMetaAds(query,{onEvidence:async snapshot=>{evidence.push(snapshot);}});
    expect(result).toMatchObject({status:'failed',errorCode:'META_TIMEOUT'});expect(evidence).toHaveLength(1);expect(evidence[0].html).toContain('Unexpected public source response');
  });
  it('cancels before launching a browser when the worker lease has expired',async()=>{
    const controller=new AbortController();controller.abort();
    expect(await collectMetaAds(query,{signal:controller.signal})).toMatchObject({status:'cancelled',ads:[],retryable:false});expect(browserState.launches).toBe(0);
  });
});
it('does not turn source UI metadata into an ad headline when dynamic-content wrapper is absent',()=>{
 const ad=parse('<div><span>Library ID: 990001</span><span>Platforms</span><span>This ad has multiple versions</span><span>EU transparency</span><div style="white-space:pre-wrap">Save on your next order.</div><div>Shop the collection</div><div>Shop Now</div></div>').ads[0];
 expect(ad.headline).toBe('Shop the collection');expect(ad.description).toBeNull();
});

const PAYLOAD_FIXTURE = '{"xfb_ad_library_is_captcha_required":false,"ad_library_main":{"search_results_connection":{"count":50001,"edges":[{"node":{"collated_results":[{"ad_archive_id":"810588430746798","collation_count":null,"is_active":false,"page_id":"269617286730030","page_is_deleted":false,"snapshot":{"page_id":"269617286730030","page_profile_uri":"https:\\/\\/www.facebook.com\\/meeshosupply\\/","page_name":"Meesho \\"Supply\\"","cta_text":null,"cards":[]}},{"ad_archive_id":"432428329625718","is_active":true,"page_id":"103778389405737","snapshot":{"page_profile_uri":"https:\\/\\/www.facebook.com\\/103778389405737\\/","page_name":"AjioGram"}}]}}]}}}';

describe('Meta listing payload', () => {
  const build = (script: string) => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    const node = document.createElement('script');
    // The real listing ships its payload in a non-executable script element.
    node.type = 'application/json';
    node.textContent = script;
    document.head.appendChild(node);
    return document;
  };
  it('reads the avatar shipped for the exact ad identity without using another card image',()=>{
    const result=parseMetaEmbeddedAdvertisers(build(PAYLOAD_FIXTURE.replace('"cta_text":null','"page_profile_picture_url":"https:\\u002f\\u002fscontent.fbcdn.net\\u002fbrand.jpg","cta_text":null')));
    expect(result.advertisers[0].advertiserAvatarUrl).toBe('https://scontent.fbcdn.net/brand.jpg');
    expect(result.advertisers[1].advertiserAvatarUrl??null).toBeNull();
  });
  it('reads the numeric page_id the page already shipped, including custom-handle advertisers', () => {
    const result = parseMetaEmbeddedAdvertisers(build(PAYLOAD_FIXTURE));
    expect(result.resultCount).toBe(50001);
    expect(result.advertisers).toHaveLength(2);
    expect(result.advertisers[0]).toEqual({
      sourceAdId: '810588430746798',
      pageId: '269617286730030',
      pageName: 'Meesho "Supply"',
      pageProfileUri: 'https://www.facebook.com/meeshosupply/',
    });
    expect(result.advertisers[1].pageId).toBe('103778389405737');
    expect(result.advertisers[1].pageProfileUri).toBe('https://www.facebook.com/103778389405737/');
  });
  it('returns nothing rather than guessing when the payload is absent or unrecognised', () => {
    expect(parseMetaEmbeddedAdvertisers(build('window.__d=1;'))).toEqual({advertisers: [], resultCount: null});
    const partial = parseMetaEmbeddedAdvertisers(build('{"ad_archive_id":"810588430746798","page_is_deleted":false}'));
    expect(partial.advertisers).toEqual([]);
    expect(partial.resultCount).toBeNull();
  });
  it('does not pair an advertiser with a different card page_id', () => {
    const far = '{"ad_archive_id":"810588430746798"}' + 'x'.repeat(5000) + '{"page_id":"269617286730030"}';
    expect(parseMetaEmbeddedAdvertisers(build(far)).advertisers).toEqual([]);
  });
});
