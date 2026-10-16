import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {importPinterestBatch,validatePinterestBatch} from './import';
const {values}=parseArgs({options:{batch:{type:'string'},archive:{type:'string'},apply:{type:'boolean',default:false}}});
if(!values.batch||!values.archive)throw Error('Use --batch <json> --archive <private-directory> [--apply]');
const raw=await readFile(values.batch,'utf8');validatePinterestBatch(JSON.parse(raw));
const hash=createHash('sha256').update(raw).digest('hex');
const folder=join(resolve(values.archive),'pinterest',hash);await mkdir(folder,{recursive:true,mode:0o700});await chmod(folder,0o700);await writeFile(join(folder,'batch.json'),raw,{mode:0o600});
const require=createRequire(resolve(process.env.PINTEREST_PRISMA_PACKAGE??'apps/web/package.json'));
const {PrismaClient}=require('@prisma/client');const db=new PrismaClient();
try{console.log(JSON.stringify(await importPinterestBatch(db,raw,values.apply)));}finally{await db.$disconnect();}
