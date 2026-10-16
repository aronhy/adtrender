import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { searchAds, getAdDetail, type AdSearchInput } from './service';
const testUrl=process.env.SAAS_TEST_DATABASE_URL;let db:PrismaClient;let userId:string;let workspaceId:string;let sourceId:string;let token:string;let ads:any[]=[];
const when=new Date('2026-10-03T12:00:00.000Z');
describe.skipIf(!testUrl)('PostgreSQL ad search cursor and field semantics',()=>{
  beforeAll(async()=>{
    db=new PrismaClient({datasources:{db:{url:testUrl}}});token=`search-${randomUUID()}`;
    const user=await db.user.create({data:{email:`${token}@example.test`}});userId=user.id;
    const organization=await db.organization.create({data:{name:token,slug:token,members:{create:{userId,role:'OWNER'}}}});
    const workspace=await db.workspace.create({data:{name:'Search test',slug:'search',organizationId:organization.id}});workspaceId=workspace.id;
    const source=await db.dataSource.create({data:{name:token,key:token,adapterVersion:'fixture-1',status:'ACTIVE'}});sourceId=source.id;
    for(let i=0;i<4;i++)ads.push(await db.ad.create({data:{dataSourceId:sourceId,sourceAdId:`${i}search${token}`,sourceUrl:'https://www.facebook.com/ads/library/',body:token,firstObservedAt:i===3?null:when,lastObservedAt:i===3?null:when,sourceStatus:i===3?'UNKNOWN':i===1?'INACTIVE':'ACTIVE',reportedCountries:['GB'],mediaType:i===0?'MIXED':'UNKNOWN',fieldProvenance:{advertiserName:{value:`maker ${token}`}}}}));
    await db.mediaObject.createMany({data:[{adId:ads[0].id,type:'IMAGE',sourceUrl:'https://cdn.example/search.jpg'},{adId:ads[0].id,type:'VIDEO',sourceUrl:'https://cdn.example/search.mp4'}]});
    const task=await db.collectionTask.create({data:{name:token,dataSourceId:sourceId,maxItems:20,query:{keyword:token,country:'US',status:'all',mediaType:'all',limit:20}}});
    for(let i=0;i<2;i++){const run=await db.collectionRun.create({data:{taskId:task.id,dataSourceId:sourceId,idempotencyKey:`${token}-${i}`,querySnapshot:{},adapterVersion:'fixture-1',status:'SUCCEEDED'}});await db.adObservation.create({data:{adId:ads[0].id,dataSourceId:sourceId,collectionRunId:run.id,observedAt:when,queryCountry:'US',sourceStatus:'ACTIVE',snapshot:{},parserVersion:'fixture-1',evidenceReference:'fixture://search'}});}
  });
  afterAll(async()=>{await db?.$disconnect();});
  it('paginates equal timestamps with ID tie-breaking and puts unknown observation dates last',async()=>{
    let cursor: string|undefined;const ids:string[]=[];const dates:Array<Date|null>=[];
    for(let pageNumber=0;pageNumber<6;pageNumber++){const page=await searchAds(db,{userId,workspaceId,keyword:token,limit:2,cursor});expect(page.total).toBe(4);ids.push(...page.ads.map(ad=>ad.id));dates.push(...page.ads.map(ad=>ad.lastObservedAt));cursor=page.nextCursor??undefined;if(!cursor)break;}
    expect(new Set(ids).size).toBe(4);expect(ids).toEqual([...ads.slice(0,3).map(ad=>ad.id).sort().reverse(),ads[3].id]);expect(dates.at(-1)).toBeNull();
  });
  it('combines query-country, media and observation dates without duplicating repeated observations',async()=>{
    const page=await searchAds(db,{userId,workspaceId,keyword:token,country:'US',mediaType:'video',status:'active',observedFrom:'2026-10-03T00:00:00Z',observedTo:'2026-10-03T23:59:59Z'});expect(page.total).toBe(1);expect(page.ads.map(ad=>ad.id)).toEqual([ads[0].id]);expect(page.countryScope).toBe('query');
    expect((await searchAds(db,{userId,workspaceId,keyword:token,country:'GB'})).total).toBe(0);expect((await searchAds(db,{userId,workspaceId,keyword:token,mediaType:'image'})).ads[0].id).toBe(ads[0].id);
  });
  it('includes the entire UTC observation end day while preserving explicit timestamp bounds',async()=>{
    const input={userId,workspaceId,keyword:token,observedFrom:'2026-10-03',observedTo:'2026-10-03'};
    const page=await searchAds(db,input);
    expect(page.ads.map(ad=>ad.id)).toEqual([ads[0].id]);
    expect((await searchAds(db,{...input,observedTo:'2026-10-03T11:59:59.999Z'})).total).toBe(0);
    expect((await searchAds(db,{...input,observedTo:'2026-10-03T12:00:00.000Z'})).total).toBe(1);
    for(const observedTo of ['2026-02-30','invalid'])await expect(searchAds(db,{...input,observedTo})).rejects.toMatchObject({code:'INVALID_SEARCH_DATE'});
    await expect(searchAds(db,{...input,observedFrom:'2026-10-04'})).rejects.toMatchObject({code:'INVALID_SEARCH_DATE_RANGE'});
  });
  it('aggregates the entire filtered set with mixed media counted per advertisement and unknown dates preserved',async()=>{
    const first=await searchAds(db,{userId,workspaceId,keyword:token,limit:1});
    const recent=when.valueOf()>=Date.parse(first.asOf)-7*86400000?3:0;
    expect(first.summary).toMatchObject({total:4,images:1,videos:1,unknownMedia:3,sourceStatus:{active:2,inactive:1,unknown:1},firstObservedAt:when,lastObservedAt:when,recentNew7Days:recent,asOf:first.asOf,scope:'matching-ads',mediaCounting:'ads-containing-type'});
    const next=await searchAds(db,{userId,workspaceId,keyword:token,limit:1,cursor:first.nextCursor!});expect(next.summary).toEqual(first.summary);
    const matched=await searchAds(db,{userId,workspaceId,keyword:token,country:'US',mediaType:'video',status:'active'});expect(matched.summary).toMatchObject({total:1,images:1,videos:1,unknownMedia:0,sourceStatus:{active:1,inactive:0,unknown:0}});
    const empty=await searchAds(db,{userId,workspaceId,keyword:token,country:'GB'});expect(empty.summary).toMatchObject({total:0,images:0,videos:0,unknownMedia:0,sourceStatus:{active:0,inactive:0,unknown:0},firstObservedAt:null,lastObservedAt:null,recentNew7Days:0});
  });
  it('rejects a cursor reused with different filters and invalid filter values',async()=>{
    const first=await searchAds(db,{userId,workspaceId,keyword:token,limit:1});await expect(searchAds(db,{userId,workspaceId,keyword:'different',cursor:first.nextCursor!})).rejects.toMatchObject({code:'INVALID_SEARCH_CURSOR'});await expect(searchAds(db,{userId,workspaceId,limit:101})).rejects.toMatchObject({code:'INVALID_SEARCH_LIMIT'});
  });
  it('does not add a newly imported unknown-date ad to an existing cursor snapshot',async()=>{
    const first=await searchAds(db,{userId,workspaceId,keyword:token,limit:3});const added=await db.ad.create({data:{id:`000-${randomUUID()}`,dataSourceId:sourceId,sourceAdId:`new-${token}`,sourceUrl:'https://www.facebook.com/ads/library/',body:token,firstObservedAt:null,lastObservedAt:null,createdAt:new Date(Date.parse(first.asOf)+1000)}});
    const second=await searchAds(db,{userId,workspaceId,keyword:token,limit:3,cursor:first.nextCursor!});expect(second.ads.map(ad=>ad.id)).not.toContain(added.id);expect(second.total).toBe(4);
  });
  it('returns the source observations and mixed media while enforcing workspace access on detail',async()=>{
    const result=await getAdDetail(db,{userId,workspaceId,adId:ads[0].id});expect(result.ad.media).toHaveLength(2);expect(result.ad.observations).toHaveLength(2);await expect(getAdDetail(db,{userId,workspaceId:'other-workspace',adId:ads[0].id})).rejects.toMatchObject({status:403});
  });
});

describe.skipIf(!testUrl)('PostgreSQL publisher platform and source start-date filters',()=>{
  let client:PrismaClient;let ownerId:string;let viewerId:string;let outsiderId:string;let disabledId:string;let spaceId:string;let otherSpaceId:string;let keyword:string;
  const ids:Record<string,string>={};
  const search=(extra:Partial<AdSearchInput>={})=>searchAds(client,{userId:ownerId,workspaceId:spaceId,keyword,...extra});
  beforeAll(async()=>{
    client=new PrismaClient({datasources:{db:{url:testUrl}}});keyword=`platform-${randomUUID()}`;
    const owner=await client.user.create({data:{email:`owner-${keyword}@example.test`}});ownerId=owner.id;
    const viewer=await client.user.create({data:{email:`viewer-${keyword}@example.test`}});viewerId=viewer.id;
    const outsider=await client.user.create({data:{email:`outsider-${keyword}@example.test`}});outsiderId=outsider.id;
    disabledId=(await client.user.create({data:{email:`disabled-${keyword}@example.test`,disabledAt:new Date()}})).id;
    const organization=await client.organization.create({data:{name:keyword,slug:keyword,members:{create:[{userId:ownerId,role:'OWNER'},{userId:viewerId,role:'MEMBER'}]}}});
    spaceId=(await client.workspace.create({data:{name:'Synthetic search filters',slug:'search',organizationId:organization.id,members:{create:{userId:viewerId,role:'VIEWER'}}}})).id;
    const other=await client.organization.create({data:{name:`other-${keyword}`,slug:`other-${keyword}`,members:{create:{userId:outsiderId,role:'OWNER'}}}});
    otherSpaceId=(await client.workspace.create({data:{name:'Other organization',slug:'other',organizationId:other.id}})).id;
    const source=await client.dataSource.create({data:{name:keyword,key:keyword,adapterVersion:'fixture-1',status:'ACTIVE'}});
    const fixtures:Array<{name:string;platforms:string[];started:string|null}>=[
      {name:'title',platforms:['Facebook','FACEBOOK','Instagram','Audience Network'],started:'2026-09-20T00:00:00.000Z'},
      {name:'upper',platforms:['FACEBOOK','INSTAGRAM','AUDIENCE_NETWORK'],started:'2026-09-20T23:59:59.999Z'},
      {name:'unknown',platforms:[],started:'2026-09-20T12:00:00.000Z'},
      {name:'before',platforms:['Facebook'],started:'2026-09-19T23:59:59.999Z'},
      {name:'after',platforms:['Facebook'],started:'2026-09-21T00:00:00.000Z'},
      {name:'pinterest',platforms:['PINTEREST'],started:'2026-09-20T12:00:00.000Z'},
      {name:'nodate',platforms:['Facebook'],started:null},
      {name:'messenger',platforms:['Messenger'],started:'2026-09-20T12:00:00.000Z'},
      {name:'audienceSpace',platforms:['AUDIENCE NETWORK'],started:'2026-09-20T12:00:00.000Z'},
    ];
    for(const fixture of fixtures){ids[fixture.name]=(await client.ad.create({data:{dataSourceId:source.id,sourceAdId:fixture.name,sourceUrl:'https://www.facebook.com/ads/library/',body:keyword,publisherPlatforms:fixture.platforms,sourceStartedAt:fixture.started?new Date(fixture.started):null,sourceEndedAt:fixture.name==='upper'?new Date('2026-09-22T00:00:00Z'):null,firstObservedAt:when,lastObservedAt:when,sourceStatus:fixture.name==='title'?'ACTIVE':fixture.name==='upper'?'INACTIVE':'UNKNOWN'}})).id;}
    await client.mediaObject.createMany({data:[{adId:ids.title,type:'IMAGE',sourceUrl:'https://cdn.example/filter.jpg'},{adId:ids.title,type:'VIDEO',sourceUrl:'https://cdn.example/filter.mp4'},{adId:ids.upper,type:'VIDEO',sourceUrl:'https://cdn.example/upper.mp4'}]});
    const task=await client.collectionTask.create({data:{name:keyword,dataSourceId:source.id,maxItems:20,query:{keyword,country:'US',status:'all',mediaType:'all',limit:20}}});
    const run=await client.collectionRun.create({data:{taskId:task.id,dataSourceId:source.id,idempotencyKey:keyword,querySnapshot:{},adapterVersion:'fixture-1',status:'SUCCEEDED'}});
    for(const name of ['title','upper','unknown'])await client.adObservation.create({data:{adId:ids[name],dataSourceId:source.id,collectionRunId:run.id,observedAt:when,queryCountry:name==='unknown'?'ALL':'US',snapshot:{},parserVersion:'fixture-1'}});
  });
  afterAll(async()=>{await client?.$disconnect();});
  it.each([
    ['facebook',['title','upper','before','after','nodate']],
    ['instagram',['title','upper']],
    ['audience_network',['title','upper','audienceSpace']],
    ['pinterest',['pinterest']],
    ['messenger',['messenger']],
  ] as const)('matches %s across historical spellings without duplicating multi-platform ads',async(platform,names)=>{
    const result=await search({platform});
    expect(result.ads.map(ad=>ad.id).sort()).toEqual(names.map(name=>ids[name]).sort());
    expect(result.total).toBe(names.length);expect(result.summary.total).toBe(names.length);
    expect(result.ads.some(ad=>ad.id===ids.unknown)).toBe(false);
  });
  it('includes both UTC day boundaries of the source start date and excludes unknown dates',async()=>{
    const result=await search({platform:'facebook',startedFrom:'2026-09-20',startedTo:'2026-09-20'});
    expect(result.ads.map(ad=>ad.id).sort()).toEqual([ids.title,ids.upper].sort());
    expect(result.summary).toMatchObject({total:2,images:1,videos:2,unknownMedia:0,sourceStatus:{active:1,inactive:1,unknown:0}});
    expect((await search({startedFrom:'2026-10-03',startedTo:'2026-10-03'})).total).toBe(0);
    expect((await search()).ads.some(ad=>ad.id===ids.nodate)).toBe(true);
    const detail=await getAdDetail(client,{userId:ownerId,workspaceId:spaceId,adId:ids.upper});
    expect(detail.ad.sourceStartedAt?.toISOString()).toBe('2026-09-20T23:59:59.999Z');expect(detail.ad.sourceEndedAt?.toISOString()).toBe('2026-09-22T00:00:00.000Z');
  });
  it('combines source dates, platform, media and observation filters while keeping summary stable across pages',async()=>{
    const filters={platform:'facebook' as const,startedFrom:'2026-09-20',startedTo:'2026-09-20',country:'US',mediaType:'video' as const,observedFrom:'2026-10-03T00:00:00Z',observedTo:'2026-10-03T23:59:59.999Z',limit:1};
    const first=await search(filters);expect(first.total).toBe(2);expect(first.nextCursor).toBeTruthy();
    const next=await search({...filters,cursor:first.nextCursor!});
    expect(next.summary).toEqual(first.summary);expect(next.nextCursor).toBeNull();
    expect([...first.ads,...next.ads].map(ad=>ad.id).sort()).toEqual([ids.title,ids.upper].sort());
    const allQuery=await search({country:'ALL',startedFrom:'2026-09-20',startedTo:'2026-09-20'});
    expect(allQuery.ads.map(ad=>ad.id)).toEqual([ids.unknown]);
  });
  it('rejects reuse after any new filter changes and a malformed cursor fingerprint',async()=>{
    const filters={platform:'facebook' as const,startedFrom:'2026-09-19',startedTo:'2026-09-21',limit:1};
    const first=await search(filters);expect(first.nextCursor).toBeTruthy();
    for(const changed of [{platform:'instagram' as const},{startedFrom:'2026-09-20'},{startedTo:'2026-09-20'}])await expect(search({...filters,...changed,cursor:first.nextCursor!})).rejects.toMatchObject({code:'INVALID_SEARCH_CURSOR'});
    const cursor=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString('utf8'));cursor.filterHash='tampered';
    await expect(search({...filters,cursor:Buffer.from(JSON.stringify(cursor)).toString('base64url')})).rejects.toMatchObject({code:'INVALID_SEARCH_CURSOR'});
  });
  it.each(['meta','FACEBOOK','facebook\' OR 1=1 --',42,['facebook']].map(value=>[value]))('rejects invalid platform input %j',async platform=>{
    await expect(search({platform:platform as any})).rejects.toMatchObject({status:400,code:'INVALID_SEARCH_PLATFORM'});
  });
  it.each(['not-a-date','2026-02-30','2026-09-20\' OR 1=1 --',42,['2026-09-20']].map(value=>[value]))('rejects malformed source start date %j',async startedFrom=>{
    await expect(search({startedFrom:startedFrom as any})).rejects.toMatchObject({status:400,code:'INVALID_SEARCH_DATE'});
  });
  it('rejects reversed source dates',async()=>{
    await expect(search({startedFrom:'2026-09-21',startedTo:'2026-09-20'})).rejects.toMatchObject({status:400,code:'INVALID_SEARCH_DATE_RANGE'});
  });
  it('allows a workspace viewer and rejects outsiders, cross-organization access and disabled users',async()=>{
    const filters={platform:'pinterest' as const,startedFrom:'2026-09-20',startedTo:'2026-09-20'};
    expect((await search({...filters,userId:viewerId})).ads.map(ad=>ad.id)).toEqual([ids.pinterest]);
    await expect(search({...filters,userId:outsiderId})).rejects.toMatchObject({status:403});
    await expect(search({...filters,workspaceId:otherSpaceId})).rejects.toMatchObject({status:403});
    await expect(search({...filters,userId:disabledId})).rejects.toMatchObject({status:403,code:'ACCOUNT_DISABLED'});
  });
});
