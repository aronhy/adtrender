import {describe,it,expect,vi} from 'vitest';
import {loadStudioState,updateStudioState} from './workspace-service';
import {DomainError} from '../team/access';
vi.mock('../team/access',async importOriginal=>({...await importOriginal<any>(),requireWorkspaceRole:vi.fn(async(_db:any,userId:string,workspaceId:string,write=false)=>{if(userId==='outside'||workspaceId==='foreign'||(write&&userId==='viewer'))throw new DomainError(403,'WORKSPACE_FORBIDDEN');return {organization:{id:'org'},workspace:{id:workspaceId},membership:{role:userId==='viewer'?'MEMBER':'OWNER'}};})}));
function fixture(){let row:any=null;return {$executeRaw:vi.fn(async()=>0),$transaction:async(fn:any)=>fn(db),studioPreference:{findUnique:vi.fn(async()=>row),upsert:vi.fn(async({create,update}:any)=>row=row?{...row,...update}:{...create}),},advertiser:{findUnique:vi.fn(async({where}:any)=>where.id==='missing'?null:{id:where.id}),findMany:vi.fn(async({where}:any)=>where.id.in.filter((id:string)=>id!=='missing').map((id:string)=>({id})))},auditEvent:{findMany:vi.fn(async()=>[{id:'audit',action:'SUBSCRIPTION_CANCELLATION_SCHEDULED',createdAt:new Date('2026-10-22'),metadata:{}}])},subscription:{findUnique:vi.fn(async()=>null)}};var db:any;}
const db:any={};
describe('workspace studio persistence and authorization',()=>{
 it('hides followed IDs after the advertiser is removed without writing during the read',async()=>{
  const d:any=fixture();d.$transaction=(fn:any)=>fn(d);await updateStudioState(d,'owner',{workspaceId:'workspace',type:'FOLLOW_BRAND',advertiserId:'brand'});const writes=d.studioPreference.upsert.mock.calls.length;
  d.advertiser.findMany.mockResolvedValue([]);
  expect((await loadStudioState(d,'owner','workspace')).followedAdvertiserIds).toEqual([]);
  expect(d.studioPreference.upsert.mock.calls.length).toBe(writes);
 });
 it('allows removing an owned historical follow after the advertiser is removed',async()=>{
  const d:any=fixture();d.$transaction=(fn:any)=>fn(d);await updateStudioState(d,'owner',{workspaceId:'workspace',type:'FOLLOW_BRAND',advertiserId:'brand'});
  d.advertiser.findUnique.mockResolvedValue(null);d.advertiser.findMany.mockResolvedValue([]);
  await expect(updateStudioState(d,'owner',{workspaceId:'workspace',type:'UNFOLLOW_BRAND',advertiserId:'brand'})).resolves.toMatchObject({followedAdvertiserIds:[]});
  expect(d.studioPreference.upsert.mock.calls.at(-1)[0].update.followedAdvertiserIds).toEqual([]);
 });
 it('prunes missing historical advertisers before enforcing the 500-brand limit for a new follow',async()=>{
  const d:any=fixture();d.$transaction=(fn:any)=>fn(d);const ids=Array.from({length:500},(_,i)=>'stale-'+i);
  d.studioPreference.findUnique.mockResolvedValue({followedAdvertiserIds:ids,preferences:{}});d.advertiser.findMany.mockImplementation(async({where}:any)=>where.id.in.filter((id:string)=>id==='new-brand').map((id:string)=>({id})));
  await expect(updateStudioState(d,'owner',{workspaceId:'workspace',type:'FOLLOW_BRAND',advertiserId:'new-brand'})).resolves.toBeDefined();
  expect(d.studioPreference.upsert.mock.calls.at(-1)[0].update.followedAdvertiserIds).toEqual(['new-brand']);
 });

 it('returns defaults without creating records',async()=>{const d:any=fixture();d.$transaction=(fn:any)=>fn(d);const state=await loadStudioState(d,'owner','workspace');expect(state.followedAdvertiserIds).toEqual([]);expect(state.preferences.defaultDays).toBe(30);expect(d.studioPreference.upsert).not.toHaveBeenCalled();expect(d.auditEvent.findMany.mock.calls[0][0].where.organizationId).toBe('org');});
 it('rejects another workspace before exposing state',async()=>{const d:any=fixture();await expect(loadStudioState(d,'outside','foreign')).rejects.toMatchObject({status:403});expect(d.studioPreference.findUnique).not.toHaveBeenCalled();});
 it('persists followed IDs idempotently and removes only the selected brand',async()=>{const d:any=fixture();d.$transaction=(fn:any)=>fn(d);await updateStudioState(d,'owner',{workspaceId:'workspace',type:'FOLLOW_BRAND',advertiserId:'brand'});await updateStudioState(d,'owner',{workspaceId:'workspace',type:'FOLLOW_BRAND',advertiserId:'brand'});expect((await loadStudioState(d,'owner','workspace')).followedAdvertiserIds).toEqual(['brand']);await updateStudioState(d,'owner',{workspaceId:'workspace',type:'UNFOLLOW_BRAND',advertiserId:'brand'});expect((await loadStudioState(d,'owner','workspace')).followedAdvertiserIds).toEqual([]);});
 it('rejects a missing brand and a viewer follow mutation',async()=>{const d:any=fixture();d.$transaction=(fn:any)=>fn(d);await expect(updateStudioState(d,'owner',{workspaceId:'workspace',type:'FOLLOW_BRAND',advertiserId:'missing'})).rejects.toMatchObject({code:'ADVERTISER_NOT_FOUND'});await expect(updateStudioState(d,'viewer',{workspaceId:'workspace',type:'FOLLOW_BRAND',advertiserId:'brand'})).rejects.toMatchObject({status:403});});
 it('stores personal preferences under the authenticated user and validates field values',async()=>{const d:any=fixture();d.$transaction=(fn:any)=>fn(d);await updateStudioState(d,'viewer',{workspaceId:'workspace',type:'UPDATE_PREFERENCES',preferences:{defaultDays:7,emailDigest:false}});const state=await loadStudioState(d,'viewer','workspace');expect(state.preferences).toMatchObject({defaultDays:7,emailDigest:false,brandChanges:true});expect(d.studioPreference.upsert.mock.calls[0][0].where.userId_workspaceId).toEqual({userId:'viewer',workspaceId:'workspace'});await expect(updateStudioState(d,'viewer',{workspaceId:'workspace',type:'UPDATE_PREFERENCES',preferences:{defaultDays:999}})).rejects.toThrow();});
});
