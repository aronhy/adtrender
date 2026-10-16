import {describe,it,expect} from 'vitest';
import {assertLegacySourceAllowed} from './legacy-source-guard';
describe('legacy paths cannot bypass centrally managed sources',()=>{
 it('blocks a source once central ownership exists even when its mode remains LEGACY',async()=>{
  const db={collectorSourceAssignment:{count:async()=>1},collectorSourceControl:{findMany:async()=>[{controlMode:'LEGACY_QUEUE'}]}};
  await expect(assertLegacySourceAllowed(db,'meta_ad_library','META')).rejects.toMatchObject({code:'LEGACY_SOURCE_CONTROLLED'});
 });
 it('blocks every managed mode, central cooldown and manual pause before an adapter runs',async()=>{
  for(const control of [{controlMode:'CONFIG_QUEUE'},{controlMode:'TASK_CLAIM'},{controlMode:'LEGACY_QUEUE',manualPause:true},{controlMode:'LEGACY_QUEUE',notBefore:new Date('2026-10-12T00:00:00Z')}]){
   const db={collectorSourceAssignment:{count:async()=>0},collectorSourceControl:{findMany:async()=>[control]}};
   await expect(assertLegacySourceAllowed(db,'meta_ad_library','META',new Date('2026-10-11T00:00:00Z'))).rejects.toMatchObject({code:'LEGACY_SOURCE_CONTROLLED'});
  }
 });
 it('allows a compatible unmanaged source and rechecks on every request boundary',async()=>{
  let managed=false;const db={collectorSourceAssignment:{count:async()=>0},collectorSourceControl:{findMany:async()=>managed?[{controlMode:'TASK_CLAIM'}]:[]}};
  await expect(assertLegacySourceAllowed(db,'meta_ad_library','META')).resolves.toBeUndefined();managed=true;
  await expect(assertLegacySourceAllowed(db,'meta_ad_library','META')).rejects.toMatchObject({code:'LEGACY_SOURCE_CONTROLLED'});
 });
});
