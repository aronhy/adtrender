import { PrismaClient } from '@prisma/client';
import { DomainError } from '../../app/src/team/access';
import { runSourceProbe, grantSourceProfile } from './source-probe';

const args=process.argv.slice(2);
if(!args.length||args.includes('--help')) {
 console.log('source-probe probe --actor-user-id ID --source-id ID --keyword TEXT --country US --limit 3 --evidence-dir /private/path\nsource-probe grant --actor-user-id ID --manifest /private/path/private-source-evidence/PROBE/manifest.json --evidence-dir /private/path\nServer environment: DATABASE_URL, SOURCE_PROBE_SIGNING_KEY (64 hex), optional META_BROWSER_CHANNEL=chrome|chromium. Probe makes exactly one bounded live attempt; grant never collects and never activates a source.');
 process.exit(0);
}
const command=args.shift(),flags=new Map<string,string>();
const allowed=new Set(command==='probe'?['actor-user-id','source-id','keyword','country','status','media-type','limit','evidence-dir']:command==='grant'?['actor-user-id','manifest','evidence-dir']:[]);
function argument(name:string) {const value=flags.get(name);if(!value)throw new DomainError(400,'SOURCE_PROBE_ARGUMENT_REQUIRED');return value;}
let db:PrismaClient|undefined;
try {
 if(!['probe','grant'].includes(command??''))throw new DomainError(400,'SOURCE_PROBE_COMMAND_INVALID');
 while(args.length) {const name=args.shift()!;const value=args.shift();if(!name.startsWith('--')||!allowed.has(name.slice(2))||flags.has(name.slice(2))||!value||value.startsWith('--'))throw new DomainError(400,'SOURCE_PROBE_ARGUMENT_INVALID');flags.set(name.slice(2),value);}
 if(!/^postgres(ql)?:\/\//.test(process.env.DATABASE_URL??''))throw new DomainError(503,'DATABASE_NOT_CONFIGURED');
 db=new PrismaClient();const timezone=await db.$queryRaw<Array<{TimeZone:string}>>`SHOW timezone`;if(timezone[0]?.TimeZone!=='UTC')throw new DomainError(503,'DATABASE_TIMEZONE_INVALID');
 const common={actorUserId:argument('actor-user-id'),evidenceRoot:argument('evidence-dir')};
 if(command==='probe') {
  const controller=new AbortController();for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>controller.abort());
  const result=await runSourceProbe(db,{...common,sourceId:argument('source-id'),query:{keyword:argument('keyword'),country:argument('country'),status:flags.get('status')??'all',mediaType:flags.get('media-type')??'all',limit:Number(flags.get('limit')??3)},signal:controller.signal});
  console.log(JSON.stringify({event:'source_probe_complete',...result}));if(result.status!=='success')process.exitCode=2;
 } else {
  const profile=await grantSourceProfile(db,{...common,manifestPath:argument('manifest')});console.log(JSON.stringify({event:'source_query_verified',sourceId:profile.sourceId,profileId:profile.id,query:profile.query,expiresAt:profile.expiresAt,sourceRemainsPaused:true}));
 }
} catch(error) {console.error(JSON.stringify({event:'source_probe_failed',errorCode:error instanceof DomainError?error.code:error instanceof Error&&error.message==='META_BROWSER_CHANNEL_INVALID'?'META_BROWSER_CHANNEL_INVALID':'SOURCE_PROBE_FAILED'}));process.exitCode=1;}
finally {await db?.$disconnect();}
