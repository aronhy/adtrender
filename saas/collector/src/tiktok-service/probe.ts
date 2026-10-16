import {parseArgs} from 'node:util';
import {mkdir,writeFile,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {collectBatch,discoverCountries} from './browser';
import {planJobs} from './queue';
const {values}=parseArgs({options:{out:{type:'string'},country:{type:'string',default:'DE'},channel:{type:'string',default:'chromium'},limit:{type:'string',default:'3'},start:{type:'string'},end:{type:'string'},help:{type:'boolean'},catalog:{type:'boolean'}}});
if(values.help){console.log('TikTok public DOM probe --out DIR [--country DE --start YYYY-MM-DD --end YYYY-MM-DD --limit 3 --channel chromium] [--catalog]');process.exit(0);}
if(values.catalog){const countries=await discoverCountries({channel:values.channel});console.log(JSON.stringify({countries}));process.exit(0);}
if(!values.out)throw Error('TIKTOK_OUTPUT_REQUIRED');
const root=resolve(values.out);await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
const jobs=planJobs([values.country!],{lookbackDays:2,...(values.start?{start:values.start}:{}),...(values.end?{end:values.end}:{})});
const batch=await collectBatch(jobs[0],{channel:values.channel,maxAds:Number(values.limit),maxPages:10,maxMs:180000});
await writeFile(join(root,'probe.json'),JSON.stringify(batch),{mode:0o600});
console.log(JSON.stringify({status:batch.status,errorCode:batch.errorCode,query:batch.query,count:batch.ads.length,ads:batch.ads.map(a=>({id:a.sourceAdId,advertiser:a.advertiserName,countries:a.reportedCountries,media:a.media.map(m=>m.type)})),coverage:batch.coverage}));
if(!['SUCCEEDED','NO_RESULTS'].includes(batch.status))process.exitCode=2;
