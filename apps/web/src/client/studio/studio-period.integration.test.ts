// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture=vi.hoisted(()=>({
  preferences:{defaultDays:7},
  calls:[] as Array<{operation:string;args:Record<string,unknown>}>,
  refetch:vi.fn(async()=>undefined),
  state:{selectedWorkspace:{id:'workspace'},role:'OWNER',research:{savedAds:[],notes:[]},overview:{savedCount:0}},
}));
vi.mock('../App',()=>({useApp:()=>({state:fixture.state,run:vi.fn()}),errorLabel:(error:unknown)=>String(error)}));
vi.mock('wasp/client/operations',()=>({
  getStudioState:'preferences',getStudioCatalog:'catalog',getAppState:vi.fn(),studioCommand:vi.fn(),
  getPublicAd:'ad',getPublicAdHistory:'history',getPublicRelatedAds:'related',searchPublicAds:'search',
  useQuery:(operation:string,args:Record<string,unknown>)=>{
    fixture.calls.push({operation,args});
    const data=operation==='preferences'?{preferences:fixture.preferences}
      :operation==='ad'?{ad:{id:'ad-real',publisherPlatforms:[],media:[],status:'unknown',firstObservedAt:'2026-10-01T00:00:00Z'},media:[]}
      :operation==='history'?{days:[]}
      :operation==='search'?{ads:[],summary:{total:23},nextCursor:null}:undefined;
    return {data,isLoading:false,isFetching:false,error:null,refetch:fixture.refetch};
  },
}));
import { StudioTrend } from './StudioWidgets';
import { StudioAdDetailPage, StudioAdsPage } from './StudioAds';

let container:HTMLDivElement,root:Root;
beforeEach(()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-21T17:00:00Z'));
  fixture.preferences={defaultDays:7};fixture.calls=[];
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();vi.unstubAllGlobals();});
const rows=[{date:'2026-09-30',count:100},{date:'2026-10-10',count:8},{date:'2026-10-16',count:1},{date:'2026-10-22',count:1},{date:'2026-10-23',count:999}];

describe('persisted default chart period consumers',()=>{
  it('clips by Beijing calendar days, updates the plotted total and labels when the preference changes',async()=>{
    await act(async()=>root.render(createElement(StudioTrend,{rows})));
    expect(container.querySelector('.sa-chart-total')?.textContent).toBe('2');
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain('最近7天共2条');
    expect(container.textContent).toContain('2026-10-16 至 2026-10-22');
    fixture.preferences={defaultDays:14};
    await act(async()=>root.render(createElement(StudioTrend,{rows})));
    expect(container.querySelector('.sa-chart-total')?.textContent).toBe('10');
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain('最近14天共10条');
    expect(container.textContent).not.toContain('最近 30 天');
  });
  it('shows an explicit empty period instead of graphing older or future records',async()=>{
    fixture.preferences={defaultDays:30};
    await act(async()=>root.render(createElement(StudioTrend,{rows:[{date:'2026-09-01',count:25},{date:'2026-10-22',count:0}]})));
    expect(container.textContent).toContain('最近 30 天暂无首次收录广告');
    expect(container.querySelector('.sa-chart-total')?.textContent).toBe('0');
    expect(container.querySelector('svg[role="img"]')).toBeNull();
  });
  it('requests ad observation history with the same saved period, without pretending the snapshot has daily observations',async()=>{
    await act(async()=>root.render(createElement(MemoryRouter,{initialEntries:['/app/ads/ad-real']},createElement(Routes,null,
      createElement(Route,{path:'/app/ads/:adId',element:createElement(StudioAdDetailPage)})))));
    expect(fixture.calls.find(call=>call.operation==='history')?.args).toMatchObject({workspaceId:'workspace',adId:'ad-real',from:'2026-10-16',to:'2026-10-22'});
    expect(container.textContent).toContain('最近 7 天暂无观测记录');
  });
  it('keeps the ad library and its full matching count independent of the chart period',async()=>{
    await act(async()=>root.render(createElement(MemoryRouter,null,createElement(StudioAdsPage))));
    expect(container.textContent).toContain('23 条匹配广告');
    const args=fixture.calls.find(call=>call.operation==='search')!.args;
    expect(args).not.toHaveProperty('observedFrom');
    expect(args).not.toHaveProperty('days');
  });
});
