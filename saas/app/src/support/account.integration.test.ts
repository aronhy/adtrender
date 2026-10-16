import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll,describe,expect,it } from 'vitest';
import { getOwnAccountSupportRequest,listAccountSupportRequestsForAdmin,listOwnAccountSupportRequests,resolveAccountSupportRequest,submitAccountSupportRequest } from './account';

const testUrl=process.env.SAAS_TEST_DATABASE_URL;
const db=new PrismaClient({datasources:{db:{url:testUrl??'postgresql://unused@127.0.0.1:1/not_run'}}});
afterAll(()=>db.$disconnect());
const user=(isAdmin=false)=>db.user.create({data:{email:`account-support-${randomUUID()}@example.test`,isAdmin}});

describe.skipIf(!testUrl)('account support before organization onboarding',()=>{
  it('accepts feedback and a deletion request without creating an organization or deleting the account',async()=>{
    const account=await user();
    const feedback=await submitAccountSupportRequest(db,{userId:account.id,kind:'FEEDBACK',body:'  无组织账号需要帮助\n请联系我。  '});
    const deletion=await submitAccountSupportRequest(db,{userId:account.id,kind:'DELETION_REQUEST',body:'请核实后处理账号资料删除申请。'});
    expect(feedback).toMatchObject({userId:account.id,kind:'FEEDBACK',body:'无组织账号需要帮助\n请联系我。',status:'OPEN',resolvedAt:null});
    expect(deletion).toMatchObject({kind:'DELETION_REQUEST',status:'OPEN'});
    expect(await db.organizationMember.count({where:{userId:account.id}})).toBe(0);
    expect(await db.user.findUnique({where:{id:account.id}})).not.toBeNull();
    expect(await db.auditEvent.count({where:{actorUserId:account.id,action:'ACCOUNT_SUPPORT_SUBMITTED'}})).toBe(2);
  });

  it('returns only the caller requests and hides guessed foreign IDs',async()=>{
    const a=await user(),b=await user();
    const own=await submitAccountSupportRequest(db,{userId:a.id,kind:'FEEDBACK',body:'私人账号甲的反馈'});
    const foreign=await submitAccountSupportRequest(db,{userId:b.id,kind:'DELETION_REQUEST',body:'私人账号乙的申请'});
    expect((await listOwnAccountSupportRequests(db,{userId:a.id})).map(row=>row.id)).toEqual([own.id]);
    await expect(getOwnAccountSupportRequest(db,{userId:a.id,requestId:foreign.id})).rejects.toMatchObject({status:404,code:'ACCOUNT_SUPPORT_NOT_FOUND'});
    await expect(getOwnAccountSupportRequest(db,{userId:a.id,requestId:randomUUID()})).rejects.toMatchObject({status:404,code:'ACCOUNT_SUPPORT_NOT_FOUND'});
    await expect(listAccountSupportRequestsForAdmin(db,{actorUserId:a.id})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
    await expect(resolveAccountSupportRequest(db,{actorUserId:a.id,requestId:own.id})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
    await expect(resolveAccountSupportRequest(db,{actorUserId:a.id,requestId:foreign.id})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
  });

  it('allows support admins to read and resolve once under concurrency, without physical deletion',async()=>{
    const account=await user(),admin=await user(true),secondAdmin=await user(true);
    const request=await submitAccountSupportRequest(db,{userId:account.id,kind:'DELETION_REQUEST',body:'等待支持核实处理。'});
    const visible=await listAccountSupportRequestsForAdmin(db,{actorUserId:admin.id});
    expect(visible.find(row=>row.id===request.id)).toMatchObject({user:{id:account.id,email:account.email}});
    const outcomes=await Promise.all([admin,secondAdmin].map(actor=>resolveAccountSupportRequest(db,{actorUserId:actor.id,requestId:request.id})));
    expect(outcomes.every(row=>row.status==='RESOLVED'&&row.resolvedAt)).toBe(true);
    expect(outcomes[0].resolvedAt).toEqual(outcomes[1].resolvedAt);
    expect(await db.auditEvent.count({where:{targetId:request.id,action:'ACCOUNT_SUPPORT_RESOLVED'}})).toBe(1);
    expect(await getOwnAccountSupportRequest(db,{userId:account.id,requestId:request.id})).toMatchObject({status:'RESOLVED'});
    expect(await db.user.findUnique({where:{id:account.id}})).not.toBeNull();
  });

  it('validates kind and body and rechecks disabled accounts on every service entry',async()=>{
    const account=await user(),admin=await user(true);
    const request=await submitAccountSupportRequest(db,{userId:account.id,kind:'FEEDBACK',body:'有效反馈'});
    for(const body of ['   ','x'.repeat(10001),'bad\u0000body'])await expect(submitAccountSupportRequest(db,{userId:account.id,kind:'FEEDBACK',body})).rejects.toMatchObject({code:'INVALID_SUPPORT_BODY'});
    await expect(submitAccountSupportRequest(db,{userId:account.id,kind:'DELETE_NOW' as never,body:'非法类型'})).rejects.toMatchObject({code:'INVALID_SUPPORT_KIND'});
    await db.user.update({where:{id:account.id},data:{disabledAt:new Date()}});
    await expect(submitAccountSupportRequest(db,{userId:account.id,kind:'FEEDBACK',body:'停用'})).rejects.toMatchObject({code:'ACCOUNT_DISABLED'});
    await expect(listOwnAccountSupportRequests(db,{userId:account.id})).rejects.toMatchObject({code:'ACCOUNT_DISABLED'});
    await expect(getOwnAccountSupportRequest(db,{userId:account.id,requestId:request.id})).rejects.toMatchObject({code:'ACCOUNT_DISABLED'});
    await db.user.update({where:{id:admin.id},data:{disabledAt:new Date()}});
    await expect(listAccountSupportRequestsForAdmin(db,{actorUserId:admin.id})).rejects.toMatchObject({code:'ACCOUNT_DISABLED'});
    await expect(resolveAccountSupportRequest(db,{actorUserId:admin.id,requestId:request.id})).rejects.toMatchObject({code:'ACCOUNT_DISABLED'});
  });
});
