// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {AdView,MediaView} from '../types';
vi.mock('../App',()=>({useApp:vi.fn(),errorLabel:vi.fn()}));
vi.mock('wasp/client/operations',()=>({getCustomerSnapshot:{},getStudioCatalog:{},getStudioState:{},useQuery:vi.fn()}));
import {StudioMedia} from './StudioWidgets';
let root:Root,container:HTMLDivElement;
const media=(id:string,expires:string|null='2026-10-22T12:00:00Z'):MediaView=>({id,type:'IMAGE',status:'READY',displayUrl:'https://media.example.test/'+id,displayUrlExpiresAt:expires});
async function render(rows:MediaView[],retry=vi.fn()){await act(async()=>root.render(createElement(StudioMedia,{ad:{id:'ad-real',headline:'Creative',media:rows} as AdView,onRetry:retry})));return retry;}
async function fail(){await act(async()=>container.querySelector('img,video')!.dispatchEvent(new Event('error')));}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-22T12:05:01Z'));container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();vi.unstubAllGlobals();});
describe('expired snapshot media capabilities',()=>{
 it('refreshes the same ad query once when an expired URL fails, then uses an available alternate',async()=>{const retry=await render([media('expired-one'),media('expired-two')]);await fail();expect(retry).toHaveBeenCalledTimes(1);expect(container.querySelector('img')?.getAttribute('src')).toContain('expired-two');await fail();expect(retry).toHaveBeenCalledTimes(1);expect(container.textContent).toContain('素材暂时加载失败');});
 it('uses alternates without refetching for an ordinary failure before URL expiry',async()=>{const retry=await render([media('temporary','2026-10-22T12:10:00Z'),media('alternate',null)]);await fail();expect(retry).not.toHaveBeenCalled();expect(container.querySelector('img')?.getAttribute('src')).toContain('alternate');});
 it('does not refresh for unavailable expiry metadata, and accepts renewed URLs after refetch',async()=>{const retry=await render([media('untracked',null)]);await fail();expect(retry).not.toHaveBeenCalled();await render([media('renewed','2026-10-22T12:10:00Z')],retry);expect(container.querySelector('img')?.getAttribute('src')).toContain('renewed');});
 it('does not wait for a timer or refresh the page before the expired media is requested',async()=>{const retry=await render([media('lazy')]);expect(retry).not.toHaveBeenCalled();expect(container.querySelector('img')?.getAttribute('loading')).toBe('lazy');});
});
