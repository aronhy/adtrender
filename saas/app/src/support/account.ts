import type { PrismaClient } from '@prisma/client';
import { DomainError,requireActiveUser,requirePlatformAdmin } from '../team/access';

export type AccountSupportKind='FEEDBACK'|'DELETION_REQUEST';
export type AccountSupportRequestView={id:string;userId:string;kind:string;body:string;status:string;createdAt:Date;resolvedAt:Date|null};

function requestId(value:unknown):string {
  if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))throw new DomainError(400,'INVALID_SUPPORT_REQUEST');
  return value;
}

/** An account can contact support before it has joined any organization. */
export async function submitAccountSupportRequest(db:PrismaClient,input:{userId:string;kind:AccountSupportKind;body:string}):Promise<AccountSupportRequestView>{
  if(!['FEEDBACK','DELETION_REQUEST'].includes(input.kind))throw new DomainError(400,'INVALID_SUPPORT_KIND');
  if(typeof input.body!=='string'||!input.body.trim()||input.body.trim().length>10000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.body))throw new DomainError(400,'INVALID_SUPPORT_BODY');
  return db.$transaction(async tx=>{
    await requireActiveUser(tx,input.userId);
    const request=await tx.accountSupportRequest.create({data:{userId:input.userId,kind:input.kind,body:input.body.trim()}});
    await tx.auditEvent.create({data:{actorUserId:input.userId,action:'ACCOUNT_SUPPORT_SUBMITTED',targetType:'AccountSupportRequest',targetId:request.id,metadata:{kind:request.kind}}});
    return request;
  });
}

export async function listOwnAccountSupportRequests(db:PrismaClient,input:{userId:string}):Promise<AccountSupportRequestView[]>{
  await requireActiveUser(db,input.userId);
  return db.accountSupportRequest.findMany({where:{userId:input.userId},orderBy:[{createdAt:'desc'},{id:'desc'}],take:100});
}

export async function getOwnAccountSupportRequest(db:PrismaClient,input:{userId:string;requestId:string}):Promise<AccountSupportRequestView>{
  await requireActiveUser(db,input.userId);
  const request=await db.accountSupportRequest.findFirst({where:{id:requestId(input.requestId),userId:input.userId}});
  if(!request)throw new DomainError(404,'ACCOUNT_SUPPORT_NOT_FOUND');
  return request;
}

export async function listAccountSupportRequestsForAdmin(db:PrismaClient,input:{actorUserId:string}):Promise<Array<AccountSupportRequestView&{user:{id:string;email:string|null;displayName:string|null}}>>{
  await requirePlatformAdmin(db,input.actorUserId);
  return db.accountSupportRequest.findMany({orderBy:[{createdAt:'desc'},{id:'desc'}],take:100,include:{user:{select:{id:true,email:true,displayName:true}}}});
}

/** Resolving records support review only; no account or private data is deleted. */
export async function resolveAccountSupportRequest(db:PrismaClient,input:{actorUserId:string;requestId:string}):Promise<AccountSupportRequestView>{
  const targetId=requestId(input.requestId);
  return db.$transaction(async tx=>{
    await requirePlatformAdmin(tx,input.actorUserId);
    const locked=await tx.$queryRaw<Array<{id:string}>>`SELECT id FROM "AccountSupportRequest" WHERE id=${targetId} FOR UPDATE`;
    if(!locked.length)throw new DomainError(404,'ACCOUNT_SUPPORT_NOT_FOUND');
    await requirePlatformAdmin(tx,input.actorUserId);
    const request=await tx.accountSupportRequest.findUniqueOrThrow({where:{id:targetId}});
    if(request.status==='RESOLVED')return request;
    const resolved=await tx.accountSupportRequest.update({where:{id:targetId},data:{status:'RESOLVED',resolvedAt:new Date()}});
    await tx.auditEvent.create({data:{actorUserId:input.actorUserId,action:'ACCOUNT_SUPPORT_RESOLVED',targetType:'AccountSupportRequest',targetId,metadata:{kind:request.kind,requesterUserId:request.userId}}});
    return resolved;
  });
}
