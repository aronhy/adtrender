import { describe, expect, it } from 'vitest';
import { activityColumns, buildActivityCsv, emailRetryEligibility, redactAdminMetadata, activitySql } from './platform-admin-activity';

describe('platform activity safety and evidence contracts', () => {
  it('drops nested credentials, signature parameters and bearer tokens on the server', () => {
    const result = redactAdminMetadata({ reason: 'checked', password: 'secret', nested: { signedUrl: 'https://x.test/a?sig=secret', note: 'Bearer secret', amount: 5 }, apiKey: 'secret' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result).toMatchObject({ reason: 'checked', nested: { amount: 5 } });
  });
  it('exports BOM and caveats, neutralizes formulas and never adds internal fields', () => {
    const csv = buildActivityCsv('usage', [{ id: 'hidden', createdAt: '2026-10-11T00:00:00Z', cells: { organization: '=IMPORTXML("evil")', quantity: 3, idempotencyKey: '12345678', secret: 'not-exported' } }], { from: '2026-10-01', to: '2026-10-11' }, '2026-10-11T01:00:00Z');
    expect(csv.startsWith('\uFEFF"#')).toBe(true);
    expect(csv).toContain("'=IMPORTXML");
    expect(csv).toContain('预占尚未结算不代表已完成分析');
    expect(csv).not.toContain('not-exported');
    expect(csv).not.toContain('hidden');
    expect(activityColumns.visits.map(c => c.key)).not.toContain('tokenHash');
  });
  it('bounds email retries to failed, retained payload, lease-free rows below worker maximum', () => {
    const now = new Date('2026-10-11T00:00:00Z');
    const row = { status: 'FAILED', attempts: 2, payloadAvailable: true, payloadExpiresAt: '2026-10-11T01:00:00Z', expiresAt: '2026-11-11T00:00:00Z', leaseExpiresAt: null };
    expect(emailRetryEligibility(row, now)).toMatchObject({ eligible: true });
    for (const override of [{ attempts: 3 }, { status: 'UNKNOWN' }, { payloadAvailable: false }, { payloadExpiresAt: now.toISOString() }, { leaseExpiresAt: '2026-10-11T00:01:00Z' }]) expect(emailRetryEligibility({ ...row, ...override }, now).eligible).toBe(false);
  });
  it('keeps untrusted filter metadata in one quoted CSV cell so commas cannot create formula cells', () => {
    const csv = buildActivityCsv('visits', [], { search: 'search,=HYPERLINK("https://example.invalid")\n@SUM(1)' }, '2026-10-11T00:00:00Z');
    const first = csv.slice(1).split('\r\n')[0];
    expect(first).toMatch(/^"(?:[^"\r\n]|"")*"$/);
    expect(first).toContain('HYPERLINK');
  });
  it('uses safe projected email fields and filters audit to platform operations only', () => {
    const email = activitySql('email', {}, new Date()).projection.sql;
    expect(email).not.toMatch(/SELECT\s+\*/i);
    expect(email).not.toContain('dedupeKey');
    expect(email).not.toMatch(/(?:^|,)t\."encryptionKeyVersion"(?:,|$)/);
    const audit = activitySql('audit', {}, new Date()).where.sql;
    expect(audit).toContain('workspaceId');
    expect(audit).toContain('IS NULL');
    expect(audit).toContain('action');
  });
  it('never fetches visit tokens or full idempotency keys and keeps test cohort explicit', () => {
    expect(activitySql('visits', {}, new Date()).projection.sql).not.toContain('tokenHash');
    expect(activitySql('visits', {}, new Date()).projection.sql).toContain('isTest');
    expect(activitySql('usage', {}, new Date()).projection.sql).toContain('LEFT(t."idempotencyKey", 8)');
  });
});

import { vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { exportPlatformAdminActivity, getPlatformAdminActivity, runPlatformAdminActivityCommand } from './platform-admin-activity';
const actor='00000000-0000-4000-8000-000000000001',target='00000000-0000-4000-8000-000000000002';
function transactionMock(admin=true){
 const tx={user:{findUnique:vi.fn().mockResolvedValue({id:actor,email:'admin@example.test',isAdmin:admin,disabledAt:null})},$queryRaw:vi.fn(),$executeRaw:vi.fn(),feedback:{update:vi.fn()},accountSupportRequest:{update:vi.fn()},emailDelivery:{updateMany:vi.fn()},auditEvent:{create:vi.fn()}};
 const db={$transaction:vi.fn(async(fn:(value:unknown)=>Promise<unknown>)=>fn(tx))} as unknown as PrismaClient;
 return {db,tx};
}
describe('activity authorization and transactional commands',()=>{
 it('rejects non-administrators before any record or export read',async()=>{
  const{db,tx}=transactionMock(false);
  await expect(getPlatformAdminActivity(db,{userId:actor,tab:'visits'})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
  await expect(exportPlatformAdminActivity(db,{userId:actor,tab:'usage'})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
  expect(tx.$queryRaw).not.toHaveBeenCalled();
 });
 it('exports all filtered records rather than one page',async()=>{
  const{db,tx}=transactionMock();const rows=Array.from({length:42},(_,i)=>({id:String(i),createdAt:new Date(),organization:`Org ${i}`,key:'ANALYSES',quantity:1,status:'SETTLED',releaseReason:null,idempotencyKey:'12345678'}));tx.$queryRaw.mockResolvedValue(rows);
  const result=await exportPlatformAdminActivity(db,{userId:actor,tab:'usage'});
  expect(result.csv.split('\r\n')).toHaveLength(44);expect(result.csv).toContain('Org 41');
  expect(tx.$queryRaw.mock.calls[0][0].sql).not.toContain('LIMIT');
 });
 it('requires explicit identity verification for a deletion request before state changes',async()=>{
  const{db,tx}=transactionMock();tx.$queryRaw.mockResolvedValue([{id:target,status:'OPEN',kind:'DELETION_REQUEST',userId:target}]);
  await expect(runPlatformAdminActivityCommand(db,{userId:actor,command:'resolve-request',id:target,reason:'reviewed',expectedStatus:'OPEN'})).rejects.toMatchObject({code:'IDENTITY_VERIFICATION_REQUIRED'});
  expect(tx.accountSupportRequest.update).not.toHaveBeenCalled();expect(tx.auditEvent.create).not.toHaveBeenCalled();
 });
 it('returns conflict if another operator already handled the record',async()=>{
  const{db,tx}=transactionMock();tx.$queryRaw.mockResolvedValue([{id:target,status:'RESOLVED',category:'GENERAL',organizationId:target}]);
  await expect(runPlatformAdminActivityCommand(db,{userId:actor,command:'resolve-feedback',id:target,reason:'checked',expectedStatus:'OPEN'})).rejects.toMatchObject({code:'ADMIN_ACTIVITY_CONFLICT'});
  expect(tx.feedback.update).not.toHaveBeenCalled();
 });
 it('records reason, before/after and identity confirmation without performing deletion',async()=>{
  const{db,tx}=transactionMock();tx.$queryRaw.mockResolvedValue([{id:target,status:'OPEN',kind:'DELETION_REQUEST',userId:target}]);
  expect(await runPlatformAdminActivityCommand(db,{userId:actor,command:'resolve-request',id:target,reason:'Identity and retention reviewed',identityVerified:true,expectedStatus:'OPEN'})).toEqual({id:target,status:'RESOLVED'});
  expect(tx.auditEvent.create).toHaveBeenCalledWith({data:expect.objectContaining({actorUserId:actor,action:'ACCOUNT_SUPPORT_RESOLVED',metadata:expect.objectContaining({before:{status:'OPEN'},after:{status:'RESOLVED'},identityVerified:true,reason:'Identity and retention reviewed'})})});
  expect(tx.accountSupportRequest.update).toHaveBeenCalledOnce();
 });
});
