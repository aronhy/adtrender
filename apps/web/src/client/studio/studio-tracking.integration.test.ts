// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const fixture=vi.hoisted(()=>({ids:['followed-brand'],calls:[] as Array<Record<string,unknown>>,refetch:vi.fn(async()=>undefined)}));
vi.mock('../App',()=>({useApp:()=>({state:{selectedWorkspace:{id:'own-workspace'},role:'OWNER',research:{savedAds:[],notes:[]}},run:vi.fn()}),errorLabel:(error:unknown)=>String(error)}));
vi.mock('wasp/client/operations',()=>({
  getStudioState:'studio-state',getStudioCatalog:'catalog',getPublicAd:'ad',getPublicAdHistory:'history',getPublicRelatedAds:'related',searchPublicAds:'search',getAppState:vi.fn(),studioCommand:vi.fn(),
  useQuery:(operation:string,args:Record<string,unknown>)=>{
    if(operation==='catalog')fixture.calls.push(args);
    const page=Number(args.page)||1;
    const data=operation==='studio-state'?{followedAdvertiserIds:fixture.ids,preferences:{defaultDays:30}}
      :args.kind==='ads'?{stats:{ads:13,active:1,landingPages:1},advertisers:[],ads:fixture.ids.length?[{id:'ad-'+page,advertiserName:'已关注品牌',headline:'第'+page+'页关注素材',publisherPlatforms:[],media:[],status:'unknown'}]:[],total:13,page,pageCount:2}
      :{advertisers:[]};
    return {data,isLoading:false,isFetching:false,error:null,refetch:fixture.refetch};
  },
}));
import {StudioTrackingPage} from './StudioAds';

let container:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);fixture.ids=['followed-brand'];fixture.calls=[];container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.unstubAllGlobals();});
describe('followed advertiser material pagination',()=>{
  it('loads the next real catalog page while preserving the current workspace and personal follows',async()=>{
    await act(async()=>root.render(createElement(MemoryRouter,{initialEntries:['/app/tracking?workspace=own-workspace']},createElement(StudioTrackingPage))));
    expect(container.textContent).toContain('第1页关注素材');
    const next=Array.from(container.querySelectorAll('button')).find(button=>button.textContent==='下一页');
    expect(next).toBeDefined();
    await act(async()=>next!.click());
    expect(container.textContent).toContain('第2页关注素材');
    expect(container.textContent).not.toContain('第1页关注素材');
    expect(fixture.calls.filter(args=>args.kind==='ads').at(-1)).toMatchObject({workspaceId:'own-workspace',advertiserIds:['followed-brand'],page:2,limit:12});
  });
  it('keeps an empty personal follow list empty and offers discovery instead of showing global materials',async()=>{
    fixture.ids=[];
    await act(async()=>root.render(createElement(MemoryRouter,null,createElement(StudioTrackingPage))));
    expect(container.textContent).toContain('还没有关注的广告主');
    expect(container.querySelector('.sa-ad-card')).toBeNull();
    expect(fixture.calls.find(args=>args.kind==='ads')).toMatchObject({workspaceId:'own-workspace',advertiserIds:[]});
  });
});
