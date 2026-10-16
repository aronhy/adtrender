import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
const {PrismaClient}=createRequire('/opt/ad-research/app/package.json')('@prisma/client');
const db=new PrismaClient();const report={};
try{
 for(const [name,sql] of Object.entries({userRead:'SELECT id FROM public."User" LIMIT 1',credentialRead:'SELECT "credentialReference" FROM public."DataSource" LIMIT 1',directAdWrite:'UPDATE public."Ad" SET headline=headline WHERE false',ddl:'CREATE TABLE public.pinterest_must_not_create(id int)'})){
  try{await db.$executeRawUnsafe(sql);throw Error('UNEXPECTED_PERMISSION_'+name);}catch(e){if(e.meta?.code!=='42501')throw e;report[name]='DENIED';}
 }
 const raw=readFileSync('/validation/batch.json','utf8');
 try{await db.$transaction(async tx=>{const result=await tx.$queryRawUnsafe('SELECT pinterest_collector.ingest($1::text) AS result',raw);report.validBatch=result[0].result;throw Error('ROLLBACK_PROBE');});}catch(e){if(e.message!=='ROLLBACK_PROBE')throw e;report.validBatchRollback=true;}
 const hostile=JSON.parse(raw);hostile.sourceKey='meta_ad_library';
 try{await db.$queryRawUnsafe('SELECT pinterest_collector.ingest($1::text)',JSON.stringify(hostile));throw Error('SOURCE_NOT_REJECTED');}catch(e){if(e.meta?.code!=='P0001')throw e;report.otherSource='DENIED';}
 console.log(JSON.stringify(report));
}finally{await db.$disconnect();}
