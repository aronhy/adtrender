/** Local-only integration rehearsal. No external emails or provider calls. */
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const base = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(base, 'apps/web/package.json'));
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
const database = new URL(process.env.DATABASE_URL ?? '');
assert(['localhost','127.0.0.1','[::1]'].includes(database.hostname) && /^\/saas_(dev|.*test.*)$/.test(database.pathname), 'Use an isolated local SaaS development/test database');
assert(process.env.SMTP_HOST === '127.0.0.1' && process.env.SMTP_PORT === '1025', 'Use the local SMTP sink');
assert(process.env.BILLING_ENABLED !== 'true' && !process.env.OPENAI_API_KEY, 'Provider calls must be disabled for this rehearsal');
const api = process.env.SAAS_TEST_API_URL ?? 'http://localhost:3001';
const apiUrl = new URL(api);
assert(apiUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(apiUrl.hostname) && !apiUrl.username && !apiUrl.password && apiUrl.pathname === '/' && !apiUrl.search && !apiUrl.hash, 'Use an isolated loopback API');
const inbox = [];
const sockets = new Set();
const smtp = net.createServer(socket => {
  sockets.add(socket); socket.on('close',()=>sockets.delete(socket));
  socket.write('220 localhost SMTP test sink\r\n');
  let buffer = '', data = false, body = '', recipient = '', authentication = 0;
  socket.on('data', chunk => {
    buffer += chunk.toString();
    while(buffer.includes('\r\n')) {
      const index = buffer.indexOf('\r\n'), line = buffer.slice(0,index); buffer=buffer.slice(index+2);
      if(data) { if(line==='.') { inbox.push({recipient,body}); data=false;body='';socket.write('250 accepted locally\r\n'); } else body+=line+'\r\n'; continue; }
      if(authentication) { authentication--;socket.write(authentication?'334 UGFzc3dvcmQ6\r\n':'235 authenticated locally\r\n'); }
      else if(/^EHLO|^HELO/i.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
      else if(/^AUTH LOGIN/i.test(line)) { authentication=2;socket.write('334 VXNlcm5hbWU6\r\n'); }
      else if(/^AUTH/i.test(line)) socket.write('235 authenticated locally\r\n');
      else if(/^RCPT TO:/i.test(line)) { recipient=line.match(/<([^>]+)>/)?.[1]??'';socket.write(recipient.endsWith('@example.test')?'250 recipient accepted\r\n':'550 test recipients only\r\n'); }
      else if(line==='DATA') {data=true;socket.write('354 end with dot\r\n');}
      else if(line==='QUIT') socket.end('221 bye\r\n');
      else socket.write('250 ok\r\n');
    }
  });
});
await new Promise((resolve,reject)=>{smtp.once('error',reject);smtp.listen(1025,'127.0.0.1',resolve);});
const assertions=[];
function checked(label) { assertions.push(label); console.log(`PASS ${label}`); }
async function request(path,body,session,expected=200) {
  const response=await fetch(api+path,{method:'POST',headers:{'Content-Type':'application/json',...(session?{Authorization:`Bearer ${session}`}:{})},body:JSON.stringify(body??{})});
  let value;try{value=await response.json();}catch{value={};}
  assert.equal(response.status,expected,`${path}: expected ${expected}; received ${response.status}; ${value.message??value.error??''}`);
  return value;
}
const operation=async(name,args,session,status=200)=>{const data=await request(`/operations/${name}`,{json:args},session,status);return data.json;};
async function flushMail() {
  // Framework queues asynchronously; wait for the expected outbox row before the separate worker process.
  await new Promise(r=>setTimeout(r,150));
  await promisify(execFile)(resolve(base,'scripts/worker.sh'),['--once','--mail-only'],{cwd:resolve(base,'apps/web'),env:process.env,timeout:30000,maxBuffer:100000});
}
function mailToken(email,path) {
  const message=[...inbox].reverse().find(m=>m.recipient===email && m.body.includes(path));assert(message,`Missing local mail for ${path}`);
  const decoded=message.body.replace(/=\r\n/g,'').replace(/=([A-F\d]{2})/g,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
  const token=decoded.match(/[?&](?:token|invite)=([a-f\d]{64})/i)?.[1];assert(token,'Expected opaque one-use link');return token;
}
const suffix=Date.now();
const password='Local-QA-Only-42-password';
const emails=['owner-a','owner-b','viewer'].map(name=>`${name}-${suffix}@example.test`);
const report={version:1,startedAt:new Date().toISOString(),assertions};
try {
  assert.equal((await fetch(api+'/health')).status,200);checked('API and PostgreSQL health');
  const sessions=[];
  for(const email of emails) {
    await request('/auth/email/signup',{email,password});
    await request('/auth/email/login',{email,password},undefined,401);
    await flushMail();const token=mailToken(email,'email-verification');
    await request('/auth/email/reset-password',{token,password},undefined,400);
    await request('/auth/email/verify-email',{token});
    await request('/auth/email/verify-email/',{token},undefined,400);
    const {sessionId}=await request('/auth/email/login',{email,password});assert(sessionId);sessions.push(sessionId);
  }
  checked('Three Wasp accounts: unverified rejected, SMTP worker delivered, purpose-bound verification and replay rejection');
  await operation('app-command',{type:'SUBMIT_FEEDBACK',category:'GENERAL',message:'无团队账号反馈'},sessions[2]);
  await operation('app-command',{type:'REQUEST_DELETION',scope:'ACCOUNT',reason:'本机验收申请，不执行实际删除'},sessions[2]);
  const solo=await operation('get-app-state',{},sessions[2]);assert.equal(solo.supportRequests.length,2);
  const otherSupport=await operation('get-app-state',{},sessions[1]);assert.equal(otherSupport.supportRequests.length,0);
  checked('No-organization feedback and account deletion request remain private and readable');
  const a=await operation('app-command',{type:'CREATE_ORGANIZATION',name:'本机验收团队 A',workspaceName:'A 客户研究'},sessions[0]);
  const b=await operation('app-command',{type:'CREATE_ORGANIZATION',name:'本机验收团队 B',workspaceName:'B 客户研究'},sessions[1]);
  const workspaceA=a.workspaceId,workspaceB=b.workspaceId;assert(workspaceA&&workspaceB);
  await operation('get-app-state',{workspaceId:workspaceB},sessions[0],403);
  checked('Organization/workspace creation and cross-organization access denied');
  const dataSource=await db.dataSource.create({data:{key:`qa-${suffix}`,name:'本机验收合成数据（非真实广告）',adapterVersion:'qa-1',status:'DISABLED'}});
  const ad=await db.ad.create({data:{dataSourceId:dataSource.id,sourceAdId:`qa-${suffix}`,sourceUrl:'https://www.facebook.com/ads/library/',body:'本机验收合成文案：咖啡与早餐。不是来源采集记录。',fieldProvenance:{qa:true},publisherPlatforms:[]}});
  const search=await operation('search-public-ads',{workspaceId:workspaceA,query:'本机验收合成'},sessions[0]);assert(search.ads.some(item=>item.id===ad.id));
  await operation('get-public-ad',{workspaceId:workspaceA,adId:ad.id},sessions[0]);
  await operation('app-command',{type:'SAVE_AD',workspaceId:workspaceA,adId:ad.id},sessions[0]);
  await operation('app-command',{type:'SAVE_AD',workspaceId:workspaceA,adId:ad.id},sessions[0]);
  let stateA=await operation('get-app-state',{workspaceId:workspaceA},sessions[0]);assert.equal(stateA.research.savedAds.length,1);
  await operation('app-command',{type:'SAVE_NOTE',workspaceId:workspaceA,savedAdId:stateA.research.savedAds[0].id,body:'A 团队私有笔记'},sessions[0]);
  stateA=await operation('get-app-state',{workspaceId:workspaceA},sessions[0]);
  await operation('app-command',{type:'SAVE_NOTE',workspaceId:workspaceA,savedAdId:stateA.research.savedAds[0].id,noteId:stateA.research.notes[0].id,body:'A 团队私有笔记已编辑'},sessions[0]);
  await operation('app-command',{type:'CREATE_FOLDER',workspaceId:workspaceA,name:'验收文件夹'},sessions[0]);
  stateA=await operation('get-app-state',{workspaceId:workspaceA},sessions[0]);assert.equal(stateA.research.notes.length,1);assert.equal(stateA.research.notes[0].body,'A 团队私有笔记已编辑');
  await operation('app-command',{type:'MOVE_SAVED_AD',workspaceId:workspaceA,savedAdId:stateA.research.savedAds[0].id,folderId:stateA.research.folders[0].id},sessions[0]);
  const moved=await operation('get-app-state',{workspaceId:workspaceA},sessions[0]);assert.equal(moved.research.savedAds[0].folderId,stateA.research.folders[0].id);
  const stateB=await operation('get-app-state',{workspaceId:workspaceB},sessions[1]);assert.equal(stateB.research.savedAds.length,0);assert.equal(stateB.research.notes.length,0);
  await operation('app-command',{type:'SAVE_NOTE',workspaceId:workspaceB,savedAdId:stateA.research.savedAds[0].id,body:'越权修改'},sessions[1],404);
  checked('Public search/detail and idempotent private save; cross-organization note denied');
  for(let index=0;index<2;index++) {
    const extra=await db.ad.create({data:{dataSourceId:dataSource.id,sourceAdId:`qa-page-${suffix}-${index}`,sourceUrl:'https://www.facebook.com/ads/library/',body:`本机分页验收合成文案 ${index+1}，不是来源采集记录。`,fieldProvenance:{qa:true},publisherPlatforms:[]}});
    await operation('app-command',{type:'SAVE_AD',workspaceId:workspaceA,adId:extra.id},sessions[0]);
  }
  await operation('app-command',{type:'SAVE_NOTE',workspaceId:workspaceA,savedAdId:stateA.research.savedAds[0].id,body:'同一收藏的第二条私有笔记'},sessions[0]);
  const firstResearch=await operation('get-research-page',{workspaceId:workspaceA,kind:'saved',limit:1},sessions[0]);
  assert.equal(firstResearch.total,3);assert(firstResearch.nextCursor);
  const secondResearch=await operation('get-research-page',{workspaceId:workspaceA,kind:'saved',limit:1,cursor:firstResearch.nextCursor},sessions[0]);
  assert(secondResearch.nextCursor);
  const thirdResearch=await operation('get-research-page',{workspaceId:workspaceA,kind:'saved',limit:1,cursor:secondResearch.nextCursor},sessions[0]);
  assert.equal(thirdResearch.nextCursor,null);
  const researchRows=[...firstResearch.savedAds,...secondResearch.savedAds,...thirdResearch.savedAds];
  assert.equal(new Set(researchRows.map(row=>row.id)).size,3);
  assert.equal(researchRows.find(row=>row.adId===ad.id).notes.length,2);
  const folderPage=await operation('get-research-page',{workspaceId:workspaceA,kind:'saved',folderId:stateA.research.folders[0].id},sessions[0]);
  assert.equal(folderPage.total,1);assert.equal(folderPage.savedAds[0].adId,ad.id);
  await operation('get-research-page',{workspaceId:workspaceB,kind:'saved'},sessions[0],403);
  await operation('get-research-page',{workspaceId:workspaceB,kind:'saved',cursor:firstResearch.nextCursor},sessions[1],400);
  const emptyAnalyses=await operation('get-research-page',{workspaceId:workspaceA,kind:'analysis'},sessions[0]);assert.equal(emptyAnalyses.total,0);
  checked('Research pagination has no duplicates, includes all notes, filters folders and denies cross-organization access/cursor reuse');
  await operation('app-command',{type:'INVITE_MEMBER',workspaceId:workspaceA,email:emails[2],role:'VIEWER'},sessions[0]);await flushMail();
  await operation('app-command',{type:'ACCEPT_INVITATION',token:mailToken(emails[2],'/app/settings')},sessions[2]);
  const viewerState=await operation('get-app-state',{workspaceId:workspaceA},sessions[2]);assert.equal(viewerState.role,'VIEWER');
  await operation('app-command',{type:'SAVE_AD',workspaceId:workspaceA,adId:ad.id},sessions[2],403);
  await operation('get-app-state',{workspaceId:workspaceB},sessions[2],403);
  checked('SMTP invitation acceptance, viewer read allowed and write denied');
  await operation('app-command',{type:'ANALYZE_AD',workspaceId:workspaceA,adId:ad.id,idempotencyKey:`qa-${suffix}`},sessions[0],503);
  assert.equal(await db.usageLedger.count({where:{organizationId:stateA.organizations[0].id}}),0);
  await operation('app-command',{type:'SUBMIT_FEEDBACK',workspaceId:workspaceA,category:'BUG',message:'本机验收反馈'},sessions[0]);
  checked('Unconfigured analysis fails without charging; feedback persists');
  const user=await db.user.findUniqueOrThrow({where:{email:emails[2]}});
  const qaAdmin=await db.user.findUniqueOrThrow({where:{email:emails[0]}});
  // This isolated fixture becomes an admin; production grants use admin.sh after identity verification.
  await db.user.update({where:{id:qaAdmin.id},data:{isAdmin:true}});
  const firstAccounts=await operation('get-admin-page',{kind:'users',limit:2},sessions[0]);assert(firstAccounts.nextCursor);
  const nextAccounts=await operation('get-admin-page',{kind:'users',limit:2,cursor:firstAccounts.nextCursor},sessions[0]);
  assert(!nextAccounts.users.some(row=>firstAccounts.users.some(prior=>prior.id===row.id)));
  assert.deepEqual(Object.keys(firstAccounts.users[0]).sort(),['disabledAt','email','id','isAdmin'].sort());
  await operation('get-admin-page',{kind:'users'},sessions[2],403);
  await operation('get-admin-page',{kind:'customers',cursor:firstAccounts.nextCursor},sessions[0],400);
  for(const kind of ['customers','tasks','runs','organizationFeedback','accountSupport','mediaFailures']) {
    const page=await operation('get-admin-page',{kind,limit:2},sessions[0]);assert.equal(page.kind,kind);
  }
  checked('Platform pagination is reachable for all operational categories, returns allowlisted fields and rejects ordinary users/cross-category cursors');
  await operation('app-command',{type:'SET_DATA_SOURCE_STATUS',dataSourceId:dataSource.id,status:'ACTIVE'},sessions[0],409);
  await operation('app-command',{type:'CREATE_COLLECTION_TASK',dataSourceId:dataSource.id,name:'未验证范围验收',query:'coffee',country:'US',mediaType:'ALL',intervalMinutes:null},sessions[0]);
  const qaTask=await db.collectionTask.findFirstOrThrow({where:{dataSourceId:dataSource.id}});assert.equal(qaTask.maxItems,3);
  await operation('app-command',{type:'SET_TASK_STATUS',taskId:qaTask.id,status:'ACTIVE'},sessions[0],409);
  await operation('app-command',{type:'SET_DATA_SOURCE_STATUS',dataSourceId:dataSource.id,status:'PAUSED'},sessions[2],403);
  checked('Admin source/task activation is blocked without verified capabilities');
  await operation('app-command',{type:'SET_ACCOUNT_STATUS',targetUserId:user.id,disabled:true,reason:'本机停用回归'},sessions[0]);
  await operation('get-app-state',{workspaceId:workspaceA},sessions[2],401);
  checked('Disabled account rejected on next protected request');
  await request('/auth/email/request-password-reset',{email:emails[1]});await flushMail();
  const resetToken=mailToken(emails[1],'password-reset');
  await request('/auth/email/reset-password',{token:resetToken,password:password+'2'});
  await operation('get-app-state',{},sessions[1],401);
  await request('/auth/email/RESET-PASSWORD/',{token:resetToken,password:password+'3'},undefined,400);
  await request('/auth/email/login',{email:emails[1],password},undefined,401);
  await request('/auth/email/login',{email:emails[1],password:password+'2'});
  checked('Password reset invalidates sessions and rejects replay including route variants');
  await request('/auth/logout',{},sessions[0]);await operation('get-app-state',{},sessions[0],401);checked('Logout invalidates Wasp session');
  const preview={email:emails[0],password,workspaceId:workspaceA,adId:ad.id};
  await mkdir(resolve(base,'.local'),{recursive:true,mode:0o700});
  await writeFile(resolve(base,'.local/qa-preview.json'),JSON.stringify(preview,null,2),{mode:0o600});
  Object.assign(report,{finishedAt:new Date().toISOString(),status:'PASSED',localSmtpMessages:inbox.length,externalProvidersUsed:false});
  await mkdir(resolve(base,'.artifacts'),{recursive:true});await writeFile(resolve(base,'.artifacts/http-smoke.json'),JSON.stringify(report,null,2));
  console.log(`Passed ${assertions.length} HTTP integration groups; no real email, Stripe or AI call.`);
} finally {
  for(const socket of sockets)socket.destroy();await new Promise(resolve=>smtp.close(resolve));await db.$disconnect();
}
