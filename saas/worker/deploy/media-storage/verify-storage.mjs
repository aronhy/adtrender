/** Real stored-byte verification, one sample per observed creative type; no object keys or signatures. */
import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
const require=createRequire('/opt/ad-research/app/package.json');const {PrismaClient}=require('@prisma/client');const {S3Client,GetObjectCommand}=require('@aws-sdk/client-s3');const db=new PrismaClient();
const s3=new S3Client({region:process.env.S3_REGION,endpoint:process.env.S3_ENDPOINT,forcePathStyle:process.env.S3_FORCE_PATH_STYLE==='true',maxAttempts:1,requestHandler:{requestTimeout:20000,connectionTimeout:5000}});
const reports=[];
try{
 for(const [source,type] of [['meta_ad_library','IMAGE'],['meta_ad_library','VIDEO'],['google_ads_transparency','IMAGE'],['google_ads_transparency','VIDEO'],['tiktok_commercial_library','IMAGE'],['tiktok_commercial_library','VIDEO'],['pinterest_ads_repository','IMAGE'],['snapchat_ads_gallery','IMAGE'],['snapchat_ads_gallery','VIDEO']]){
 const rows=await db.$queryRawUnsafe(`SELECT m.id,m.type,m."storageKey",m."mimeType",m."sizeBytes",m.sha256 FROM "MediaObject" m JOIN "Ad" a ON a.id=m."adId" JOIN "DataSource" s ON s.id=a."dataSourceId" WHERE s.key=$1 AND m.type=$2 AND m.status='READY' AND m."storageKey" IS NOT NULL ORDER BY m."downloadedAt" DESC LIMIT 1`,source,type);const m=rows[0];if(!m)throw Error('READY_SAMPLE_REQUIRED');
 const r=await s3.send(new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:m.storageKey}));const hash=createHash('sha256');let bytes=0;for await(const c of r.Body){bytes+=c.length;hash.update(c);}const valid=bytes===Number(m.sizeBytes)&&hash.digest('hex')===m.sha256&&r.ContentType===m.mimeType;if(!valid)throw Error('STORED_BYTES_MISMATCH');reports.push({source,status:'VERIFIED',type:m.type,bytes,sha256:m.sha256,mimeType:m.mimeType});
 }
 for(const [name,sql] of Object.entries({userRead:'SELECT id FROM "User" LIMIT 1',credentialRead:'SELECT "credentialReference" FROM "DataSource" LIMIT 1',sourceMutation:'UPDATE "DataSource" SET name=name WHERE false',adMutation:'UPDATE "Ad" SET headline=headline WHERE false',ddl:'CREATE TABLE media_forbidden(id int)'})){
 try{await db.$executeRawUnsafe(sql);throw Error('UNEXPECTED_PERMISSION');}catch(e){if(e.meta?.code!=='42501')throw e;reports.push({permission:name,status:'DENIED'});}}
 console.log(JSON.stringify({storedByteVerification:reports}));
}finally{await db.$disconnect();s3.destroy();}
