import {HttpError,prisma} from 'wasp/server';
import {z} from 'zod';
import {DomainError,requirePlatformAdmin} from '../team/access';
import {saveSeedDefinition,importSeedBaseline} from '../seed-library/catalog';
import {setSeedStatus,previewSeedImport,commitSeedImport,confirmSeedRelation,saveSeedScanPlan,verifyNativeSeed} from '../seed-library/admin';
import {previewPublication,publishSeedConfig,rollbackSeedConfig} from '../seed-library/publications';
import {runSeedDispatchAdminCommand,seedDispatchAdminTypes} from '../seed-library/dispatch-admin';
import {saveLegacyOwnerIntent} from '../seed-library/legacy-owners';
import {importAdvertiserDirectory} from '../seed-library/directory';
import {buildStaticSeedBaseline,exportSeedCsv} from '../seed-library/imports';
import {listSeedPage,listSeedImportPreview,getSeedDetailView,listSeedDispatchPage,getSeedOverviewView,getSeedCoverageView,getSeedRulesView,type SeedPageInput} from '../seed-library/queries';
type Context={user?:{id:string}|null};
function user(context:Context){if(!context.user?.id)throw new DomainError(401,'AUTH_REQUIRED');return context.user.id;}
async function safe<T>(run:()=>Promise<T>):Promise<T>{try{return await run();}catch(error){if(error instanceof DomainError)throw new HttpError(error.status,error.code);if(error instanceof z.ZodError)throw new HttpError(400,'SEED_INPUT_INVALID');throw new HttpError(500,'SEED_REQUEST_FAILED');}}
export const getSeedPage=(args:Omit<SeedPageInput,'userId'>,context:Context)=>safe(()=>listSeedPage(prisma,{...args,userId:user(context)}));
export const getSeedImportPreview=(args:{importId:string;cursor?:string;limit?:number},context:Context)=>safe(()=>listSeedImportPreview(prisma,{...args,userId:user(context)}));
export const getSeedDetail=(args:{seedId:string},context:Context)=>safe(()=>getSeedDetailView(prisma,{...args,userId:user(context)}));
export const getSeedDispatchPage=(args:Omit<SeedPageInput,'userId'>,context:Context)=>safe(()=>listSeedDispatchPage(prisma,{...args,userId:user(context)}));
export const getSeedOverview=(args:{from?:string;to?:string},context:Context):Promise<any>=>safe(()=>getSeedOverviewView(prisma,{...args,userId:user(context)}));
export const getSeedCoverage=(args:{from?:string;to?:string;sourceKey?:string},context:Context):Promise<any>=>safe(()=>getSeedCoverageView(prisma,{...args,userId:user(context)}));
export const getSeedRules=(_args:Record<string,never>,context:Context)=>safe(()=>getSeedRulesView(prisma,{userId:user(context)}));
export const exportSeedLibrary=(_args:Record<string,never>,context:Context)=>safe(async()=>{await requirePlatformAdmin(prisma,user(context));return {csv:exportSeedCsv(await prisma.seedDefinition.findMany({orderBy:{id:'asc'}})),encoding:'spreadsheet-safe-v1'};});
const commandSchema=z.object({type:z.string().min(1).max(60),targetId:z.string().uuid().optional(),expectedRevision:z.number().int().nonnegative().optional(),idempotencyKey:z.string().min(1).max(128),reason:z.string().trim().min(1).max(1000),payload:z.record(z.string(),z.unknown())}).strict();
export async function seedCommand(args:unknown,context:Context):Promise<any>{
 return safe(async()=>{
  const input=commandSchema.parse(args),actorUserId=user(context),base={actorUserId,idempotencyKey:input.idempotencyKey,reason:input.reason},payload=input.payload as any;
  const targetId=()=>z.string().uuid().parse(input.targetId);const parentRevision=()=>{const parent=z.number().int().nonnegative().parse(payload.parentRevision??0);if(input.expectedRevision!==undefined&&input.expectedRevision!==parent)throw new DomainError(409,'SEED_PUBLICATION_CONFLICT');return parent;};
  switch(input.type){
   case 'SAVE_SEED':return saveSeedDefinition(prisma,{...base,targetId:input.targetId,expectedRevision:input.expectedRevision,payload});
   case 'SET_SEED_STATUS':return setSeedStatus(prisma,{...base,targetId:targetId(),expectedRevision:input.expectedRevision,status:payload.status});
   case 'SAVE_SEED_SCAN_PLAN':return saveSeedScanPlan(prisma,{...base,targetId:input.targetId,expectedRevision:input.expectedRevision,payload});
   case 'VERIFY_NATIVE_SEED':return verifyNativeSeed(prisma,{...base,targetId:targetId(),expectedRevision:z.number().int().positive().parse(input.expectedRevision),evidenceIds:z.array(z.string().uuid()).min(1).parse(payload.evidenceIds)});
   case 'CONFIRM_SEED_RELATION':case 'REJECT_SEED_RELATION':return confirmSeedRelation(prisma,{...base,targetId:targetId(),decision:input.type==='CONFIRM_SEED_RELATION'?'CONFIRMED':'REJECTED'});
   case 'PREVIEW_SEED_IMPORT':return previewSeedImport(prisma,{...base,csv:z.string().parse(payload.csv)});
   case 'COMMIT_SEED_IMPORT':return commitSeedImport(prisma,{...base,targetId:targetId(),mode:z.enum(['ALL_OR_NOTHING','SKIP_ERRORS']).parse(payload.mode)});
   case 'IMPORT_STATIC_SEED_BASELINE':return importSeedBaseline(prisma,{...base,...buildStaticSeedBaseline()});
   case 'IMPORT_ADVERTISER_DIRECTORY':return importAdvertiserDirectory(prisma,{...base,json:z.string().parse(payload.json)});
   case 'PREVIEW_SEED_PUBLICATION':return previewPublication(prisma,{...base,parentRevision:parentRevision()});
   case 'PUBLISH_SEED_CONFIG':return publishSeedConfig(prisma,{...base,parentRevision:parentRevision(),previewId:z.string().uuid().parse(payload.previewId??input.targetId)});
   case 'ROLLBACK_SEED_CONFIG':return rollbackSeedConfig(prisma,{...base,parentRevision:parentRevision(),targetId:targetId()});
   case 'SET_LEGACY_OWNER_STATUS':return saveLegacyOwnerIntent(prisma,{...base,sourceKey:z.string().parse(payload.sourceKey),legacyOwnerKey:z.string().min(1).max(2000).parse(payload.legacyOwnerKey),status:z.enum(['ACTIVE','PAUSED','REMOVED']).parse(payload.status)});
   default:if(seedDispatchAdminTypes.includes(input.type as any))return runSeedDispatchAdminCommand(prisma,{...base,type:input.type,payload});throw new DomainError(400,'SEED_COMMAND_UNSUPPORTED');
  }
 });
}
