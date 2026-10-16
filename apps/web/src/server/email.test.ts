import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { encryptMessage,decryptMessage,queueEmail,deliverEmailBatch } from './email';
const testUrl=process.env.SAAS_TEST_DATABASE_URL;
const db=new PrismaClient({datasources:{db:{url:testUrl??'postgresql://unused@127.0.0.1:1/not_run'}}});
const key='a'.repeat(64);
const dedupeKeys=new Set<string>();
afterAll(async()=>{
  if(dedupeKeys.size)await db.emailDelivery.deleteMany({where:{dedupeKey:{in:[...dedupeKeys]}}});
  await db.$disconnect();
});
it('authenticates encrypted link payload and rejects tampering or a wrong key',()=>{
  const message={to:'a@example.org',subject:'验证',text:'secret-token-link'};
  const encrypted=encryptMessage(message,key);
  expect(encrypted).not.toContain('secret-token');
  expect(decryptMessage(encrypted,key)).toEqual(message);
  expect(()=>decryptMessage(encrypted,'b'.repeat(64))).toThrow();
  expect(()=>decryptMessage(encrypted.slice(0,-5)+'bad!!',key)).toThrow();
});
it.skipIf(!testUrl)('deduplicates outbox, claims once, clears sensitive payload after delivery',async()=>{
  const dedupeKey=randomUUID(), to=`email-${dedupeKey}@example.org`;
  dedupeKeys.add(dedupeKey);
  const message={to,subject:'验证',text:'secret-link'};
  await queueEmail(db,message,{key,dedupeKey,templateKey:'VERIFY'});
  await queueEmail(db,message,{key,dedupeKey,templateKey:'VERIFY'});
  expect(await db.emailDelivery.count({where:{dedupeKey}})).toBe(1);
  const seen:string[]=[];
  const send=async(m:typeof message)=>{seen.push(m.to);return {messageId:'local-'+randomUUID()};};
  await Promise.all([deliverEmailBatch(db,send,key,1),deliverEmailBatch(db,send,key,1)]);
  expect(seen.filter(x=>x===to)).toHaveLength(1);
  const row=await db.emailDelivery.findUniqueOrThrow({where:{dedupeKey}});
  expect(row.status).toBe('SENT');expect(row.encryptedPayload).toBeNull();
});
