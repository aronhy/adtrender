import { PrismaClient } from '@prisma/client';
import { readFile,stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import Stripe from 'stripe';
import { bootstrapPlatformAdmin,seedDataSources } from './admin';
import { DomainError } from './access';
import { createPlanManagement,parsePlanImport } from '../billing/plan-management';

function flags(args:string[],expected:string[]) {
  if(args.length!==expected.length*2)return null;
  const result:Record<string,string>={};
  for(let index=0;index<args.length;index+=2) {
    if(!expected.includes(args[index])||result[args[index]]!==undefined||!args[index+1]||args[index+1].startsWith('--'))return null;
    result[args[index]]=args[index+1];
  }
  return expected.every(key=>result[key]!==undefined)?result:null;
}
async function managePlan(db:PrismaClient,command:string,options:Record<string,string>) {
  const actor=await db.user.findUnique({where:{email:options['--actor-email'].trim().toLowerCase()},select:{id:true}});
  if(!actor)throw new DomainError(403,'PLATFORM_ADMIN_REQUIRED');
  if(command==='plan-unpublish') {
    if(!/^\d+$/.test(options['--version']))throw new DomainError(400,'INVALID_PLAN_VERSION');
    // Withdrawal must work during a provider outage or after key revocation.
    return createPlanManagement(db,null,{mode:'live'}).unpublishVersion({actorUserId:actor.id,key:options['--key'],version:Number(options['--version'])});
  }
  const key=process.env.STRIPE_SECRET_KEY??'',mode=/^(?:sk|rk)_(test|live)_/.exec(key)?.[1];
  if(mode!=='test'&&mode!=='live')throw new DomainError(503,'PLAN_MODE_NOT_CONFIGURED');
  const service=createPlanManagement(db,new Stripe(key,{timeout:5000,maxNetworkRetries:1}),{mode,livePaymentsEnabled:process.env.LIVE_BILLING_ENABLED==='true'});
  if(command==='plan-activate'||command==='plan-publish') {
    if(!/^\d+$/.test(options['--version']))throw new DomainError(400,'INVALID_PLAN_VERSION');
    const input={actorUserId:actor.id,key:options['--key'],version:Number(options['--version'])};
    return command==='plan-publish'?service.publishVersion(input):service.activateVersion(input);
  }
  // admin.sh changes cwd; absolute paths make the operator-selected local file unambiguous.
  if(!isAbsolute(options['--file']))throw new DomainError(400,'PLAN_FILE_ABSOLUTE_PATH_REQUIRED');
  let plan:unknown;
  try {
    const info=await stat(options['--file']);
    if(!info.isFile()||info.size>65536)throw new Error('INVALID_PLAN_FILE');
    const contents=await readFile(options['--file'],'utf8');
    if(Buffer.byteLength(contents)>65536)throw new Error('INVALID_PLAN_FILE');
    plan=JSON.parse(contents);
  } catch {throw new DomainError(400,'INVALID_PLAN_FILE');}
  return service.importVersion({actorUserId:actor.id,plan:parsePlanImport(plan)});
}

const args=process.argv.slice(2);
if (args.length===1 && ['--help','help'].includes(args[0])) {
  process.stdout.write('Usage: scripts/admin.sh grant-admin --email <existing-verified-email>\n       scripts/admin.sh seed-sources\n       scripts/admin.sh plan-import --actor-email <active-admin-email> --file <absolute-local-json-path>\n       scripts/admin.sh plan-activate --actor-email <active-admin-email> --key <plan-key> --version <integer>\n       scripts/admin.sh plan-publish --actor-email <active-admin-email> --key <plan-key> --version <integer>\n       scripts/admin.sh plan-unpublish --actor-email <active-admin-email> --key <plan-key> --version <integer>\nDATABASE_URL must point to the intended database. No users, passwords or collection tasks are created.\nImport, activate and publish commands require STRIPE_SECRET_KEY (matching test/live key; price-read permission suffices). Live activation also requires LIVE_BILLING_ENABLED=true. Stripe requests only retrieve a price.\nPlan JSON has exactly: schemaVersion=1, mode=test|live, key, version, name, currency (lowercase), priceMinor (positive integer), billingInterval=MONTH, trialDays=0, workspaceLimit, memberLimit, savedAdLimit, monthlyAnalysisLimit, providerPriceId. Supply actual approved amounts and quotas, never credentials. Imports are DRAFT; existing versions and subscriptions are never overwritten. ACTIVE alone is not public. plan-publish requires a verified LIVE version and a fresh read-only Stripe price check; PUBLIC_PRICING_ENABLED remains separately opt-in. plan-unpublish needs no Stripe credentials and never changes existing subscriptions.\n');
} else {
  const command=args[0];
  const options=command==='grant-admin'?flags(args.slice(1),['--email']):command==='seed-sources'?flags(args.slice(1),[]):command==='plan-import'?flags(args.slice(1),['--actor-email','--file']):['plan-activate','plan-publish','plan-unpublish'].includes(command)?flags(args.slice(1),['--actor-email','--key','--version']):null;
  if (!options||!process.env.DATABASE_URL) {
    process.stderr.write('INVALID_COMMAND_OR_DATABASE_URL; use --help.\n');
    process.exitCode=1;
  } else {
    const db=new PrismaClient();
    try {
      const result=command==='grant-admin'?await bootstrapPlatformAdmin(db,{email:options['--email']}):command==='seed-sources'?await seedDataSources(db):await managePlan(db,command,options);
      process.stdout.write(JSON.stringify({command,result})+'\n');
    } catch(error) {
      process.stderr.write((error instanceof DomainError?error.code:'ADMIN_OPERATION_FAILED')+'\n');
      process.exitCode=1;
    } finally {await db.$disconnect();}
  }
}
