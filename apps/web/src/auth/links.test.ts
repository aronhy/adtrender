import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { issueAuthLink, consumeAuthLink } from './links';
const testUrl=process.env.SAAS_TEST_DATABASE_URL;
const db=new PrismaClient({datasources:{db:{url:testUrl??'postgresql://unused@127.0.0.1:1/not_run'}}});
const key='a'.repeat(64);
afterAll(()=>db.$disconnect());
it.skipIf(!testUrl)('purpose-binds and atomically consumes Wasp link envelopes',async()=>{
  const email=`link-${randomUUID()}@example.org`;
  await db.user.create({data:{email,auth:{create:{identities:{create:{providerName:'email',providerUserId:email,providerData:JSON.stringify({hashedPassword:'fixture-hash',isEmailVerified:false})}}}}}});
  const link=await issueAuthLink(db,{email,purpose:'RESET',frameworkToken:'wasp-signed-token',key});
  await expect(consumeAuthLink(db,link,'VERIFY',key)).rejects.toMatchObject({code:'AUTH_LINK_INVALID'});
  const attempts=await Promise.allSettled([consumeAuthLink(db,link,'RESET',key),consumeAuthLink(db,link,'RESET',key)]);
  expect(attempts.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  expect(attempts.find(x=>x.status==='fulfilled')).toMatchObject({value:{frameworkToken:'wasp-signed-token',email}});
  expect(JSON.stringify(await db.authLink.findMany({where:{recipientEmail:email}}))).not.toContain('wasp-signed-token');
});
it.skipIf(!testUrl)('rejects expiration and disabled accounts before forwarding to Wasp',async()=>{
  const email=`expired-${randomUUID()}@example.org`;
  await db.user.create({data:{email,auth:{create:{identities:{create:{providerName:'email',providerUserId:email,providerData:JSON.stringify({hashedPassword:'fixture-hash',isEmailVerified:false})}}}}}});
  const expired=await issueAuthLink(db,{email,purpose:'RESET',frameworkToken:'native',key});
  await db.authLink.updateMany({where:{recipientEmail:email},data:{expiresAt:new Date(0)}});
  await expect(consumeAuthLink(db,expired,'RESET',key)).rejects.toMatchObject({code:'AUTH_LINK_INVALID'});
  const valid=await issueAuthLink(db,{email,purpose:'VERIFY',frameworkToken:'native',key});
  await db.user.update({where:{email},data:{disabledAt:new Date()}});
  await expect(consumeAuthLink(db,valid,'VERIFY',key)).rejects.toMatchObject({code:'AUTH_LINK_INVALID'});
});
