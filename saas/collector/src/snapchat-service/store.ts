import {saveArchivedPending,importArchivedPending} from '../dispatch/pending-envelope';
export {atomic} from '../dispatch/pending-envelope';
export type {Pending} from '../dispatch/pending-envelope';
export const savePending=(root:string,jobId:string,batch:unknown)=>saveArchivedPending(root,'snapchat',jobId,batch);
export const importPending=<B=unknown,R=unknown>(root:string,pending:import('../dispatch/pending-envelope').Pending,ingest:(raw:string)=>Promise<R>)=>importArchivedPending<B,R>(root,'snapchat',pending,ingest);
