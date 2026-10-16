import {DomainError} from '../team/access';
import {createCollectorEvidenceStore,type ArtifactStore} from './evidence-store';
import {createCollectorDispatchService} from './service';
import type {SourceKey} from '@ad-research/contracts/seeds';
export function configuredCollectorDispatch(db:any,env:Record<string,string|undefined>=process.env){
 if(env.COLLECTOR_DISPATCH_ENABLED!=='true')throw new DomainError(503,'COLLECTOR_DISPATCH_NOT_CONFIGURED');
 const positive=(key:string,zero=false)=>{const n=Number(env[key]);if(!env[key]||!Number.isSafeInteger(n)||n<(zero?0:1))throw new DomainError(503,'COLLECTOR_DISPATCH_CONFIG_INVALID');return n;};
 const tokenSecret=env.COLLECTOR_GRANT_SECRET;if(!tokenSecret||tokenSecret.length<32)throw new DomainError(503,'COLLECTOR_DISPATCH_CONFIG_INVALID');
 const evidencePrefix=env.COLLECTOR_EVIDENCE_PREFIX??'collector-evidence',stores=new Map<SourceKey,Promise<ArtifactStore>>();
 const kind=env.COLLECTOR_EVIDENCE_ROOT?'local':'s3';if(kind==='s3'&&(!env.COLLECTOR_EVIDENCE_BUCKET||!env.COLLECTOR_EVIDENCE_REGION))throw new DomainError(503,'COLLECTOR_EVIDENCE_NOT_CONFIGURED');
 const storeForSource=(sourceKey:SourceKey)=>{let store=stores.get(sourceKey);if(!store){const namespace={prefix:evidencePrefix,sourceKey};store=createCollectorEvidenceStore(kind==='local'?{kind:'local',rootDirectory:env.COLLECTOR_EVIDENCE_ROOT!,namespace}:{kind:'s3',bucket:env.COLLECTOR_EVIDENCE_BUCKET!,region:env.COLLECTOR_EVIDENCE_REGION!,endpoint:env.COLLECTOR_EVIDENCE_ENDPOINT,forcePathStyle:env.COLLECTOR_EVIDENCE_PATH_STYLE==='true',namespace});stores.set(sourceKey,store);}return store;};
 return createCollectorDispatchService(db,{tokenSecret,leaseMs:positive('COLLECTOR_LEASE_MS'),requestBudgetMs:positive('COLLECTOR_REQUEST_BUDGET_MS'),exitMarginMs:positive('COLLECTOR_EXIT_MARGIN_MS'),requestSpacingMs:positive('COLLECTOR_REQUEST_SPACING_MS',true),cycleMs:positive('COLLECTOR_CYCLE_MS'),unknownOutcomeBackoffMs:positive('COLLECTOR_UNKNOWN_BACKOFF_MS'),evidencePrefix,evidenceScheme:kind==='local'?'local-private':'s3',storeForSource});
}
