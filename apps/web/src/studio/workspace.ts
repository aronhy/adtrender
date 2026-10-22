import {prisma,HttpError} from 'wasp/server';
import {z} from 'zod';
import {DomainError} from '../team/access';
import {loadStudioState,updateStudioState} from './workspace-service';
type Context={user?:{id:string}|null};
const workspace=z.object({workspaceId:z.string().uuid()});
const command=z.discriminatedUnion('type',[workspace.extend({type:z.literal('FOLLOW_BRAND'),advertiserId:z.string().uuid()}),workspace.extend({type:z.literal('UNFOLLOW_BRAND'),advertiserId:z.string().uuid()}),workspace.extend({type:z.literal('UPDATE_PREFERENCES'),preferences:z.record(z.string(),z.unknown())})]);
async function safe<T>(fn:()=>Promise<T>){try{return await fn();}catch(e){if(e instanceof DomainError)throw new HttpError(e.status,e.code);if(e instanceof z.ZodError)throw new HttpError(400,'INVALID_INPUT');throw e;}}
export async function getStudioState(args:unknown,context:Context){return safe(()=>{if(!context.user)throw new DomainError(401,'AUTH_REQUIRED');const a=workspace.parse(args);return loadStudioState(prisma,context.user.id,a.workspaceId);});}
export async function studioCommand(args:unknown,context:Context){return safe(()=>{if(!context.user)throw new DomainError(401,'AUTH_REQUIRED');return updateStudioState(prisma,context.user.id,command.parse(args));});}
