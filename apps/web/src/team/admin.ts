import type { Prisma, PrismaClient } from '@prisma/client';
import { DomainError, lockAccountAdministration, requirePlatformAdmin } from './access';

export async function setUserDisabled(db: PrismaClient, input: { actorUserId: string; targetUserId: string; disabled: boolean; reason: string }): Promise<{ id: string; disabledAt: Date | null }> {
  if (typeof input.targetUserId !== 'string' || !input.targetUserId || input.targetUserId.length > 100 || typeof input.disabled !== 'boolean') throw new DomainError(400,'INVALID_ADMIN_COMMAND');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 500 || /[\u0000-\u001f\u007f]/.test(input.reason)) throw new DomainError(400,'INVALID_ADMIN_REASON');
  return db.$transaction(async tx => {
    await lockAccountAdministration(tx);
    await requirePlatformAdmin(tx,input.actorUserId);
    if (input.disabled && input.actorUserId === input.targetUserId) throw new DomainError(409,'SELF_DISABLE_FORBIDDEN');
    const target=await tx.user.findUnique({where:{id:input.targetUserId}});
    if (!target) throw new DomainError(404,'USER_NOT_FOUND');
    if (Boolean(target.disabledAt)===input.disabled) return {id:target.id,disabledAt:target.disabledAt};
    let sessionsRevoked=0,authLinksRevoked=0;
    if (input.disabled) {
      if (target.isAdmin && await tx.user.count({where:{isAdmin:true,disabledAt:null,id:{not:target.id}}})===0) throw new DomainError(409,'LAST_PLATFORM_ADMIN');
      const owned=await tx.organizationMember.findMany({where:{userId:target.id,role:'OWNER'},orderBy:{organizationId:'asc'},select:{organizationId:true}});
      for (const membership of owned) {
        await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${membership.organizationId} FOR UPDATE`;
        if (await tx.organizationMember.count({where:{organizationId:membership.organizationId,role:'OWNER',userId:{not:target.id},user:{disabledAt:null}}})===0) throw new DomainError(409,'LAST_ACTIVE_OWNER');
      }
      const revoked=await tx.session.deleteMany({where:{auth:{userId:target.id}}});
      sessionsRevoked=revoked.count;
      if (target.email) authLinksRevoked=(await tx.authLink.updateMany({where:{recipientEmail:target.email.toLowerCase(),consumedAt:null},data:{consumedAt:new Date(),encryptedPayload:''}})).count;
    }
    const changed=await tx.user.update({where:{id:target.id},data:{disabledAt:input.disabled?new Date():null},select:{id:true,disabledAt:true}});
    await tx.auditEvent.create({data:{actorUserId:input.actorUserId,action:input.disabled?'USER_DISABLED':'USER_RESTORED',targetType:'User',targetId:target.id,metadata:{reason:input.reason.trim(),sessionsRevoked,authLinksRevoked}}});
    return changed;
  },{maxWait:10_000,timeout:20_000});
}

/** Operator-only CLI entry. It never creates users, identities or passwords. */
export async function bootstrapPlatformAdmin(db: PrismaClient, input: { email: string }): Promise<{ id: string; isAdmin: boolean }> {
  const email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254) throw new DomainError(400,'INVALID_EMAIL');
  return db.$transaction(async tx => {
    await lockAccountAdministration(tx);
    const user=await tx.user.findUnique({where:{email}});
    if (!user) throw new DomainError(404,'BOOTSTRAP_USER_NOT_FOUND');
    if (user.disabledAt) throw new DomainError(403,'ACCOUNT_DISABLED');
    const identity=await tx.authIdentity.findUnique({where:{providerName_providerUserId:{providerName:'email',providerUserId:email}},include:{auth:true}});
    let data:unknown;
    try {data=JSON.parse(identity?.providerData??'{}');} catch {throw new DomainError(409,'BOOTSTRAP_EMAIL_UNVERIFIED');}
    if (identity?.auth.userId!==user.id || !data || typeof data!=='object' || !('isEmailVerified' in data) || data.isEmailVerified!==true || !('hashedPassword' in data) || typeof data.hashedPassword!=='string' || !data.hashedPassword) throw new DomainError(409,'BOOTSTRAP_EMAIL_UNVERIFIED');
    if (user.isAdmin) return {id:user.id,isAdmin:true};
    const changed=await tx.user.update({where:{id:user.id},data:{isAdmin:true},select:{id:true,isAdmin:true}});
    await tx.auditEvent.create({data:{action:'PLATFORM_ADMIN_GRANTED',targetType:'User',targetId:user.id,metadata:{via:'LOCAL_CLI',verifiedEmail:true}}});
    return changed;
  });
}

export async function seedDataSources(db: Prisma.TransactionClient): Promise<{ id: string; key: string; status: string }> {
  return db.dataSource.upsert({where:{key:'meta_ad_library'},update:{},create:{key:'meta_ad_library',name:'Meta 广告资料库',status:'PAUSED',adapterVersion:'meta-dom-1',configuration:{},capabilities:{version:1,verification:'UNVERIFIED',verifiedQueryProfiles:[]}},select:{id:true,key:true,status:true}});
}
