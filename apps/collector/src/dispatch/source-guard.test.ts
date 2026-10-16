import {expect,it,vi} from 'vitest';
const launch=vi.hoisted(()=>vi.fn(async()=>{throw Error('UNGUARDED_BROWSER_STARTED');}));vi.mock('playwright',()=>({chromium:{launch,launchPersistentContext:launch}}));
import {collectBatch as meta} from '../meta-service/browser';import {collectBatch as google} from '../google-service/browser';import {collectBatch as snap} from '../snapchat-service/collector';import {collectBatch as tiktok} from '../tiktok-service/browser';import {collectSweepPage as pinterest,discoverPinterest} from '../pinterest/sweep-adapter';
const guard=()=>({beforeRequest:vi.fn(async()=>{throw Error('COLLECTOR_SOURCE_BLOCKED');}),signal:new AbortController().signal,remainingMs:()=>10000,dispose(){}});
for(const source of ['meta','google','snapchat','tiktok','pinterest'] as const)it(source+' checks source authorization before starting browser or API',async()=>{
 const g=guard(),request=vi.fn(async()=>{throw Error('UNGUARDED_API_STARTED');}),job:any={id:'job',country:'DE',language:'en',keyword:'word',kind:source==='google'?'SEARCH':undefined,publisher:'word',term:'',start:'2026-10-01',end:'2026-10-02',page:0,seen:[],lastAttemptAt:0};launch.mockClear();
 try{if(source==='meta')await meta(job,'/tmp/profile',{guard:g} as any);if(source==='google')await google(job,'/tmp/profile',{guard:g} as any);if(source==='snapchat')await snap(job,{guard:g,request} as any);if(source==='tiktok')await tiktok(job,{guard:g} as any);if(source==='pinterest')await pinterest(job,{guard:g} as any);}catch{}
 expect(g.beforeRequest).toHaveBeenCalled();expect(launch).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
});
it('Pinterest discovery checks a guard before opening the source catalog',async()=>{const g=guard();launch.mockClear();await expect(discoverPinterest({guard:g} as any)).rejects.toThrow('COLLECTOR_SOURCE_BLOCKED');expect(launch).not.toHaveBeenCalled();});
