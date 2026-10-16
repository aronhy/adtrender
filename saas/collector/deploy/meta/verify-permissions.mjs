import {createRequire} from 'node:module';import {readFileSync} from 'node:fs';
const {PrismaClient}=createRequire('/opt/ad-research/app/package.json')('@prisma/client');const db=new PrismaClient();const report={};
try{
 for(const [name,sql] of Object.entries({userRead:'SELECT id FROM public."User" LIMIT 1',credentialRead:'SELECT "credentialReference" FROM public."DataSource" LIMIT 1',directAdWrite:'UPDATE public."Ad" SET headline=headline WHERE false',ddl:'CREATE TABLE public.meta_must_not_create(id int)'})){
  try{await db.$executeRawUnsafe(sql);throw Error('UNEXPECTED_PERMISSION_'+name);}catch(e){if(e.meta?.code!=='42501')throw e;report[name]='DENIED';}
 }
 const raw=readFileSync('/data/probe.json','utf8');
 try{await db.$transaction(async tx=>{const first=(await tx.$queryRawUnsafe('SELECT meta_collector.ingest($1::text) AS result',raw))[0].result;report.validBatch=first;const second=(await tx.$queryRawUnsafe('SELECT meta_collector.ingest($1::text) AS result',raw))[0].result;if(second.status!=='ALREADY_IMPORTED'||first.runId!==second.runId)throw Error('IDEMPOTENCY_FAILED');report.replay='ALREADY_IMPORTED';throw Error('ROLLBACK_PROBE');});}catch(e){if(e.message!=='ROLLBACK_PROBE')throw e;report.validBatchRollback=true;}
 for(const [key,change] of Object.entries({otherSource:b=>{b.sourceKey='pinterest_ads_repository';},missingEvidence:b=>{b.evidence=[];},wrongQueryCountry:b=>{b.ads[0].queryCountry='XX';}})){
  const bad=JSON.parse(raw);change(bad);try{await db.$queryRawUnsafe('SELECT meta_collector.ingest($1::text)',JSON.stringify(bad));throw Error('INPUT_NOT_REJECTED_'+key);}catch(e){if(e.meta?.code!=='P0001')throw e;report[key]='DENIED';}
 }
 console.log(JSON.stringify(report));
}finally{await db.$disconnect();}
