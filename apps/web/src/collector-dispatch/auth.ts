import {createHash,timingSafeEqual} from 'node:crypto';
import {DomainError} from '../team/access';
import {seedSourceKeys,type SourceKey} from '@ad-research/contracts/seeds';
import type {MachineIdentity} from './types';
type Credential={nodeId:string;tokenSha256:string;allowedSourceKeys:SourceKey[]};
export function parseCollectorCredentials(raw:string|undefined):Credential[]{
 if(!raw)throw new DomainError(503,'COLLECTOR_AUTH_NOT_CONFIGURED');let parsed:any;try{parsed=JSON.parse(raw);}catch{throw new DomainError(503,'COLLECTOR_AUTH_CONFIG_INVALID');}
 if(!Array.isArray(parsed)||!parsed.length||parsed.some(c=>!c||!/^[A-Za-z0-9_-]{1,128}$/.test(c.nodeId)||!/^[a-f0-9]{64}$/.test(c.tokenSha256)||!Array.isArray(c.allowedSourceKeys)||!c.allowedSourceKeys.length||c.allowedSourceKeys.some((s:string)=>!seedSourceKeys.includes(s as SourceKey))||Object.keys(c).some(k=>!['nodeId','tokenSha256','allowedSourceKeys'].includes(k)))||new Set(parsed.map(c=>c.nodeId)).size!==parsed.length)throw new DomainError(503,'COLLECTOR_AUTH_CONFIG_INVALID');
 return parsed;
}
export function authenticateCollector(headers:Record<string,string|string[]|undefined>,credentials:Credential[]):MachineIdentity{
 const nodeId=headers['x-collector-node'],incarnationId=headers['x-collector-incarnation'],authorization=headers.authorization;
 if(typeof nodeId!=='string'||typeof incarnationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(incarnationId)||typeof authorization!=='string'||!/^Bearer [\x21-\x7e]{32,512}$/.test(authorization))throw new DomainError(401,'COLLECTOR_AUTH_REQUIRED');
 const candidate=credentials.find(c=>c.nodeId===nodeId),digest=createHash('sha256').update(authorization.slice(7)).digest(),expected=Buffer.from(candidate?.tokenSha256??'0'.repeat(64),'hex');
 if(!timingSafeEqual(digest,expected)||!candidate)throw new DomainError(401,'COLLECTOR_AUTH_REJECTED');
 return {nodeId,incarnationId,allowedSourceKeys:[...candidate.allowedSourceKeys]};
}
