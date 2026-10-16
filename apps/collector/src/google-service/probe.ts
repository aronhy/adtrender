import {writeFile,readFile} from 'node:fs/promises';import {collectBatch,type Batch} from './browser';import {makeJob} from './queue';
const root=process.env.GOOGLE_STATE_DIR??'/data',kind=process.argv[2]??'DISCOVER';
const advertiser=kind==='DISCOVER'?undefined:(JSON.parse(await readFile(root+'/discover.json','utf8')) as Batch).advertisers[0]?.advertiserId;
if(kind!=='DISCOVER'&&!advertiser)throw Error('DISCOVERY_REQUIRED');
const batch=await collectBatch(makeJob(kind as 'DISCOVER'|'SEARCH'|'YOUTUBE','US','en',kind==='DISCOVER'?'shop':'',advertiser),root+'/probe-profile',{maxAdvertisers:2,maxAds:2,maxMs:180000,maxVariants:4});
await writeFile(root+'/'+(kind==='DISCOVER'?'discover':kind.toLowerCase())+'.json',JSON.stringify(batch),{mode:0o600});
console.log(JSON.stringify({kind,status:batch.status,errorCode:batch.errorCode,advertisers:batch.advertisers.length,ads:batch.ads.map(a=>({id:a.sourceAdId,platform:a.publisherPlatform,mediaType:a.mediaType,media:a.media.length,videoReferences:a.videoReferences.length,variants:a.variants?.length,variantsComplete:a.variantsComplete,hasBody:!!a.body,hasLanding:!!a.landingPageUrl})),evidence:batch.evidence.length,coverage:batch.coverage}));
if(batch.status==='FAILED')process.exitCode=2;
