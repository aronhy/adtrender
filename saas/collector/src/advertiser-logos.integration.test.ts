import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {parseAd} from './snapchat-service/parser';
import {publicAdvertiserAvatar} from '../../app/src/server/advertiser-avatar';
import {withObservedAdvertiserAvatars,backfillObservedAdvertiserLogos} from '../../app/src/ads/advertiser-avatar';

const url=process.env.SAAS_TEST_DATABASE_URL;
const require=createRequire(new URL('../../app/package.json',import.meta.url));
type Platform='Facebook'|'Instagram'|'TikTok'|'Snapchat';
const sources:Record<Platform,string>={Facebook:'meta_ad_library',Instagram:'meta_ad_library',TikTok:'tiktok_commercial_library',Snapchat:'snapchat_ads_gallery'};
const logos:Record<Platform,string>={Facebook:'https://scontent.fbcdn.net/logo-a.jpg',Instagram:'https://scontent.cdninstagram.com/logo-a.jpg',TikTok:'https://p16-common-sign.tiktokcdn.com/tos-alisg-avt-0068/logo-a.jpeg',Snapchat:'https://cf-st.sc-cdn.net/d/logo-a'};
let db:any;
function fixture(platform:Platform){
  const sourceAdId=platform==='Snapchat'?randomUUID():String(970000000000000000n+BigInt('0x'+randomUUID().replaceAll('-','').slice(0,10)));
  const sourceAdvertiserId=String(970000000000000000n+BigInt('0x'+randomUUID().replaceAll('-','').slice(0,10)));
  return {sourceAdId,batch:(avatar:string|null|undefined,observedAt='2026-10-10T12:00:00.000Z')=>{
    if(platform==='Snapchat'){
      const raw={id:sourceAdId,paying_advertiser_name:'Synthetic logo fixture',status:'ACTIVE',...(avatar?{profile_logo_url:avatar}:{})};
      const ad={...parseAd(raw,'ALL'),...(avatar===undefined?{}:{advertiserAvatarUrl:avatar})};
      return {version:'snapchat-service-public-1',sourceKey:sources[platform],observedAt,query:{publisher:'Synthetic logo fixture',country:'ALL'},status:'SUCCEEDED',errorCode:null,ads:[ad],coverage:{completeSourceCoverage:false},evidence:[
        {kind:'public-response',url:'https://adsapi.snapchat.com/v1/ads_library/ads/'+sourceAdId,status:'200',raw:{request_status:'SUCCESS',ad_preview:raw}},
        {kind:'public-response',url:'https://adsapi.snapchat.com/v1/ads_library/ads/search?fixture=synthetic',status:'200',request:{paying_advertiser_name:'Synthetic logo fixture',countries:[]},raw:{request_status:'SUCCESS',ad_previews:[{sub_request_status:'SUCCESS',ad_preview:raw}]}},
      ]};
    }
    if(platform==='TikTok')return {version:'tiktok-public-dom-1',sourceKey:sources[platform],platform:'TIKTOK',observedAt,query:{country:'DE',startDate:'2026-10-01',endDate:'2026-10-10'},status:'SUCCEEDED',errorCode:null,
      ads:[{sourceAdId,sourceUrl:'https://library.tiktok.com/ads/detail/?ad_id='+sourceAdId,sourceAdvertiserId,advertiserName:'Synthetic logo fixture',...(avatar===undefined?{}:{advertiserAvatarUrl:avatar}),body:null,headline:null,cta:null,landingPageUrl:null,firstShown:null,lastShown:null,reportedCountries:[],media:[],sourceFields:{},observedAt}],
      evidence:[{kind:'detail',url:'https://library.tiktok.com/ads/detail/?ad_id='+sourceAdId,adId:sourceAdId,httpStatus:200,text:'Ad ID: '+sourceAdId,html:avatar?'<img src="'+avatar+'">':'',observedAt}],completedIds:[sourceAdId],coverage:{completeSourceCoverage:false,exhausted:false,reason:'BATCH_BUDGET'}};
    return {version:'meta-service-dom-1',sourceKey:sources[platform],platform:'META',observedAt,query:{country:'DE',language:'en',keyword:'synthetic logos'},status:'SUCCEEDED',errorCode:null,
      ads:[{source:'meta',sourceAdId,sourceUrl:'https://www.facebook.com/ads/library/?id='+sourceAdId,advertiserName:'Synthetic logo fixture',advertiserPageUrl:'https://www.facebook.com/'+sourceAdvertiserId,...(avatar===undefined?{}:{advertiserAvatarUrl:avatar}),queryCountry:'DE',status:'active',platforms:[platform],body:null,headline:null,cta:null,landingPageUrl:null,startDate:null,endDate:null,media:[]}],
      evidence:[{url:'https://www.facebook.com/ads/library/?id='+sourceAdId,text:'Library ID: '+sourceAdId,html:'<span>Library ID: '+sourceAdId+'</span>'}],completedIds:[sourceAdId],coverage:{completeSourceCoverage:false}};
  }};
}
async function isolated(body:(tx:any)=>Promise<void>){
  const rollback=Error('ROLLBACK_LOGO_FIXTURE');
  try{await db.$transaction(async(tx:any)=>{
    await tx.collectorSourceAssignment.deleteMany({where:{sourceKey:{in:Object.values(sources)}}});
    await tx.collectorSourceControl.updateMany({where:{sourceKey:{in:Object.values(sources)}},data:{controlMode:'LEGACY_QUEUE'}});
    for(const key of new Set(Object.values(sources)))await tx.dataSource.upsert({where:{key},create:{key,name:'Synthetic logo fixture',adapterVersion:'fixture',status:'PAUSED'},update:{}});
    await body(tx);throw rollback;
  },{timeout:20000});}catch(error){if(error!==rollback)throw error;}
}
async function ingest(tx:any,platform:Platform,value:unknown){const namespace=platform==='TikTok'?'tiktok':platform==='Snapchat'?'snapchat':'meta';return (await tx.$queryRawUnsafe(`SELECT ${namespace}_collector.ingest($1::text) AS result`,JSON.stringify(value)))[0].result;}

describe.skipIf(!url)('source-native advertiser logo ingestion on owned PostgreSQL',()=>{
  beforeAll(async()=>{
    const target=new URL(url!);if(!['127.0.0.1','localhost'].includes(target.hostname)||!target.pathname.includes('_test_')||url!==process.env.SAAS_OWNED_TEST_DATABASE_URL)throw Error('OWNED_LOCAL_TEST_DATABASE_REQUIRED');
    const {PrismaClient}=require('@prisma/client');db=new PrismaClient({datasources:{db:{url}}});
  });
  afterAll(async()=>{await db?.$disconnect();});
  it.each(Object.keys(sources) as Platform[])('stores %s logos separately and preserves them on missing or older observations',async platform=>isolated(async tx=>{
    const f=fixture(platform),logo=logos[platform];
    const first=f.batch(logo);
    expect(await ingest(tx,platform,first)).toMatchObject({status:'IMPORTED',inserted:1});
    expect(await ingest(tx,platform,first)).toMatchObject({status:'ALREADY_IMPORTED',inserted:0,updated:0});
    const find=()=>tx.ad.findFirstOrThrow({where:{sourceAdId:f.sourceAdId,dataSource:{key:sources[platform]}},include:{dataSource:true,advertiser:true,media:true,observations:{orderBy:{observedAt:'desc'}}}});
    let saved=await find();
    expect(publicAdvertiserAvatar(saved)).toBe(logo);
    expect(saved.fieldProvenance).toMatchObject({advertiserAvatarUrl:{value:logo,observedAt:expect.any(String),evidenceSha256:expect.any(String)}});
    if(platform!=='Snapchat')expect(saved.advertiser.fieldProvenance).toMatchObject({avatarUrl:{value:logo}});
    expect(saved.media).toHaveLength(0);
    await ingest(tx,platform,f.batch(null,'2026-10-10T14:00:00.000Z'));
    await ingest(tx,platform,f.batch(logo.replace('logo-a','logo-old'),'2026-10-10T11:00:00.000Z'));
    saved=await find();
    expect(publicAdvertiserAvatar(saved)).toBe(logo);
    expect(saved.fieldProvenance).toMatchObject({advertiserAvatarUrl:{value:logo}});
    expect(saved.observations).toHaveLength(3);
    expect(saved.observations[0].snapshot.advertiserAvatarUrl??null).toBeNull();
    const [projected]=await withObservedAdvertiserAvatars(tx,[{id:saved.id,dataSource:{key:sources[platform]}}]);
    expect(publicAdvertiserAvatar(projected)).toBe(logo);
    expect(await tx.mediaObject.count({where:{adId:saved.id}})).toBe(0);
  }));
  it.each(Object.keys(sources) as Platform[])('rejects an unsafe %s logo without inserting the batch',async platform=>isolated(async tx=>{
    const f=fixture(platform);await tx.$executeRawUnsafe('SAVEPOINT unsafe_logo');
    await expect(ingest(tx,platform,f.batch('javascript:alert(1)'))).rejects.toThrow('ADVERTISER_LOGO_INVALID');
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT unsafe_logo');
    expect(await tx.ad.count({where:{sourceAdId:f.sourceAdId}})).toBe(0);
  }));
  it('backfills archived Snapchat logos once without changing creative, copy, or observation facts',async()=>isolated(async tx=>{
    const f=fixture('Snapchat'),logo=logos.Snapchat;
    await ingest(tx,'Snapchat',f.batch(logo));
    const saved=await tx.ad.findFirstOrThrow({where:{sourceAdId:f.sourceAdId},include:{observations:true}});
    const provenance={...saved.fieldProvenance};delete provenance.advertiserAvatarUrl;
    await tx.ad.update({where:{id:saved.id},data:{fieldProvenance:provenance}});
    const observation=saved.observations[0],snapshot={...observation.snapshot};delete snapshot.advertiserAvatarUrl;
    const observationProvenance={...observation.fieldProvenance};delete observationProvenance.advertiserAvatarUrl;
    await tx.adObservation.update({where:{id:observation.id},data:{snapshot,fieldProvenance:observationProvenance}});
    expect(await backfillObservedAdvertiserLogos(tx,{dryRun:true})).toMatchObject({candidates:1,updated:0});
    expect((await tx.ad.findUniqueOrThrow({where:{id:saved.id}})).fieldProvenance).not.toHaveProperty('advertiserAvatarUrl');
    expect(await backfillObservedAdvertiserLogos(tx,{dryRun:false})).toMatchObject({candidates:1,updated:1});
    const filled=await tx.ad.findUniqueOrThrow({where:{id:saved.id},include:{dataSource:true}});
    expect(publicAdvertiserAvatar(filled)).toBe(logo);
    expect(filled).toMatchObject({body:saved.body,lastObservedAt:saved.lastObservedAt,sourceStatus:saved.sourceStatus});
    expect(filled.fieldProvenance.advertiserAvatarUrl).toMatchObject({value:logo,evidenceSha256:observation.evidenceSha256});
    expect(await tx.adObservation.count({where:{adId:saved.id}})).toBe(1);
    expect(await backfillObservedAdvertiserLogos(tx,{dryRun:false})).toMatchObject({candidates:0,updated:0});
  }));
});
