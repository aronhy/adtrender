import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
const run=promisify(execFile),url=process.env.SAAS_TEST_DATABASE_URL;
const db=new PrismaClient({datasources:{db:{url:url??'postgresql://unused@127.0.0.1:1/not_run'}}});
afterAll(()=>db.$disconnect());
const cwd=fileURLToPath(new URL('../..',import.meta.url));
const cli=(args:string[])=>run(process.execPath,['--import','tsx','src/team/admin-cli.ts',...args],{cwd,env:{PATH:process.env.PATH,NODE_ENV:'test',DATABASE_URL:url,npm_config_audit:'false'},timeout:10000});
describe('public plan CLI commands',()=>{
 it('documents independent publish and withdraw commands',async()=>{
  const result=await cli(['--help']);expect(result.stdout).toContain('plan-publish');expect(result.stdout).toContain('plan-unpublish');
 });
});
describe.skipIf(!url)('actual publication CLI against PostgreSQL without provider credentials',()=>{
 it('withdraws a published plan using the actual CLI without Stripe credentials',async()=>{
  const actor=await db.user.create({data:{email:`cli-${randomUUID()}@example.test`,isAdmin:true}});
  const plan=await db.planVersion.create({data:{key:`cli-${randomUUID()}`,version:1,name:'可撤回套餐',status:'ACTIVE',providerPriceId:'price_fixture',currency:'usd',priceMinor:100,verifiedProviderMode:'LIVE',publicConfirmedAt:new Date()}});
  try {
   const result=await cli(['plan-unpublish','--actor-email',actor.email!,'--key',plan.key,'--version','1']);
   expect(JSON.parse(result.stdout)).toMatchObject({command:'plan-unpublish',result:{id:plan.id,status:'ACTIVE',publicConfirmedAt:null}});
   expect(await db.auditEvent.count({where:{targetId:plan.id,action:'PLAN_PUBLICATION_WITHDRAWN'}})).toBe(1);
  } finally {await db.auditEvent.deleteMany({where:{targetId:plan.id}});await db.planVersion.delete({where:{id:plan.id}});await db.user.delete({where:{id:actor.id}});}
 });
 it('rejects publish without an explicit provider configuration before changing catalog state',async()=>{
  const actor=await db.user.create({data:{email:`cli-${randomUUID()}@example.test`,isAdmin:true}});
  try {await expect(cli(['plan-publish','--actor-email',actor.email!,'--key','missing-plan','--version','1'])).rejects.toMatchObject({stderr:expect.stringContaining('PLAN_MODE_NOT_CONFIGURED')});}
  finally {await db.user.delete({where:{id:actor.id}});}
 });
});
