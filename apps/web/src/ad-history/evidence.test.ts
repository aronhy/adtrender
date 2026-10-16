import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {getAdHistoryEvidence} from './evidence';
const url=process.env.SAAS_TEST_DATABASE_URL;
describe.skipIf(!url)('authorized archived historic evidence on PostgreSQL',()=>{
  let db:PrismaClient,userId:string,workspaceId:string,adId:string,observationId:string,outsider:string,disabled:string;
  const key='public-media/'+randomUUID(),sourceUrl='https://i.pinimg.com/originals/example.jpg?signature=fixture-private';
  beforeAll(async()=>{
    db=new PrismaClient({datasources:{db:{url}}});const token=randomUUID();
    userId=(await db.user.create({data:{email:token+'@example.test'}})).id;outsider=(await db.user.create({data:{}})).id;disabled=(await db.user.create({data:{disabledAt:new Date()}})).id;
    const org=await db.organization.create({data:{name:token,slug:token,members:{create:{userId,role:'OWNER'}}}});
    workspaceId=(await db.workspace.create({data:{organizationId:org.id,name:'Evidence',slug:token}})).id;
    const source=await db.dataSource.create({data:{name:token,key:'evidence-'+token,adapterVersion:'meta-service-dom-2'}});
    const task=await db.collectionTask.create({data:{dataSourceId:source.id,name:token,query:{}}});
    adId=(await db.ad.create({data:{dataSourceId:source.id,sourceAdId:token,sourceUrl:'https://www.facebook.com/ads/library/?id=123',body:'CURRENT BODY',advertiserId:null}})).id;
    const run=await db.collectionRun.create({data:{taskId:task.id,dataSourceId:source.id,idempotencyKey:token,adapterVersion:'meta-service-dom-2',querySnapshot:{country:'US'},coverage:{}}});
    observationId=(await db.adObservation.create({data:{adId,dataSourceId:source.id,collectionRunId:run.id,observedAt:new Date('2026-10-01T01:00:00Z'),queryCountry:'US',snapshot:{advertiserName:'Historic brand',sourceAdvertiserId:'source-123',body:'Historic copy',cta:'Shop now',landingPageUrl:'https://brand.example/product',reportedCountries:['DE'],publisherPlatforms:['FACEBOOK'],languages:['en'],media:[{type:'IMAGE',url:sourceUrl}]},fieldProvenance:{body:{value:'Historic copy'},cta:{value:'Shop now'},landingPageUrl:{value:'https://brand.example/product'}},parserVersion:'meta-service-dom-2'}})).id;
    await db.mediaObject.create({data:{adId,sourceUrl,type:'IMAGE',status:'READY',storageKey:key,mimeType:'image/jpeg',sha256:'e'.repeat(64),sizeBytes:123n,downloadedAt:new Date('2026-10-08T01:00:00Z')}});
  });
  afterAll(()=>db?.$disconnect());
  const input=()=>({userId,workspaceId,adId,observationId});
  it('reads original facts and captured bytes with separate true download time',async()=>{
    const keys:string[]=[];const result=await getAdHistoryEvidence(db,input(),async objectKey=>{keys.push(objectKey);return {url:'https://archive.example/temporary-view',expiresAt:new Date('2026-10-08T03:00:00Z')};});
    expect(result).toMatchObject({advertiserName:'Historic brand',advertiserId:'source-123',body:'Historic copy',reportedCountries:['DE'],publisherPlatforms:['FACEBOOK'],cta:'Shop now'});
    expect(result.media[0]).toMatchObject({sizeBytes:'123',downloadedAt:'2026-10-08T01:00:00.000Z',association:'SOURCE_URL_MATCH',displayUrl:'https://archive.example/temporary-view'});
    expect(keys).toEqual([key]);expect(JSON.stringify(result)).not.toContain(key);expect(JSON.stringify(result)).not.toContain('fixture-private');expect(JSON.stringify(result)).not.toContain('CURRENT BODY');
  });
  it('never signs historic objects before account/workspace and observation identity checks',async()=>{
    let signs=0;const sign=async()=>{signs++;return {url:'https://example.test',expiresAt:new Date()};};
    for(const user of [outsider,disabled])await expect(getAdHistoryEvidence(db,{...input(),userId:user},sign)).rejects.toThrow();
    await expect(getAdHistoryEvidence(db,{...input(),adId:randomUUID()},sign)).rejects.toMatchObject({code:'HISTORY_EVIDENCE_NOT_FOUND'});expect(signs).toBe(0);
  });
});
