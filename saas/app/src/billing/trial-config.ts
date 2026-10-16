import type {TrialConfig} from './quotas';
import {DomainError} from '../team/access';

/** Development defaults preserve the local fixture contract, not approved prices
 * or production offers. Production must explicitly set all five environment values. */
export function trialConfigFromEnvironment(env:NodeJS.ProcessEnv=process.env):TrialConfig {
  const definitions=[
    ['days','TRIAL_DAYS',14,90],
    ['workspaces','TRIAL_WORKSPACES',1,2_147_483_647],
    ['members','TRIAL_MEMBERS',3,2_147_483_647],
    ['savedAds','TRIAL_SAVED_ADS',100,2_147_483_647],
    ['analyses','TRIAL_ANALYSES',20,2_147_483_647],
  ] as const;
  const result={} as TrialConfig;
  for(const [field,name,developmentDefault,max] of definitions) {
    const raw=env[name];
    if(raw===undefined) {
      if(env.NODE_ENV==='production')throw new DomainError(503,'TRIAL_NOT_CONFIGURED');
      result[field]=developmentDefault;continue;
    }
    const trimmed=raw.trim(),value=Number(trimmed);
    if(!/^[1-9]\d*$/.test(trimmed)||!Number.isSafeInteger(value)||value>max)throw new DomainError(503,'INVALID_TRIAL_CONFIG');
    result[field]=value;
  }
  // This fixed field order feeds initializeTrial's version hash deterministically.
  return result;
}
