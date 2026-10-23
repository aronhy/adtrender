import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { consumeRateLimit } from './rate-limit';
const testUrl = process.env.SAAS_TEST_DATABASE_URL;
const databaseUrl = testUrl ?? 'postgresql://unused@127.0.0.1:1/not_run';
const db = new PrismaClient({datasources:{db:{url:databaseUrl}}});
afterAll(()=>db.$disconnect());
it.skipIf(!testUrl)('enforces a shared concurrent limit while separating scopes and excluding raw identities',async()=>{
  const principal=`sensitive-${randomUUID()}@example.org`, now=new Date('2026-10-04T12:00:01Z');
  const results=await Promise.allSettled(Array.from({length:8},()=>consumeRateLimit(db,'LOGIN',principal,{limit:3,windowMs:60000},now)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(3);
  for(const result of results)if(result.status==='rejected')expect(result.reason).toMatchObject({status:429,code:'RATE_LIMITED'});
  await expect(consumeRateLimit(db,'EMAIL',principal,{limit:3,windowMs:60000},now)).resolves.toBeUndefined();
  await expect(consumeRateLimit(db,'LOGIN',principal,{limit:3,windowMs:60000},new Date(now.getTime()+60000))).resolves.toBeUndefined();
  const rows=await db.rateLimitBucket.findMany({where:{scope:'LOGIN',windowStart:new Date('2026-10-04T12:00:00Z')}});
  expect(JSON.stringify(rows)).not.toContain(principal);
});
it.skipIf(!testUrl)('counts every simultaneous first request from independent clients without leaking unique-key errors',async()=>{
  const other=new PrismaClient({datasources:{db:{url:databaseUrl}}});
  const scope=`CONCURRENT_${randomUUID()}`,now=new Date();
  try {
    for(let round=0;round<8;round++) {
      const principal=`concurrent-${randomUUID()}@example.test`;
      const results=await Promise.allSettled(Array.from({length:16},(_,index)=>consumeRateLimit(index%2?db:other,scope,principal,{limit:3,windowMs:60000},now)));
      expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(3);
      for(const result of results)if(result.status==='rejected')expect(result.reason).toMatchObject({status:429,code:'RATE_LIMITED'});
    }
    const buckets=await db.rateLimitBucket.findMany({where:{scope},select:{count:true}});
    expect(buckets).toHaveLength(8);
    expect(buckets.every(bucket=>bucket.count===16)).toBe(true);
  } finally {
    await db.rateLimitBucket.deleteMany({where:{scope}});
    await other.$disconnect();
  }
});
