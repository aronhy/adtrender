import {readFile,stat} from 'node:fs/promises';
import {mergeCandidates,type Candidate} from './queue';
export async function loadCandidateFeed(file:string,now:number){
 if((await stat(file)).size>16*1024*1024)throw Error('SNAP_CANDIDATES_INVALID');
 const data=JSON.parse(await readFile(file,'utf8')) as {schema?:number;generatedAt?:string;candidates?:Candidate[];truncated?:boolean};
 const generatedAt=Date.parse(data.generatedAt??'');
 if(data.schema!==1||!Number.isFinite(generatedAt)||generatedAt>now+86400000||data.truncated||!Array.isArray(data.candidates))throw Error('SNAP_CANDIDATES_INVALID');
 // Validate the complete catalog before the caller mutates its durable queue.
 mergeCandidates([],data.candidates,now);
 return {candidates:data.candidates,generatedAt:new Date(generatedAt).toISOString(),stale:now-generatedAt>2*86400000};
}
