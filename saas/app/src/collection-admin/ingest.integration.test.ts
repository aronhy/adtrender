import {randomUUID} from 'node:crypto';
import {PrismaClient,type Prisma} from '@prisma/client';
import {afterAll,describe,expect,it} from 'vitest';
import {ingestCollection} from './ingest';
import {finishCollection} from './queue';
import type {CollectionOutcome,ParsedAd} from '@ad-research/contracts';

const url=process.env.SAAS_TEST_DATABASE_URL;
const db=new PrismaClient({datasources:{db:{url:url??'postgresql://unused@127.0.0.1:1/not_run'}}});
const runIds:string[]=[];
afterAll(async()=>{if(runIds.length)await db.collectionRun.updateMany({where:{id:{in:runIds},status:'RUNNING'},data:{status:'FAILED',leaseOwner:null,leaseExpiresAt:null,errorCode:'FIXTURE_FINISHED'}});await db.$disconnect();});
const evidence={evidenceReference:'test-evidence://immutable-observation',evidenceSha256:'a'.repeat(64)};
async function fixture() {
  const source=await db.dataSource.create({data:{key:`ingest-review-${randomUUID()}`,name:'Isolated ingestion test',adapterVersion:'fixture',status:'PAUSED'}});
  const task=await db.collectionTask.create({data:{dataSourceId:source.id,name:'Isolated ingestion task',query:{},status:'PAUSED'}});
  const page=`https://www.facebook.com/test-${randomUUID()}`;
  const ad=(id='11111',overrides:Partial<ParsedAd>={}):ParsedAd=>({source:'meta',sourceAdId:id,sourceUrl:`https://www.facebook.com/ads/library/?id=${id}`,advertiserName:'Latest advertiser',advertiserPageUrl:page,body:'latest',headline:null,description:null,displayUrl:null,cta:null,landingPageUrl:null,status:'active',sourceStatusText:'Active',startDate:null,endDate:null,platforms:null,queryCountry:'US',media:[{type:'image',url:'https://scontent.fbcdn.net/fixture.png',posterUrl:null}],...overrides});
  async function run(ads:ParsedAd[],collectedAt='2026-10-04T12:00:00.000Z',wrap?:(tx:Prisma.TransactionClient)=>Prisma.TransactionClient) {
    const row=await db.collectionRun.create({data:{dataSourceId:source.id,taskId:task.id,idempotencyKey:randomUUID(),querySnapshot:{},adapterVersion:'fixture',status:'RUNNING',leaseOwner:randomUUID(),leaseVersion:1,leaseExpiresAt:new Date(Date.now()+60000)}});
    runIds.push(row.id);
    const token={runId:row.id,owner:row.leaseOwner!,version:1};
    const outcome:CollectionOutcome={status:'success',ads,errorCode:null,retryable:false,observedCardCount:ads.length,parsedAdCount:ads.length,parserVersion:'fixture',collectedAt};
    await db.$transaction(async tx=>{const counts=await ingestCollection(wrap?wrap(tx):tx,token,outcome,evidence);expect(await finishCollection(tx,token,outcome,counts)).toBe(true);},{timeout:15000});
    return row;
  }
  return {source,ad,run};
}

describe.skipIf(!url)('ordered ingestion and related observation facts against PostgreSQL',()=>{
  it('stores an observed Meta avatar on the advertiser and ad, preserving it when a later page omits it',async()=>{
    const f=await fixture(),logo='https://scontent.fbcdn.net/advertiser-logo.png';
    await f.run([f.ad('11111',{advertiserAvatarUrl:logo})]);
    await f.run([f.ad('11111',{advertiserAvatarUrl:null})],'2026-10-05T12:00:00.000Z');
    const saved=await db.ad.findFirstOrThrow({where:{dataSourceId:f.source.id},include:{advertiser:true,observations:{orderBy:{observedAt:'desc'}}}});
    expect(saved.fieldProvenance).toMatchObject({advertiserAvatarUrl:{value:logo,evidenceSha256:evidence.evidenceSha256}});
    expect(saved.advertiser!.fieldProvenance).toMatchObject({avatarUrl:{value:logo}});
    expect(saved.observations[0].snapshot).toMatchObject({advertiserAvatarUrl:null});
  });
  it('preserves latest advertiser and media facts when an older run completes later',async()=>{
    const f=await fixture();const latest=await f.run([f.ad()]);
    await f.run([f.ad('11111',{advertiserName:'Old advertiser',body:'old',media:[{type:'video',url:'https://scontent.fbcdn.net/fixture.png',posterUrl:null}]})],'2026-10-03T12:00:00.000Z');
    const saved=await db.ad.findUniqueOrThrow({where:{dataSourceId_sourceAdId:{dataSourceId:f.source.id,sourceAdId:'11111'}},include:{advertiser:true,media:{include:{observation:true}}}});
    expect(saved).toMatchObject({body:'latest',mediaType:'IMAGE'});
    expect(saved.advertiser).toMatchObject({name:'Latest advertiser'});
    expect(saved.media[0]).toMatchObject({type:'IMAGE',observation:{collectionRunId:latest.id}});
  });
  it('does not roll a shared advertiser back from an older observation of a different ad',async()=>{
    const f=await fixture();await f.run([f.ad('11111')]);
    await f.run([f.ad('22222',{advertiserName:'Older shared page'})],'2026-10-03T12:00:00.000Z');
    const advertisers=await db.advertiser.findMany({where:{dataSourceId:f.source.id}});
    expect(advertisers).toHaveLength(1);expect(advertisers[0].name).toBe('Latest advertiser');
    expect(advertisers[0].fieldProvenance).toMatchObject({name:{observedAt:'2026-10-04T12:00:00.000Z'}});
  });
  it('keeps the downloaded signature type while refreshing latest observation metadata',async()=>{
    const f=await fixture();await f.run([f.ad()]);
    const media=await db.mediaObject.findFirstOrThrow({where:{ad:{dataSourceId:f.source.id}}});
    await db.mediaObject.update({where:{id:media.id},data:{status:'READY',mimeType:'image/png',type:'IMAGE',downloadedAt:new Date(),storageKey:`public-media/${randomUUID()}`}});
    const latest=await f.run([f.ad('11111',{media:[{type:'video',url:media.sourceUrl,posterUrl:null}]})],'2026-10-05T12:00:00.000Z');
    expect(await db.mediaObject.findUnique({where:{id:media.id},include:{observation:true}})).toMatchObject({status:'READY',mimeType:'image/png',type:'IMAGE',observation:{collectionRunId:latest.id}});
  });
  it('commits overlapping batches in opposite source order without advisory deadlock',async()=>{
    const f=await fixture();let acquired=0;let unblock!:()=>void;const both=new Promise<void>(resolve=>{unblock=resolve;});
    const wrap=(tx:Prisma.TransactionClient)=>{
      let first=true;
      return new Proxy(tx,{get(target,key){if(key==='$executeRawUnsafe')return async(...args:unknown[])=>{
        const result=await (target.$executeRawUnsafe as(...args:unknown[])=>Promise<number>)(...args);
        if(first&&String(args[0]).includes('pg_advisory_xact_lock')){first=false;if(++acquired===2)unblock();await Promise.race([both,new Promise(resolve=>setTimeout(resolve,100))]);}
        return result;
      };return target[key as keyof Prisma.TransactionClient];}}) as Prisma.TransactionClient;
    };
    const result=await Promise.allSettled([f.run([f.ad('11111'),f.ad('22222')],undefined,wrap),f.run([f.ad('22222'),f.ad('11111')],undefined,wrap)]);
    expect(result.map(row=>row.status)).toEqual(['fulfilled','fulfilled']);
    expect(await db.adObservation.count({where:{dataSourceId:f.source.id}})).toBe(4);
  });
});
