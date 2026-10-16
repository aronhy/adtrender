import {createRequire} from 'node:module';
import {backfillObservedAdvertiserLogos} from '../app/src/ads/advertiser-avatar';

const args=process.argv.slice(2);
if(args.some(arg=>!['--execute','--limit=1000'].includes(arg)))throw Error('ADVERTISER_LOGO_BACKFILL_ARGUMENT');
if(!process.env.DATABASE_URL)throw Error('ADVERTISER_LOGO_DATABASE_REQUIRED');
const require=createRequire(new URL('../app/package.json',import.meta.url));
const {PrismaClient}=require('@prisma/client');
const db=new PrismaClient();
try{
  const result=await db.$transaction(async (tx:any)=>{
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='20s'");
    return backfillObservedAdvertiserLogos(tx,{dryRun:!args.includes('--execute')});
  },{timeout:25000});
  console.log(JSON.stringify({...result,dryRun:!args.includes('--execute')}));
}finally{await db.$disconnect();}
