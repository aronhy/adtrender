import type { Prisma, PrismaClient, EmailDelivery } from '@prisma/client';
import { createCipheriv,createDecipheriv,randomBytes,randomUUID } from 'node:crypto';
import { DomainError } from '../team/access';
export type Message={to:string;subject:string;text:string;html?:string};
function keyBytes(key:string) { if(!/^[a-f\d]{64}$/i.test(key))throw new DomainError(503,'EMAIL_ENCRYPTION_UNCONFIGURED'); return Buffer.from(key,'hex'); }
function validateMessage(m:Message) {
  if (!m || typeof m.to!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.to) || /[\r\n]/.test(m.to+m.subject) || typeof m.text!=='string' || !m.subject || JSON.stringify(m).length>100000) throw new DomainError(400,'INVALID_EMAIL');
}
export function encryptMessage(message:Message,key:string):string {
  validateMessage(message);
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyBytes(key),iv);
  const body=Buffer.concat([cipher.update(JSON.stringify(message),'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),body.toString('base64url')].join('.');
}
export function decryptMessage(value:string,key:string):Message {
  const [version,iv,tag,body,...rest]=value.split('.');
  if(version!=='v1'||!iv||!tag||!body||rest.length)throw new DomainError(500,'EMAIL_PAYLOAD_INVALID');
  const decipher=createDecipheriv('aes-256-gcm',keyBytes(key),Buffer.from(iv,'base64url'));
  decipher.setAuthTag(Buffer.from(tag,'base64url'));
  const message=JSON.parse(Buffer.concat([decipher.update(Buffer.from(body,'base64url')),decipher.final()]).toString('utf8')) as Message;
  validateMessage(message);return message;
}
export async function queueEmail(db:Prisma.TransactionClient,message:Message,options:{key:string;dedupeKey:string;templateKey:string;organizationId?:string;userId?:string;expiresAt?:Date}):Promise<void> {
  const payload=encryptMessage(message,options.key);
  const expiry=options.expiresAt??new Date(Date.now()+3600000);
  if(expiry<=new Date())throw new DomainError(400,'EMAIL_EXPIRED');
  await db.emailDelivery.upsert({where:{dedupeKey:options.dedupeKey},update:{},create:{recipientEmail:message.to,templateKey:options.templateKey,dedupeKey:options.dedupeKey,organizationId:options.organizationId,userId:options.userId,encryptedPayload:payload,encryptionKeyVersion:'v1',payloadExpiresAt:expiry,expiresAt:new Date(Date.now()+30*86400000)}});
}
export async function deliverEmailBatch(db:PrismaClient,send:(m:Message)=>Promise<{messageId?:string}>,key:string,limit=10):Promise<void> {
  keyBytes(key);
  // Expired tokens are cleared. An abandoned in-flight delivery is uncertain,
  // not automatically resent: SMTP has no exactly-once delivery guarantee.
  const now=new Date();
  await db.emailDelivery.updateMany({where:{status:{in:['QUEUED','SENDING','FAILED']},payloadExpiresAt:{lte:now}},data:{status:'EXPIRED',encryptedPayload:null}});
  // UNKNOWN remains uncertain even after its short-lived payload is erased.
  await db.emailDelivery.updateMany({where:{encryptedPayload:{not:null},payloadExpiresAt:{lte:now}},data:{encryptedPayload:null}});
  await db.emailDelivery.updateMany({where:{status:'SENDING',leaseExpiresAt:{lt:new Date()}},data:{status:'UNKNOWN',lastErrorCode:'DELIVERY_OUTCOME_UNKNOWN'}});
  for(let i=0;i<Math.min(limit,100);i++) {
    const owner=randomUUID();
    const claimed=await db.$queryRaw<EmailDelivery[]>`UPDATE "EmailDelivery" SET status='SENDING',"leaseOwner"=${owner},"leaseExpiresAt"=clock_timestamp()+interval '30 seconds',attempts=attempts+1,"updatedAt"=clock_timestamp() WHERE id=(SELECT id FROM "EmailDelivery" WHERE status='QUEUED' AND "encryptionKeyVersion"='v1' AND "nextAttemptAt"<=clock_timestamp() AND "payloadExpiresAt">clock_timestamp() ORDER BY "createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
    const row=claimed[0];if(!row)return;
    try {
      const message=decryptMessage(row.encryptedPayload!,key);
      const result=await send(message);
      await db.emailDelivery.updateMany({where:{id:row.id,status:'SENDING',leaseOwner:owner},data:{status:'SENT',provider:'SMTP',providerMessageId:result.messageId,sentAt:new Date(),encryptedPayload:null,leaseOwner:null,leaseExpiresAt:null,lastErrorCode:null}});
    } catch(error) {
      const code=error&&typeof error==='object'&&'code'in error?String(error.code):'';
      const responseCode=error&&typeof error==='object'&&'responseCode'in error?Number(error.responseCode):0;
      const retryable=code==='ECONNREFUSED'||code==='EDNS'||(responseCode>=400&&responseCode<500);
      const definitive=retryable||responseCode>=500||error instanceof DomainError;
      const status=retryable&&row.attempts<3?'QUEUED':definitive?'FAILED':'UNKNOWN';
      // A definite SMTP rejection can be retried by an administrator after
      // configuration is fixed. Keep only the encrypted, unexpired payload;
      // automatic retries, the three-attempt limit and UNKNOWN policy stay intact.
      const manualRetry=status==='FAILED'&&responseCode>=500&&row.attempts<3;
      await db.emailDelivery.updateMany({where:{id:row.id,status:'SENDING',leaseOwner:owner},data:{status,lastErrorCode:status==='UNKNOWN'?'DELIVERY_OUTCOME_UNKNOWN':'SMTP_FAILURE',nextAttemptAt:new Date(Date.now()+Math.min(3600000,30000*2**row.attempts)),leaseOwner:null,leaseExpiresAt:null,...(status==='FAILED'&&!manualRetry?{encryptedPayload:null}:{})}});
    }
  }
}
