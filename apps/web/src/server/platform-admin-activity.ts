import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { DomainError, lockAccountAdministration, requirePlatformAdmin } from '../team/access';
import { parseGrowthRange } from '../growth/summary';
import type { Locale } from '../client/landing/messages';
import { translateAdminCopy } from '../client/platform-admin/admin-copy-core';
import { activityCopy } from '../client/platform-admin/activity-copy';
import { activityValue } from '../client/platform-admin/activity-view';

export type ActivityTab = 'visits' | 'product' | 'usage' | 'feedback' | 'requests' | 'audit' | 'email';
export type ActivityFilters = { from?: string; to?: string; allDates?: boolean; search?: string; status?: string; category?: string; organizationId?: string; actorUserId?: string; action?: string; eventName?: string; templateKey?: string; channel?: 'source' | 'medium' | 'campaign' };
export type ActivityQuery = { tab: ActivityTab; filters?: ActivityFilters; cursor?: string; detailId?: string; locale?: Locale };
export type ActivityScalar = string | number | boolean | null;
export type ActivityRow = { id: string; createdAt: string; cells: Record<string, ActivityScalar>; metadata?: Record<string, unknown>; canRetry?: boolean; retryReason?: string };
export type ActivityView = { tab: ActivityTab; rows: ActivityRow[]; total: number; nextCursor: string | null; asOf: string; metrics: Array<{ key: string; label: string; value: number | null; note?: string }>; daily: Array<Record<string, string | number | null>>; distribution: Array<{ label: string; value: number }>; secondaryDistribution?: Array<{ label: string; value: number }>; pending?: { feedback: number; requests: number }; readiness?: { configured: boolean; note: string }; caveats: string[] };
export type ActivityCommand = { command: 'resolve-feedback' | 'resolve-request' | 'retry-email'; id: string; reason: string; identityVerified?: boolean; expectedStatus: string };
export const activityColumns: Record<ActivityTab, Array<{ key: string; label: string }>> = {
  visits: [['createdAt','首次访问'],['lastSeenAt','最近活动'],['landingPath','落地路径'],['source','来源'],['medium','媒介'],['campaign','活动'],['referrerOrigin','引荐来源'],['consentVersion','同意版本'],['conversions','转化'],['isTest','测试']].map(([key,label])=>({key,label})),
  product: [['createdAt','时间'],['name','事件名'],['organization','组织'],['workspace','工作区'],['sourceAdId','来源广告 ID']].map(([key,label])=>({key,label})),
  usage: [['createdAt','时间'],['organization','组织'],['key','权益项'],['quantity','数量'],['status','状态'],['releaseReason','释放原因'],['idempotencyKey','幂等键（前 8 位）']].map(([key,label])=>({key,label})),
  feedback: [['createdAt','提交时间'],['category','类别'],['subject','主题'],['organization','组织'],['workspace','工作区'],['requester','提交人'],['email','邮箱'],['status','状态']].map(([key,label])=>({key,label})),
  requests: [['createdAt','提交时间'],['kind','类型'],['requester','申请人'],['email','邮箱'],['body','摘要'],['status','状态'],['resolvedAt','处理时间']].map(([key,label])=>({key,label})),
  audit: [['createdAt','时间'],['action','动作'],['targetType','对象'],['targetId','对象标识'],['actor','操作者'],['email','邮箱'],['summary','摘要']].map(([key,label])=>({key,label})),
  email: [['createdAt','创建时间'],['recipientEmail','收件人'],['templateKey','模板'],['status','状态'],['attempts','尝试'],['sentAt','发送时间'],['lastErrorCode','错误']].map(([key,label])=>({key,label})),
};
export const activityCaveats: Record<ActivityTab, string[]> = {
  visits: ['仅统计已获统计同意的访问；拒绝统计的访问不计入，因此这里不是全部流量。isTest 标记的访问单列，不混入业务数据。', '拒绝统计的访问总数未采集，已同意统计的访问占比无法计算。注册转化率为该访问队列中已注册的非测试访问数 / 非测试访问数。', '每日注册按注册事件发生日计数；KPI 与转化率按访问队列归因统计。'],
  product: ['按组织计数。事件记录的是本产品内的操作次数，不是广告的点击量或曝光量。', '人均事件数仅以记录中有用户标识的活跃用户为分母；匿名事件不计入该比值。'],
  usage: ['预占尚未结算不代表已完成分析；释放包括失败释放与取消释放，两者在「释放原因」列区分。', '本周期预占为当前有效权益周期内已产生的预占数量（含已结算与已释放）；释放率 = 已释放 / 本周期预占。每日图按预占发生日显示当前状态。'],
  feedback: ['「已处理」是支持记录状态，不代表已执行数据删除或系统变更。'],
  requests: ['「已处理」是支持记录状态，不代表已执行数据删除或系统变更。', '提交申请不会自动删除资料；需人员核验身份，权限及需保留的记录另行处理。'],
  audit: ['审计记录的是平台管理操作。客户在自己工作区内的操作不在此列。'],
  email: ['邮件正文与其中的链接不可在后台查看；邮件链接与 token 不入日志、不在后台展示、不在导出中出现。', '成功指服务商已接收，不代表收件人已收到或已打开。本产品不采集打开与点击。', '邮件记录有保留期，清理后的记录不再显示。失败不等于收件人没收到；服务商回执之后的投递结果不在本产品掌握范围。'],
};
const filtersSchema = z.object({ from: z.string().optional(), to: z.string().optional(), allDates:z.boolean().optional(), search: z.string().max(200).optional(), status: z.string().max(80).optional(), category: z.string().max(80).optional(), organizationId: z.uuid().optional(), actorUserId: z.uuid().optional(), action: z.string().max(100).optional(), eventName: z.string().max(80).optional(), templateKey: z.string().max(100).optional(), channel: z.enum(['source','medium','campaign']).optional() }).strict();
const querySchema = z.object({ tab: z.enum(['visits','product','usage','feedback','requests','audit','email']), filters: filtersSchema.default({}), cursor: z.string().max(2048).optional(), detailId: z.uuid().optional(), locale:z.enum(['zh-CN','zh-TW','en','es']).optional() }).strict();
const cursorSchema = z.object({ scope: z.string(), asOf: z.iso.datetime(), at: z.iso.datetime(), id: z.uuid() }).strict();
const platformActions = ['PLATFORM_ADMIN_GRANTED','PLATFORM_ADMIN_REVOKED','ACCOUNT_DISABLED','ACCOUNT_ENABLED','USER_DISABLED','USER_ENABLED','USER_RESTORED','ENTITLEMENT_ADJUSTED','PLAN_VERSION_IMPORTED','PLAN_VERSION_ACTIVATED','PLAN_PRICE_VERIFIED','PLAN_PUBLICATION_CONFIRMED','PLAN_PUBLICATION_WITHDRAWN','SOURCE_STATUS_CHANGED','COLLECTION_TASK_CREATED','COLLECTION_TASK_STATUS','COLLECTION_TASK_AUTO_PAUSED','COLLECTION_ENQUEUE_REQUEST','COLLECTION_CANCEL_REQUEST','MEDIA_REQUEUED','ACCOUNT_SUPPORT_RESOLVED','FEEDBACK_RESOLVED','EMAIL_RETRY_REQUESTED','SHOWCASE_APPROVED','SHOWCASE_REJECTED','SHOWCASE_UNPUBLISHED','SHOWCASE_CURATED'];
const fromJoin: Record<ActivityTab, Prisma.Sql> = {
  visits: Prisma.sql`FROM "GrowthVisit" t`,
  product: Prisma.sql`FROM "ProductEvent" t JOIN "Organization" o ON o.id=t."organizationId" JOIN "Workspace" w ON w.id=t."workspaceId" LEFT JOIN "Ad" ad ON ad.id=t."adId"`,
  usage: Prisma.sql`FROM "UsageLedger" t JOIN "Organization" o ON o.id=t."organizationId" JOIN "Entitlement" e ON e.id=t."entitlementId"`,
  feedback: Prisma.sql`FROM "Feedback" t JOIN "Organization" o ON o.id=t."organizationId" LEFT JOIN "Workspace" w ON w.id=t."workspaceId" LEFT JOIN "User" u ON u.id=t."userId"`,
  requests: Prisma.sql`FROM "AccountSupportRequest" t JOIN "User" u ON u.id=t."userId"`,
  audit: Prisma.sql`FROM "AuditEvent" t LEFT JOIN "User" u ON u.id=t."actorUserId"`,
  email: Prisma.sql`FROM "EmailDelivery" t LEFT JOIN "Organization" o ON o.id=t."organizationId" LEFT JOIN "User" u ON u.id=t."userId"`,
};
const emailEffectiveStatus = Prisma.sql`CASE WHEN t."expiresAt"<=(clock_timestamp() AT TIME ZONE 'UTC') OR t."payloadExpiresAt"<=(clock_timestamp() AT TIME ZONE 'UTC') AND t.status<>'SENT' THEN 'EXPIRED' ELSE t.status END`;
const projections: Record<ActivityTab, Prisma.Sql> = {
  visits: Prisma.sql`t.id,t."createdAt",t."lastSeenAt",t."landingPath",t.source,t.medium,t.campaign,t."referrerOrigin",t."consentVersion",t."isTest",(SELECT COUNT(*)::int FROM "ConversionEvent" c WHERE c."visitId"=t.id) AS conversions`,
  product: Prisma.sql`t.id,t."createdAt",t.name,o.name AS organization,w.name AS workspace,ad."sourceAdId"`,
  usage: Prisma.sql`t.id,t."createdAt",o.name AS organization,e.key,t.quantity,t.status,t."releaseReason",LEFT(t."idempotencyKey", 8) AS "idempotencyKey"`,
  feedback: Prisma.sql`t.id,t."createdAt",t."resolvedAt",t.category,t.subject,t.body,t.status,o.name AS organization,w.name AS workspace,COALESCE(u."displayName",u.email,'未提供') AS requester,u.email,(SELECT jsonb_build_object('处理时间',to_char(a."createdAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'处理说明',a.metadata->>'reason','身份核验',a.metadata->'identityVerified') FROM "AuditEvent" a WHERE a.action='FEEDBACK_RESOLVED' AND a."targetId"=t.id ORDER BY a."createdAt" DESC LIMIT 1) AS metadata`,
  requests: Prisma.sql`t.id,t."createdAt",t."resolvedAt",t.kind,t.body,t.status,COALESCE(u."displayName",u.email,'未提供') AS requester,u.email,(SELECT jsonb_build_object('处理时间',to_char(a."createdAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'处理说明',a.metadata->>'reason','身份核验',a.metadata->'identityVerified') FROM "AuditEvent" a WHERE a.action='ACCOUNT_SUPPORT_RESOLVED' AND a."targetId"=t.id ORDER BY a."createdAt" DESC LIMIT 1) AS metadata`,
  audit: Prisma.sql`t.id,t."createdAt",t.action,t."targetType",t."targetId",COALESCE(u."displayName",u.email,'系统') AS actor,u.email,t.metadata`,
  email: Prisma.sql`t.id,t."createdAt",t."updatedAt",t."recipientEmail",t."templateKey",${emailEffectiveStatus} AS status,t.attempts,t."sentAt",t."lastErrorCode",t.provider,t."providerMessageId",o.name AS organization,COALESCE(u."displayName",u.email) AS username,t."nextAttemptAt",t."payloadExpiresAt",t."expiresAt",t."leaseExpiresAt",(t."leaseExpiresAt">(clock_timestamp() AT TIME ZONE 'UTC')) AS leased,(t."encryptedPayload" IS NOT NULL AND t."encryptionKeyVersion"='v1') AS "payloadAvailable",t.metadata`,
};
export function redactAdminMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => !/token|password|secret|authorization|cookie|payload|body|api.?key|signature|signed|credential|dedupe|url|link/i.test(key)).map(([key,child])=>[key,clean(child)]));
    if (typeof item === 'string') return /https?:\/\/|Bearer\s|(?:sk|rk)_(?:live|test)_|[?&](?:sig|token|key)=/i.test(item) ? '[已脱敏]' : item;
    return item;
  };
  return clean(value) as Record<string, unknown>;
}
export function emailRetryEligibility(row: { status: string; attempts: number; payloadAvailable: boolean; payloadExpiresAt: string | null; expiresAt: string | null; leaseExpiresAt: string | null }, now = new Date()) {
  const reason = row.status !== 'FAILED' ? '仅失败记录可重试' : row.attempts >= 3 ? '已达到最大尝试次数（3 次）' : !row.payloadAvailable ? '安全载荷已清理，无法重试' : !row.payloadExpiresAt || Date.parse(row.payloadExpiresAt) <= now.getTime() ? '安全载荷已过期' : row.expiresAt && Date.parse(row.expiresAt) <= now.getTime() ? '记录已过期' : row.leaseExpiresAt && Date.parse(row.leaseExpiresAt) > now.getTime() ? '投递租约仍被占用' : '';
  return { eligible: !reason, reason };
}
function utcTimestamp(value: Date) { return Prisma.sql`${value.toISOString()}::timestamp`; }
export function activitySql(tab: ActivityTab, filters: ActivityFilters, asOf: Date) {
  const clauses = [Prisma.sql`t."createdAt"<=${utcTimestamp(asOf)}`];
  if (!filters.allDates && filters.from && filters.to) { const range = parseGrowthRange({ from:filters.from,to:filters.to }); clauses.push(Prisma.sql`t."createdAt">=${utcTimestamp(range.start)} AND t."createdAt"<${utcTimestamp(range.end)}`); }
  if (filters.organizationId && !['visits','requests'].includes(tab)) clauses.push(Prisma.sql`t."organizationId"=${filters.organizationId}`);
  if (filters.status && ['usage','feedback','requests','email'].includes(tab)) clauses.push(tab==='email' ? Prisma.sql`${emailEffectiveStatus}=${filters.status}` : Prisma.sql`t.status=${filters.status}`);
  if (filters.category && tab==='feedback') clauses.push(Prisma.sql`t.category=${filters.category}`);
  if (filters.category && tab==='requests') clauses.push(Prisma.sql`t.kind=${filters.category}`);
  if (filters.eventName && tab==='product') clauses.push(Prisma.sql`t.name=${filters.eventName}`);
  if (filters.templateKey && tab==='email') clauses.push(Prisma.sql`t."templateKey"=${filters.templateKey}`);
  if (tab==='audit') {
    clauses.push(Prisma.sql`t."workspaceId" IS NULL AND (t.action IN (${Prisma.join(platformActions)}) OR t.action LIKE 'PLATFORM_ADMIN_%')`);
    if (filters.actorUserId) clauses.push(Prisma.sql`t."actorUserId"=${filters.actorUserId}`);
    if (filters.action) clauses.push(Prisma.sql`t.action=${filters.action}`);
  }
  if (tab==='usage') clauses.push(Prisma.sql`e.key='ANALYSES' AND e."validFrom"<=${utcTimestamp(asOf)} AND (e."validUntil" IS NULL OR e."validUntil">${utcTimestamp(asOf)}) AND t."reservedAt">=e."periodStart" AND (e."periodEnd" IS NULL OR t."reservedAt"<e."periodEnd") AND NOT EXISTS(SELECT 1 FROM "Entitlement" newer WHERE newer."organizationId"=e."organizationId" AND newer.key=e.key AND newer."validFrom"<=${utcTimestamp(asOf)} AND (newer."validUntil" IS NULL OR newer."validUntil">${utcTimestamp(asOf)}) AND newer."periodStart">e."periodStart")`);
  if (filters.search) {
    const search = `%${filters.search.replace(/[\\%_]/g,'\\$&')}%`;
    if(tab==='feedback') clauses.push(Prisma.sql`(t.subject ILIKE ${search} OR t.body ILIKE ${search})`);
    if(tab==='requests') clauses.push(Prisma.sql`(t.body ILIKE ${search} OR u.email ILIKE ${search})`);
    if(tab==='email') clauses.push(Prisma.sql`t."recipientEmail" ILIKE ${search}`);
    if(tab==='audit') clauses.push(Prisma.sql`t."targetId" ILIKE ${search}`);
  }
  return { projection: projections[tab], from: fromJoin[tab], where: Prisma.sql`WHERE ${Prisma.join(clauses,' AND ')}` };
}
function localDay(value: Date) { return new Date(value.getTime()+8*3600000).toISOString().slice(0,10); }
function normalize(input: ActivityQuery) {
  const parsed=querySchema.safeParse(input); if(!parsed.success)throw new DomainError(400,'INVALID_ADMIN_ACTIVITY_QUERY');
  const filters=parsed.data.filters;
  if(filters.allDates&&!['feedback','requests','email'].includes(parsed.data.tab))throw new DomainError(400,'ADMIN_ALL_DATES_UNSUPPORTED');
  if(Boolean(filters.from)!==Boolean(filters.to))throw new DomainError(400,'INVALID_ADMIN_ACTIVITY_RANGE');
  if(!filters.from){ filters.from=localDay(new Date(Date.now()-6*86400000)); filters.to=localDay(new Date()); }
  parseGrowthRange({from:filters.from,to:filters.to});
  return {...parsed.data,filters};
}
function rowView(tab: ActivityTab, row: Record<string, unknown>, now: Date): ActivityRow {
  const cells: ActivityRow['cells']={};
  for(const [key,value] of Object.entries(row)) if(!['id','metadata','payloadAvailable','leaseExpiresAt'].includes(key))cells[key]=value instanceof Date?value.toISOString():typeof value==='bigint'?Number(value):['string','number','boolean'].includes(typeof value)?value as ActivityScalar:null;
  const result: ActivityRow={id:String(row.id),createdAt:cells.createdAt as string,cells};
  if(tab==='feedback'||tab==='requests')result.metadata=redactAdminMetadata(row.metadata);
  if(tab==='audit'){result.metadata=redactAdminMetadata(row.metadata); cells.summary=JSON.stringify(result.metadata);}
  if(tab==='email'){
    const metadata=row.metadata as Record<string,unknown>|null;
    result.metadata=redactAdminMetadata(Object.fromEntries(['locale','templateVersion','notificationKind'].filter(key=>metadata&&typeof metadata[key]==='string').map(key=>[key,metadata![key]])));
    const retry=emailRetryEligibility({status:cells.status as string,attempts:cells.attempts as number,payloadAvailable:row.payloadAvailable===true,payloadExpiresAt:cells.payloadExpiresAt as string|null,expiresAt:cells.expiresAt as string|null,leaseExpiresAt:row.leaseExpiresAt instanceof Date?row.leaseExpiresAt.toISOString():null},now);
    result.canRetry=retry.eligible;result.retryReason=retry.reason;
  }
  return result;
}
function metric(key:string,label:string,value:number|null,note?:string){return {key,label,value,...(note?{note}:{})};}
type SqlRow=Record<string,unknown>;
function n(value:unknown){return Number(value??0);}
function readiness(){const configured=['SMTP_HOST','SMTP_USERNAME','SMTP_PASSWORD','EMAIL_FROM','OUTBOX_ENCRYPTION_KEY'].every(key=>Boolean(process.env[key]?.trim()));return {configured,note:configured?'已配置邮件投递；成功仅指服务商已接收':'邮件服务尚未配置'};}
async function summary(tx: Prisma.TransactionClient, tab:ActivityTab, filters:ActivityFilters, asOf:Date):Promise<Pick<ActivityView,'metrics'|'daily'|'distribution'|'secondaryDistribution'>>{
  const sql=activitySql(tab,filters,asOf);
  const day=Prisma.sql`to_char(t."createdAt"+INTERVAL '8 hours','YYYY-MM-DD')`;
  const query=(selection:Prisma.Sql,suffix=Prisma.empty)=>tx.$queryRaw<SqlRow[]>(Prisma.sql`SELECT ${selection} ${sql.from} ${sql.where} ${suffix}`);
  let metrics:ActivityView['metrics']=[];
  let daily:ActivityView['daily']=[],distribution:ActivityView['distribution']=[],secondaryDistribution:ActivityView['distribution']=[];
  if(tab==='visits'){
    const [a]=await query(Prisma.sql`COUNT(*) FILTER(WHERE NOT t."isTest") AS visits,COUNT(*) FILTER(WHERE t."isTest") AS tests,COUNT(*) AS recorded,COUNT(*) FILTER(WHERE NOT t."isTest" AND EXISTS(SELECT 1 FROM "ConversionEvent" c WHERE c."visitId"=t.id AND c.name='ACCOUNT_CREATED' AND c."createdAt"<=${utcTimestamp(asOf)})) AS "registeredVisits",(SELECT COUNT(DISTINCT c."userId") FROM "ConversionEvent" c WHERE c."visitId" IN(SELECT t.id ${sql.from} ${sql.where} AND NOT t."isTest") AND c.name='ACCOUNT_CREATED' AND c."createdAt"<=${utcTimestamp(asOf)}) AS registrations`);
    metrics=[metric('visits','访问数',n(a.visits)),metric('registrations','新注册',n(a.registrations)),metric('registrationRate','注册转化率',n(a.visits)?n(a.registeredVisits)/n(a.visits)*100:null),metric('consentRate','已同意统计的访问占比',null,'拒绝统计的访问总数未采集，无法计算'),metric('testRate','测试流量占比',n(a.recorded)?n(a.tests)/n(a.recorded)*100:null,'仅以已记录访问为分母')];
    daily=(await query(Prisma.sql`${day} AS day,COUNT(*) FILTER(WHERE NOT t."isTest")::int AS visits`,Prisma.sql`GROUP BY day ORDER BY day`)).map(r=>({day:String(r.day),visits:n(r.visits),registrations:0}));
    const registrations=await tx.$queryRaw<SqlRow[]>(Prisma.sql`SELECT to_char(c."createdAt"+INTERVAL '8 hours','YYYY-MM-DD') AS day,COUNT(DISTINCT c."userId")::int AS registrations FROM "ConversionEvent" c JOIN "GrowthVisit" t ON t.id=c."visitId" ${sql.where} AND c.name='ACCOUNT_CREATED' AND NOT t."isTest" AND c."createdAt"<=${utcTimestamp(asOf)} AND c."createdAt">=${utcTimestamp(parseGrowthRange({from:filters.from!,to:filters.to!}).start)} AND c."createdAt"<${utcTimestamp(parseGrowthRange({from:filters.from!,to:filters.to!}).end)} GROUP BY day ORDER BY day`);
    for(const row of registrations){let d=daily.find(d=>d.day===row.day);if(!d){d={day:String(row.day),visits:0,registrations:0};daily.push(d);}d.registrations=n(row.registrations);}daily.sort((a,b)=>String(a.day).localeCompare(String(b.day)));
    distribution=(await query(Prisma.sql`t."landingPath" AS label,COUNT(*)::int AS value`,Prisma.sql`AND NOT t."isTest" GROUP BY t."landingPath" ORDER BY value DESC,label`)).map(r=>({label:String(r.label),value:n(r.value)}));
    const channel=filters.channel==='medium'?Prisma.sql`t.medium`:filters.channel==='campaign'?Prisma.sql`t.campaign`:Prisma.sql`t.source`;
    secondaryDistribution=(await query(Prisma.sql`COALESCE(${channel},'直接 / 未归因') AS label,COUNT(*)::int AS value`,Prisma.sql`AND NOT t."isTest" GROUP BY ${channel} ORDER BY value DESC,label`)).map(r=>({label:String(r.label),value:n(r.value)}));
  }else if(tab==='product'){
    const[a]=await query(Prisma.sql`COUNT(*) AS events,COUNT(DISTINCT t."organizationId") AS organizations,COUNT(DISTINCT t."workspaceId") AS workspaces,COUNT(DISTINCT t."userId") AS users,COUNT(*) FILTER(WHERE t."userId" IS NOT NULL) AS identified`);
    metrics=[metric('events','事件总数',n(a.events)),metric('organizations','活跃组织数',n(a.organizations)),metric('workspaces','活跃工作区数',n(a.workspaces)),metric('perUser','人均事件数',n(a.users)?n(a.identified)/n(a.users):null)];
    daily=(await query(Prisma.sql`${day} AS day,COUNT(*)::int AS events`,Prisma.sql`GROUP BY day ORDER BY day`)).map(r=>({day:String(r.day),events:n(r.events)}));
    distribution=(await query(Prisma.sql`t.name AS label,COUNT(*)::int AS value`,Prisma.sql`GROUP BY t.name ORDER BY value DESC,label`)).map(r=>({label:String(r.label),value:n(r.value)}));
  }else if(tab==='usage'){
    const[a]=await query(Prisma.sql`COALESCE(SUM(t.quantity),0) AS allocated,COALESCE(SUM(t.quantity) FILTER(WHERE t.status='SETTLED'),0) AS settled,COALESCE(SUM(t.quantity) FILTER(WHERE t.status='RELEASED'),0) AS released`);
    metrics=[metric('allocated','本周期预占',n(a.allocated)),metric('settled','已结算',n(a.settled)),metric('released','已释放',n(a.released)),metric('releaseRate','释放率',n(a.allocated)?n(a.released)/n(a.allocated)*100:null)];
    daily=(await query(Prisma.sql`${day} AS day,COALESCE(SUM(t.quantity) FILTER(WHERE t.status='SETTLED'),0)::int AS settled,COALESCE(SUM(t.quantity) FILTER(WHERE t.status='RESERVED'),0)::int AS reserved,COALESCE(SUM(t.quantity) FILTER(WHERE t.status='RELEASED'),0)::int AS released`,Prisma.sql`GROUP BY day ORDER BY day`)).map(r=>({day:String(r.day),settled:n(r.settled),reserved:n(r.reserved),released:n(r.released)}));
  }else if(tab==='feedback'||tab==='requests'){
    const[a]=await query(Prisma.sql`COUNT(*) AS submitted,COUNT(*) FILTER(WHERE t.status='OPEN') AS pending,COUNT(*) FILTER(WHERE t.status='RESOLVED') AS resolved`);
    metrics=[metric('submitted','提交总数',n(a.submitted)),metric('pending','待处理',n(a.pending)),metric('resolved','已处理',n(a.resolved))];
    const chartSql=activitySql(tab,{...filters,status:undefined},asOf);
    const rows=await tx.$queryRaw<SqlRow[]>(Prisma.sql`SELECT ${day} AS day,COUNT(*)::int AS added ${chartSql.from} ${chartSql.where} GROUP BY day ORDER BY day`);
    daily=rows.map(r=>({day:String(r.day),added:n(r.added),resolved:0}));
    const range=parseGrowthRange({from:filters.from!,to:filters.to!});
    const resolvedSql=activitySql(tab,{...filters,status:undefined,from:undefined,to:undefined},asOf);
    const resolvedRange=filters.allDates?Prisma.sql`t."resolvedAt" IS NOT NULL`:Prisma.sql`t."resolvedAt">=${utcTimestamp(range.start)} AND t."resolvedAt"<${utcTimestamp(range.end)}`;
    const resolved=await tx.$queryRaw<SqlRow[]>(Prisma.sql`SELECT to_char(t."resolvedAt"+INTERVAL '8 hours','YYYY-MM-DD') AS day,COUNT(*)::int AS resolved ${resolvedSql.from} ${resolvedSql.where} AND ${resolvedRange} GROUP BY day ORDER BY day`);
    for(const r of resolved){let d=daily.find(v=>v.day===r.day);if(!d){d={day:String(r.day),added:0,resolved:0};daily.push(d);}d.resolved=n(r.resolved);}daily.sort((a,b)=>String(a.day).localeCompare(String(b.day)));
  }else if(tab==='email'){
    const[a]=await query(Prisma.sql`COUNT(*) AS total,COUNT(*) FILTER(WHERE t.status='SENT' AND (t."expiresAt" IS NULL OR t."expiresAt">${utcTimestamp(asOf)})) AS sent,COUNT(*) FILTER(WHERE t.status IN('FAILED','UNKNOWN','EXPIRED') OR t."expiresAt"<=${utcTimestamp(asOf)} OR t."payloadExpiresAt"<=${utcTimestamp(asOf)} AND t.status<>'SENT') AS failed,COUNT(*) FILTER(WHERE t.status IN('QUEUED','SENDING') AND (t."expiresAt" IS NULL OR t."expiresAt">${utcTimestamp(asOf)}) AND (t."payloadExpiresAt" IS NULL OR t."payloadExpiresAt">${utcTimestamp(asOf)})) AS retrying`);
    metrics=[metric('total','周期内发送总数',n(a.total)),metric('sent','成功',n(a.sent)),metric('failed','失败 / 结果未知 / 已过期',n(a.failed)),metric('retrying','重试中 / 排队',n(a.retrying)),metric('successRate','成功率',n(a.total)?n(a.sent)/n(a.total)*100:null)];
    secondaryDistribution=[{label:'成功',value:n(a.sent)},{label:'失败 / 未知 / 过期',value:n(a.failed)},{label:'重试中 / 排队',value:n(a.retrying)}];
    daily=(await query(Prisma.sql`${day} AS day,COUNT(*)::int AS deliveries`,Prisma.sql`GROUP BY day ORDER BY day`)).map(r=>({day:String(r.day),deliveries:n(r.deliveries)}));
    distribution=(await query(Prisma.sql`t."templateKey" AS label,COUNT(*)::int AS value`,Prisma.sql`GROUP BY t."templateKey" ORDER BY value DESC,label`)).map(r=>({label:String(r.label),value:n(r.value)}));
  }
  if(daily.length&&!filters.allDates&&filters.from&&filters.to){
    const range=parseGrowthRange({from:filters.from,to:filters.to});const keys=Object.keys(daily[0]).filter(key=>key!=='day');
    const present=new Map(daily.map(row=>[row.day,row]));
    daily=Array.from({length:range.days},(_,index)=>{const day=localDay(new Date(range.start.getTime()+index*86400000));return present.get(day)??{day,...Object.fromEntries(keys.map(key=>[key,0]))};});
  }
  const top=(rows:ActivityView['distribution'])=>rows.length<=8?rows:[...rows.slice(0,7),{label:'其他',value:rows.slice(7).reduce((sum,r)=>sum+r.value,0)}];
  return {metrics,daily,distribution:tab==='visits'?top(distribution):distribution,secondaryDistribution};
}
export async function getPlatformAdminActivity(db:PrismaClient,input:ActivityQuery&{userId:string}):Promise<ActivityView>{
  const{userId,...request}=input;const parsed=normalize(request);
  return db.$transaction(async tx=>{
    await requirePlatformAdmin(tx,userId);
    const scope=createHash('sha256').update(JSON.stringify({userId,tab:parsed.tab,filters:parsed.filters})).digest('hex');
    let cursor:z.infer<typeof cursorSchema>|null=null;
    if(parsed.cursor)try{cursor=cursorSchema.parse(JSON.parse(Buffer.from(parsed.cursor,'base64url').toString('utf8')));if(cursor.scope!==scope||Date.parse(cursor.asOf)>Date.now()||Date.parse(cursor.at)>Date.parse(cursor.asOf))throw Error();}catch{throw new DomainError(400,'INVALID_ADMIN_CURSOR');}
    const now=cursor?new Date(cursor.asOf):new Date();
    const sql=activitySql(parsed.tab,parsed.filters,now);
    const boundary=parsed.detailId?Prisma.sql`AND t.id=${parsed.detailId}`:cursor?Prisma.sql`AND (t."createdAt"<${utcTimestamp(new Date(cursor.at))} OR t."createdAt"=${utcTimestamp(new Date(cursor.at))} AND t.id<${cursor.id})`:Prisma.empty;
    const result=await tx.$queryRaw<SqlRow[]>(Prisma.sql`SELECT ${sql.projection} ${sql.from} ${sql.where} ${boundary} ORDER BY t."createdAt" DESC,t.id DESC LIMIT 21`);
    const[count]=await tx.$queryRaw<Array<{total:bigint}>>(Prisma.sql`SELECT COUNT(*) AS total ${sql.from} ${sql.where}`);
    const last=result[19];const nextCursor=result.length>20&&last?Buffer.from(JSON.stringify({scope,asOf:now.toISOString(),at:(last.createdAt as Date).toISOString(),id:last.id})).toString('base64url'):null;
    const [stats,pending]=await Promise.all([summary(tx,parsed.tab,parsed.filters,now),['feedback','requests','audit'].includes(parsed.tab)?Promise.all([tx.feedback.count({where:{status:'OPEN'}}),tx.accountSupportRequest.count({where:{status:'OPEN'}})]):Promise.resolve(null)]);
    return {tab:parsed.tab,rows:result.slice(0,20).map(r=>rowView(parsed.tab,r,now)),total:Number(count.total),nextCursor,asOf:now.toISOString(),...stats,caveats:activityCaveats[parsed.tab],...(pending?{pending:{feedback:pending[0],requests:pending[1]}}:{}),...(parsed.tab==='email'?{readiness:readiness()}: {})};
  },{isolationLevel:'RepeatableRead'});
}
function csvCell(value:unknown){let text=String(value??'—');if(/^[\s\u0000-\u001f]*[=+\-@]/.test(text)||/^[\t\r\n]/.test(text))text=`'${text}`;return `"${text.replace(/"/g,'""')}"`;}
export function buildActivityCsv(tab:ActivityTab,rows:ActivityRow[],filters:ActivityFilters,asOf:string,locale:Locale='zh-CN'){
  const columns=activityColumns[tab];
  const t=(text:string,values?:Record<string,string|number>)=>translateAdminCopy(locale,text,values,activityCopy);
  const value=(row:ActivityRow,key:string)=>activityValue(key,key==='createdAt'?row.createdAt:row.cells[key],locale);
  const comment=t('导出时间 {time}；时区 Asia/Hong_Kong；筛选 {filters}；口径 {caveat}',{time:activityValue('createdAt',asOf,locale),filters:JSON.stringify(filters),caveat:activityCaveats[tab].map(text=>t(text)).join(' ')});
  return '\uFEFF'+[csvCell(`# ${comment}`),columns.map(c=>csvCell(t(c.label))).join(','),...rows.map(r=>columns.map(c=>csvCell(value(r,c.key))).join(','))].join('\r\n');
}
export async function exportPlatformAdminActivity(db:PrismaClient,input:ActivityQuery&{userId:string}){
  const{userId,...request}=input;const parsed=normalize(request);if(!['visits','product','usage'].includes(parsed.tab))throw new DomainError(400,'ADMIN_EXPORT_UNSUPPORTED');
  return db.$transaction(async tx=>{
    await requirePlatformAdmin(tx,userId);const now=new Date();const sql=activitySql(parsed.tab,parsed.filters,now);
    const rows=await tx.$queryRaw<SqlRow[]>(Prisma.sql`SELECT ${sql.projection} ${sql.from} ${sql.where} ORDER BY t."createdAt" DESC,t.id DESC`);
    return {filename:`adthrender-${parsed.tab}-${localDay(now)}.csv`,csv:buildActivityCsv(parsed.tab,rows.map(r=>rowView(parsed.tab,r,now)),parsed.filters,now.toISOString(),parsed.locale)};
  },{isolationLevel:'RepeatableRead',timeout:60000});
}
export async function runPlatformAdminActivityCommand(db:PrismaClient,input:ActivityCommand&{userId:string}){
  const parsed=z.object({userId:z.uuid(),command:z.enum(['resolve-feedback','resolve-request','retry-email']),id:z.uuid(),reason:z.string().trim().min(1).max(2000).refine(v=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)),identityVerified:z.boolean().optional(),expectedStatus:z.string().min(1)}).strict().safeParse(input);
  if(!parsed.success)throw new DomainError(400,'INVALID_ADMIN_ACTIVITY_COMMAND');const args=parsed.data;
  return db.$transaction(async tx=>{
    await lockAccountAdministration(tx);await requirePlatformAdmin(tx,args.userId);
    if(args.command==='retry-email'){
      if(!readiness().configured)throw new DomainError(503,'EMAIL_SERVICE_UNCONFIGURED');
      const rows=await tx.$queryRaw<Array<{status:string;attempts:number;payloadAvailable:boolean;payloadExpiresAt:Date|null;expiresAt:Date|null;leaseExpiresAt:Date|null;organizationId:string|null}>>`SELECT status,attempts,("encryptedPayload" IS NOT NULL AND "encryptionKeyVersion"='v1') AS "payloadAvailable","payloadExpiresAt","expiresAt","leaseExpiresAt","organizationId" FROM "EmailDelivery" WHERE id=${args.id} FOR UPDATE`;
      const row=rows[0];if(!row)throw new DomainError(404,'EMAIL_DELIVERY_NOT_FOUND');if(row.status!==args.expectedStatus)throw new DomainError(409,'ADMIN_ACTIVITY_CONFLICT');
      const[clock]=await tx.$queryRaw<Array<{now:Date}>>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
      const eligibility=emailRetryEligibility({...row,payloadExpiresAt:row.payloadExpiresAt?.toISOString()??null,expiresAt:row.expiresAt?.toISOString()??null,leaseExpiresAt:row.leaseExpiresAt?.toISOString()??null},clock.now);
      if(!eligibility.eligible)throw new DomainError(409,'EMAIL_RETRY_UNAVAILABLE');
      const updated=await tx.emailDelivery.updateMany({where:{id:args.id,status:'FAILED',attempts:{lt:3},encryptedPayload:{not:null},encryptionKeyVersion:'v1',payloadExpiresAt:{gt:clock.now},AND:[{OR:[{expiresAt:null},{expiresAt:{gt:clock.now}}]},{OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lte:clock.now}}]}]},data:{status:'QUEUED',nextAttemptAt:clock.now,leaseOwner:null,leaseExpiresAt:null}});
      if(updated.count!==1)throw new DomainError(409,'ADMIN_ACTIVITY_CONFLICT');
      await tx.auditEvent.create({data:{organizationId:row.organizationId,actorUserId:args.userId,action:'EMAIL_RETRY_REQUESTED',targetType:'EmailDelivery',targetId:args.id,metadata:{before:{status:row.status,attempts:row.attempts},after:{status:'QUEUED'},reason:args.reason}}});
      return {id:args.id,status:'QUEUED'};
    }
    const feedback=args.command==='resolve-feedback';
    const locked=feedback?await tx.$queryRaw<Array<{id:string;status:string;category:string;organizationId:string}>>`SELECT id,status,category,"organizationId" FROM "Feedback" WHERE id=${args.id} FOR UPDATE`:await tx.$queryRaw<Array<{id:string;status:string;kind:string;userId:string}>>`SELECT id,status,kind,"userId" FROM "AccountSupportRequest" WHERE id=${args.id} FOR UPDATE`;
    const row=locked[0];if(!row)throw new DomainError(404,'SUPPORT_REQUEST_NOT_FOUND');
    if(row.status!==args.expectedStatus||row.status!=='OPEN')throw new DomainError(409,'ADMIN_ACTIVITY_CONFLICT');
    const kind='category'in row?row.category:row.kind;
    if(kind==='DELETION_REQUEST'&&!args.identityVerified)throw new DomainError(400,'IDENTITY_VERIFICATION_REQUIRED');
    const resolvedAt=new Date();
    if(feedback)await tx.feedback.update({where:{id:args.id},data:{status:'RESOLVED',resolvedAt}});else await tx.accountSupportRequest.update({where:{id:args.id},data:{status:'RESOLVED',resolvedAt}});
    await tx.auditEvent.create({data:{...('organizationId'in row?{organizationId:row.organizationId}:{}),actorUserId:args.userId,action:feedback?'FEEDBACK_RESOLVED':'ACCOUNT_SUPPORT_RESOLVED',targetType:feedback?'Feedback':'AccountSupportRequest',targetId:args.id,metadata:{before:{status:row.status},after:{status:'RESOLVED'},reason:args.reason,kind,identityVerified:args.identityVerified===true}}});
    return {id:args.id,status:'RESOLVED'};
  });
}
