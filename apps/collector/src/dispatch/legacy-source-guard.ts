import {DomainError} from '../../../web/src/team/access';
/** Legacy history/app jobs have no new central execution context. Block them when a source is managed. */
export async function assertLegacySourceAllowed(db:any,sourceKey:string,channel:string,now=new Date()):Promise<void>{
 const assignments=await db.collectorSourceAssignment.count({where:{sourceKey}});
 if(assignments)throw new DomainError(409,'LEGACY_SOURCE_CONTROLLED');
 const controls=await db.collectorSourceControl.findMany({where:{sourceKey,channel:{in:['*',channel]}}});
 if(controls.some((c:any)=>c.controlMode!=='LEGACY_QUEUE'||c.manualPause||c.notBefore&&new Date(c.notBefore)>now))throw new DomainError(409,'LEGACY_SOURCE_CONTROLLED');
}
