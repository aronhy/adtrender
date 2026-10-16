import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {getAdHistory} from './service';
import {rebuildAdHistory} from './projector';
const url=process.env.SAAS_TEST_DATABASE_URL;
describe.skipIf(!url)('authorized historical ad view on PostgreSQL',()=>{
  let db:PrismaClient,userId:string,workspaceId:string,adId:string,disabledId:string,outsiderId:string;
  beforeAll(async()=>{
    db=new PrismaClient({datasources:{db:{url}}});
    const token=randomUUID();
    const user=await db.user.create({data:{email:`history-${token}@example.test`}});userId=user.id;
    disabledId=(await db.user.create({data:{email:`disabled-history-${token}@example.test`,disabledAt:new Date()}})).id;
    outsiderId=(await db.user.create({data:{email:`outsider-history-${token}@example.test`}})).id;
    const org=await db.organization.create({data:{name:token,slug:token,members:{create:{userId,role:'OWNER'}}}});
    workspaceId=(await db.workspace.create({data:{organizationId:org.id,name:'History',slug:'history'}})).id;
    const source=await db.dataSource.create({data:{name:token,key:`meta-history-${token}`,adapterVersion:'meta-service-dom-1'}});
    const task=await db.collectionTask.create({data:{dataSourceId:source.id,name:token,query:{}}});
    adId=(await db.ad.create({data:{dataSourceId:source.id,sourceAdId:token,sourceUrl:'https://www.facebook.com/ads/library/',body:'CURRENT BODY',sourceStatus:'ACTIVE',sourceStartedAt:new Date('2026-10-01'),statusObservedAt:new Date('2026-10-03')}})).id;
    for(const [at,status,body] of [['2026-10-01T09:00:00Z','ACTIVE','Historical one'],['2026-10-02T09:00:00Z','ACTIVE','Historical two'],['2026-10-02T10:00:00Z','UNKNOWN','Historical three']] as const){
      const run=await db.collectionRun.create({data:{taskId:task.id,dataSourceId:source.id,idempotencyKey:token+at,adapterVersion:'meta-service-dom-1',querySnapshot:{country:'US',language:'en',keyword:'Shop now',access_token:'fixture-private-secret'},coverage:{completeSourceCoverage:false}}});
      await db.adObservation.create({data:{adId,dataSourceId:source.id,collectionRunId:run.id,observedAt:new Date(at),sourceStatus:status,queryCountry:'US',snapshot:{body,private_secret:'fixture-private-secret'},fieldProvenance:{body:{value:body}},parserVersion:'meta-service-dom-1'}});
    }
    await rebuildAdHistory(db,adId);
  });
  afterAll(async()=>{await db?.$disconnect();});
  const input=()=>({userId,workspaceId,adId,from:'2026-10-01',to:'2026-10-04'});
  it('reads historical content and missing days without filling from current Ad',async()=>{
    const result=await getAdHistory(db,input());
    expect(result.summary.observedDays).toBe(2);expect(result.summary.activeObservedDays).toBe(2);
    expect(result.summary.sourceDateSpanDays).toBe(3);
    expect(result.days.find(d=>d.day==='2026-10-02')?.body).toBe('Historical three');
    expect(result.days.find(d=>d.day==='2026-10-02')?.sourceStatus).toBe('UNKNOWN');
    expect(result.days.filter(d=>d.observationState==='NO_OBSERVATION').map(d=>d.day)).toEqual(['2026-10-03','2026-10-04']);
    expect(JSON.stringify(result)).not.toContain('CURRENT BODY');expect(JSON.stringify(result)).not.toContain('fixture-private-secret');
    expect(result.scopes[0]).not.toHaveProperty('queryIdentity');
  });
  it('keeps query ranges separate while counting unique observed dates',async()=>{
    const base=await db.adObservation.findFirstOrThrow({where:{adId},include:{run:true}});
    const token=randomUUID();const run=await db.collectionRun.create({data:{taskId:base.run.taskId,dataSourceId:base.dataSourceId,idempotencyKey:token,adapterVersion:'meta-service-dom-1',querySnapshot:{country:'GB',language:'en',keyword:'Shop now'},coverage:{}}});
    await db.adObservation.create({data:{adId,dataSourceId:base.dataSourceId,collectionRunId:run.id,observedAt:new Date('2026-10-02T11:00:00Z'),sourceStatus:'INACTIVE',queryCountry:'GB',snapshot:{body:'British copy'},fieldProvenance:{body:{value:'British copy'}},parserVersion:'meta-service-dom-1'}});
    await rebuildAdHistory(db,adId);const result=await getAdHistory(db,input());
    expect(result.days.filter(d=>d.day==='2026-10-02')).toHaveLength(2);expect(result.summary.observedDays).toBe(2);expect(result.summary.conflictDays).toBe(0);
    const us=result.scopes.find(s=>s.queryCountry==='US')!;const filtered=await getAdHistory(db,{...input(),scopeHash:us.hash});
    expect(filtered.summary.firstObservedAt).toBe('2026-10-01T09:00:00.000Z');expect(filtered.days.find(d=>d.day==='2026-10-02')?.observationCount).toBe(2);
    expect(filtered.days.find(d=>d.day==='2026-10-02')?.body).toBe('Historical three');
  });
  it('shows legacy observations awaiting backfill as pending instead of claiming missing evidence',async()=>{
    const base=await db.adObservation.findFirstOrThrow({where:{adId},include:{run:true}});
    const created=await db.ad.create({data:{dataSourceId:base.dataSourceId,sourceAdId:randomUUID(),sourceUrl:'https://www.facebook.com/ads/library/'}});
    const run=await db.collectionRun.create({data:{taskId:base.run.taskId,dataSourceId:base.dataSourceId,idempotencyKey:randomUUID(),adapterVersion:'fixture',querySnapshot:{country:'US'}}});
    await db.adObservation.create({data:{adId:created.id,dataSourceId:base.dataSourceId,collectionRunId:run.id,observedAt:new Date('2026-10-01T09:00:00Z'),snapshot:{body:'Unprojected original'},parserVersion:'fixture'}});
    await db.adHistoryProjectionTask.delete({where:{adId:created.id}});
    expect((await getAdHistory(db,{...input(),adId:created.id})).projectionPending).toBe(true);
  });
  it('requires active account and workspace access',async()=>{
    await expect(getAdHistory(db,{...input(),userId:''})).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    await expect(getAdHistory(db,{...input(),userId:disabledId})).rejects.toMatchObject({code:'ACCOUNT_DISABLED'});
    await expect(getAdHistory(db,{...input(),userId:outsiderId})).rejects.toMatchObject({code:'ORGANIZATION_FORBIDDEN'});
  });
  it('rejects invalid/overlong windows and a cursor rebound to another range',async()=>{
    await expect(getAdHistory(db,{...input(),from:'2026-02-30'})).rejects.toMatchObject({code:'INVALID_HISTORY_RANGE'});
    await expect(getAdHistory(db,{...input(),from:'2024-01-01'})).rejects.toMatchObject({code:'INVALID_HISTORY_RANGE'});
    await expect(getAdHistory(db,{...input(),scopeHash:'not-a-hash'})).rejects.toMatchObject({code:'INVALID_HISTORY_SCOPE'});
    const cursor=Buffer.from(JSON.stringify({v:1,fingerprint:'wrong',observedAt:'2026-10-02T10:00:00.000Z',id:'fake'})).toString('base64url');
    await expect(getAdHistory(db,{...input(),eventCursor:cursor})).rejects.toMatchObject({code:'INVALID_HISTORY_CURSOR'});
  });
  async function createEventHistory(equalTimestamps:boolean){
    const base=await db.adObservation.findFirstOrThrow({where:{adId},include:{run:true}});
    const token=randomUUID();
    const historyAdId=(await db.ad.create({data:{dataSourceId:base.dataSourceId,sourceAdId:token,sourceUrl:'https://www.facebook.com/ads/library/'}})).id;
    const runIds:string[]=Array.from({length:122},()=>randomUUID());
    const observationIds=Array.from({length:122},()=>randomUUID());
    const query={country:'US',language:'en',keyword:'Pagination fixture'};
    const start=Date.parse('2026-10-02T09:00:00Z');
    await db.collectionRun.createMany({data:runIds.map((id,index)=>({id,taskId:base.run.taskId,dataSourceId:base.dataSourceId,idempotencyKey:`${token}-${index}`,adapterVersion:'meta-service-dom-1',querySnapshot:query}))});
    await db.adObservation.createMany({data:observationIds.map((id,index)=>({id,adId:historyAdId,dataSourceId:base.dataSourceId,collectionRunId:runIds[index],observedAt:new Date(start+(equalTimestamps?0:index*60000)),sourceStatus:'ACTIVE',queryCountry:'US',snapshot:{body:`Historic copy ${index}`},fieldProvenance:{body:{value:`Historic copy ${index}`}},parserVersion:'meta-service-dom-1'}))});
    await rebuildAdHistory(db,historyAdId);
    return {adId:historyAdId,runIds,taskId:base.run.taskId,dataSourceId:base.dataSourceId,query,start};
  }
  async function removeEventHistory(fixture:Awaited<ReturnType<typeof createEventHistory>>){
    await db.$transaction([
      db.adHistoryEvent.deleteMany({where:{adId:fixture.adId}}),
      db.adDailySnapshot.deleteMany({where:{adId:fixture.adId}}),
      db.adObservation.deleteMany({where:{adId:fixture.adId}}),
      db.ad.delete({where:{id:fixture.adId}}),
      db.collectionRun.deleteMany({where:{id:{in:fixture.runIds}}}),
    ]);
  }
  it('paginates more than 100 same-time events without duplicates or omissions and binds the cursor to scope',async()=>{
    const fixture=await createEventHistory(true);
    try{
      const query={...input(),adId:fixture.adId};
      const first=await getAdHistory(db,query);
      expect(first.events).toHaveLength(100);expect(first.nextEventCursor).toBeTruthy();
      const next=await getAdHistory(db,{...query,eventCursor:first.nextEventCursor!});
      expect(next.events).toHaveLength(21);expect(next.nextEventCursor).toBeNull();expect(next.asOf).toBe(first.asOf);
      const ids=[...first.events,...next.events].map(event=>event.id);
      const expected=await db.adHistoryEvent.findMany({where:{adId:fixture.adId},select:{id:true},orderBy:[{observedAt:'desc'},{id:'desc'}]});
      expect(new Set(ids).size).toBe(121);expect(ids).toEqual(expected.map(event=>event.id));
      await expect(getAdHistory(db,{...query,eventCursor:first.nextEventCursor!,scopeHash:first.scopes[0].hash})).rejects.toMatchObject({code:'INVALID_HISTORY_CURSOR'});
      await expect(getAdHistory(db,{...query,eventCursor:first.nextEventCursor!,to:'2026-10-03'})).rejects.toMatchObject({code:'INVALID_HISTORY_CURSOR'});
    }finally{await removeEventHistory(fixture);}
  });
  it('requires a new first page when late evidence replaces previously paginated events',async()=>{
    const fixture=await createEventHistory(false);
    try{
      const query={...input(),adId:fixture.adId};
      const first=await getAdHistory(db,query);
      expect(first.events).toHaveLength(100);expect(first.nextEventCursor).toBeTruthy();
      const run=await db.collectionRun.create({data:{taskId:fixture.taskId,dataSourceId:fixture.dataSourceId,idempotencyKey:randomUUID(),adapterVersion:'meta-service-dom-1',querySnapshot:fixture.query}});
      fixture.runIds.push(run.id);
      await db.adObservation.create({data:{adId:fixture.adId,dataSourceId:fixture.dataSourceId,collectionRunId:run.id,observedAt:new Date(fixture.start+120.5*60000),sourceStatus:'ACTIVE',queryCountry:'US',snapshot:{body:'Late historical copy'},fieldProvenance:{body:{value:'Late historical copy'}},parserVersion:'meta-service-dom-1'}});
      await rebuildAdHistory(db,fixture.adId);
      await expect(getAdHistory(db,{...query,eventCursor:first.nextEventCursor!})).rejects.toMatchObject({status:409,code:'HISTORY_CHANGED_RELOAD'});
      const fresh=await getAdHistory(db,query);
      const next=await getAdHistory(db,{...query,eventCursor:fresh.nextEventCursor!});
      const ids=[...fresh.events,...next.events].map(event=>event.id);
      const expected=await db.adHistoryEvent.findMany({where:{adId:fixture.adId},select:{id:true},orderBy:[{observedAt:'desc'},{id:'desc'}]});
      expect(ids).toHaveLength(122);expect(new Set(ids).size).toBe(122);expect(ids).toEqual(expected.map(event=>event.id));
    }finally{await removeEventHistory(fixture);}
  });
});
