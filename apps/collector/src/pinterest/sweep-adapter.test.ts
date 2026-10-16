import {beforeEach,expect,it,vi} from 'vitest';
import {chromium} from 'playwright';
import {collectSweepPage} from './sweep-adapter';
vi.mock('playwright',()=>({chromium:{launch:vi.fn()}}));
const timeout=()=>Object.assign(new Error('synthetic timeout'),{name:'TimeoutError'});
const shard={id:'synthetic',country:'DE',start:'2026-10-01',end:'2026-10-02',page:0,failures:0};
let detail:any,list:any,close:any;
beforeEach(()=>{
 const values:Record<string,string>={'#startDate':'10/01/2026','#endDate':'10/02/2026'};
 const locator=(selector:string):any=>({first(){return this;},waitFor:vi.fn(async()=>{}),count:async()=>1,evaluateAll:async()=>selector==='#country option'?[{code:'DE',name:'Germany'}]:['ALL'],selectOption:async()=>{},fill:async()=>{},press:async()=>{},inputValue:async()=>values[selector],innerText:async()=> 'Repository',getAttribute:async()=> 'true',isEnabled:async()=>false,click:async()=>{}});
 list={setDefaultTimeout:vi.fn(),on:vi.fn(),goto:async()=>({status:()=>200}),locator, getByRole:()=>locator('button'),getByPlaceholder:()=>locator('input'),waitForResponse:vi.fn(async()=>({status:()=>200})),waitForFunction:async()=>{},waitForTimeout:async()=>{},url:()=> 'https://ads.pinterest.com/ads-repository/',evaluate:async(input:Function|string)=>{
  if(typeof input==='string')return input.includes('return parsePinterestCards')?[]:['/ads-repository/123/'];
  return input.toString().includes('cloneNode')?{text:'Repository',html:'<main>Repository</main>'}:true;
 }};
 detail={setDefaultTimeout:vi.fn(),goto:vi.fn(async()=>({status:()=>200})),locator:()=>({first:()=>({waitFor:vi.fn(async()=>{})})}),url:()=> 'https://ads.pinterest.com/ads-repository/123/',evaluate:vi.fn(async(input:Function|string)=>typeof input==='string'?{fields:{'Advertiser name':'Synthetic',Countries:'Germany'},media:[]}:{text:'Synthetic detail',html:'<main>Synthetic detail</main>'}),waitForTimeout:async()=>{}};
 close=vi.fn(async()=>{});vi.mocked(chromium.launch).mockResolvedValue({newContext:async()=>({newPage:vi.fn().mockResolvedValueOnce(list).mockResolvedValueOnce(detail)}),close} as any);
});
it.each([[403,'ACCESS_BLOCKED'],[429,'RATE_LIMITED'],[503,'DETAIL_HTTP_ERROR']])('classifies detail HTTP %s before a missing title and preserves the response',async(status,code)=>{
 detail.goto.mockResolvedValue({status:()=>status});const wait=vi.fn(async()=>{throw timeout();});detail.locator=()=>({first:()=>({waitFor:wait})});
 const {batch}=await collectSweepPage(shard as any);
 expect(batch).toMatchObject({status:'FAILED',errorCode:code,coverage:{observedCards:1,selected:0}});
 expect(batch.evidence.at(-1)).toMatchObject({httpStatus:status,text:'Synthetic detail'});expect(wait).not.toHaveBeenCalled();expect(close).toHaveBeenCalled();
});
it('archives the failed detail on a genuine title timeout and retains observed listing coverage',async()=>{
 detail.locator=()=>({first:()=>({waitFor:async()=>{throw timeout();}})});
 const {batch}=await collectSweepPage(shard as any);
 expect(batch).toMatchObject({status:'FAILED',errorCode:'DETAIL_TIMEOUT',coverage:{observedCards:1,selected:0}});expect(batch.evidence).toHaveLength(2);expect(batch.evidence[1].httpStatus).toBe(200);
});
it('recognizes a challenge displayed instead of detail content',async()=>{
 detail.locator=()=>({first:()=>({waitFor:async()=>{throw timeout();}})});detail.evaluate.mockResolvedValue({text:'Verify you are human',html:'<main>Verify you are human</main>'});
 const {batch}=await collectSweepPage(shard as any);expect(batch.errorCode).toBe('CHALLENGE');expect(batch.ads).toHaveLength(0);expect(batch.evidence).toHaveLength(2);
});
it('keeps strict successful detail parsing and the exact HEX64 source identity',async()=>{
 const hex='Ab'.repeat(32),old=list.evaluate;list.evaluate=async(x:any)=>typeof x==='string'&&!x.includes('return parsePinterestCards')?[`/ads-repository/${hex}/`]:old(x);
 const {batch,nextPage}=await collectSweepPage(shard as any);expect(batch).toMatchObject({status:'SUCCEEDED',errorCode:null});expect(batch.ads[0]).toMatchObject({sourceAdId:hex,sourceUrl:`https://ads.pinterest.com/ads-repository/${hex}/`,advertiserName:'Synthetic'});expect(nextPage).toBe(1);
});
it('handles a response-wait rejection immediately while authorization is still pending',async()=>{
 let phases=0;const guard:any={beforeRequest:async(phase:string)=>{if(phase==='LIST'&&++phases===2)await new Promise(r=>setTimeout(r,20));}};
 list.waitForResponse=()=>Promise.reject(timeout());
 const {batch}=await collectSweepPage(shard as any,{guard});expect(batch.errorCode).toBe('TIMEOUT');expect(close).toHaveBeenCalled();
});

it('keeps earlier ads and the current page when a later detail is rate limited',async()=>{
 const old=list.evaluate;list.evaluate=async(x:any)=>typeof x==='string'&&!x.includes('return parsePinterestCards')?['/ads-repository/123/','/ads-repository/456/']:old(x);
 detail.goto.mockResolvedValueOnce({status:()=>200}).mockResolvedValueOnce({status:()=>429});
 const {batch,nextPage,exhausted}=await collectSweepPage(shard as any);
 expect(batch).toMatchObject({status:'PARTIAL',errorCode:'RATE_LIMITED',coverage:{observedCards:2,selected:1}});expect(batch.ads).toHaveLength(1);expect(batch.evidence).toHaveLength(3);expect(nextPage).toBe(0);expect(exhausted).toBe(false);
});
it('does not interpret an advertiser creative mentioning a captcha as a challenge on a valid detail',async()=>{
 const old=detail.evaluate.getMockImplementation();detail.evaluate.mockImplementation((x:any)=>typeof x==='string'?old(x):{text:'Synthetic captcha product',html:'<main>Synthetic captcha product</main>'});
 expect((await collectSweepPage(shard as any)).batch.status).toBe('SUCCEEDED');
});
