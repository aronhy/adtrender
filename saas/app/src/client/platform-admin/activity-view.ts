import type { Locale } from '../landing/messages';
import { translateAdminCopy } from './admin-copy-core';
import { activityCopy } from './activity-copy';
import type { ActivityFilters, ActivityScalar, ActivityTab } from '../../server/platform-admin-activity';
export const activityFilterKeys=['search','status','category','organizationId','actorUserId','action','eventName','templateKey','channel'] as const;
export function activityFiltersFromParams(tab:ActivityTab,params:URLSearchParams):ActivityFilters {
 const result:ActivityFilters={};
 for(const key of activityFilterKeys){const value=params.get(key);if(value)(result as Record<string,string>)[key]=value;}
 if(!params.has('status')&&['feedback','requests'].includes(tab))result.status='OPEN';
 if(params.get('pending')==='all'&&['feedback','requests','email'].includes(tab))result.allDates=true;
 return result;
}
export function activityFilterParams(params:URLSearchParams,key:keyof ActivityFilters,value:string){const next=new URLSearchParams(params);if(value||key==='status')next.set(key,value);else next.delete(key);next.delete('cursor');return next;}
export function activityPeriodParams(params:URLSearchParams,range:{from:string;to:string}){const next=new URLSearchParams(params);next.set('from',range.from);next.set('to',range.to);next.delete('pending');next.delete('cursor');return next;}
export function activityTabParams(params:URLSearchParams,tab:ActivityTab){const next=new URLSearchParams(params);next.set('tab',tab);for(const key of activityFilterKeys)next.delete(key);next.delete('pending');next.delete('cursor');return next;}
export function activityClearParams(params:URLSearchParams,tab:ActivityTab){const next=new URLSearchParams(params);for(const key of activityFilterKeys)next.delete(key);if(['feedback','requests'].includes(tab))next.set('status','');next.delete('pending');next.delete('cursor');return next;}
export const activityLabels: Record<ActivityTab, string>={visits:'网站访问',product:'产品使用',usage:'用量',feedback:'反馈',requests:'账号申请',audit:'审计日志',email:'邮件记录'};
export const activityTableColumns: Record<ActivityTab, Array<{key:string;label:string}>>={
 visits:[['createdAt','首次访问'],['lastSeenAt','最近活动'],['landingPath','落地路径'],['source','来源'],['medium','媒介'],['campaign','活动'],['referrerOrigin','引荐来源'],['consentVersion','同意版本'],['conversions','转化'],['isTest','测试']].map(([key,label])=>({key,label})),
 product:[['createdAt','时间'],['name','事件名'],['organization','组织'],['workspace','工作区'],['sourceAdId','来源广告 ID']].map(([key,label])=>({key,label})),
 usage:[['createdAt','时间'],['organization','组织'],['key','权益项'],['quantity','数量'],['status','状态'],['releaseReason','释放原因'],['idempotencyKey','幂等键（前 8 位）']].map(([key,label])=>({key,label})),
 feedback:[['createdAt','提交时间'],['category','类别'],['subject','主题'],['organization','组织 / 工作区'],['requester','提交人'],['status','状态']].map(([key,label])=>({key,label})),
 requests:[['createdAt','提交时间'],['kind','类型'],['requester','申请人'],['body','摘要'],['status','状态'],['resolvedAt','处理时间']].map(([key,label])=>({key,label})),
 audit:[['createdAt','时间'],['action','动作'],['targetType','对象'],['actor','操作者'],['summary','摘要']].map(([key,label])=>({key,label})),
 email:[['createdAt','创建时间'],['recipientEmail','收件人'],['templateKey','模板'],['status','状态'],['attempts','尝试'],['sentAt','发送时间'],['lastErrorCode','错误']].map(([key,label])=>({key,label})),
};
const statusLabels:Record<string,string>={OPEN:'待处理',RESOLVED:'已处理',QUEUED:'排队',SENDING:'投递中',SENT:'已发送',FAILED:'失败',EXPIRED:'已过期',UNKNOWN:'结果未知',RESERVED:'预占中',SETTLED:'已结算',RELEASED:'已释放',DELETION_REQUEST:'删除申请',DATA_REQUEST:'数据请求',FEEDBACK:'账号问题',GENERAL:'使用问题',BUG:'功能异常',WORKSPACES:'工作区',MEMBERS:'成员席位',SAVED_ADS:'收藏',ANALYSES:'分析次数'};
export function activityValue(key:string,value:ActivityScalar|undefined,locale:Locale='zh-CN'):string{
 if(value===null||value===undefined||value==='')return '—';
 if(['createdAt','updatedAt','lastSeenAt','sentAt','resolvedAt','nextAttemptAt','payloadExpiresAt','expiresAt'].includes(key)){
  const date=new Date(String(value));if(!Number.isFinite(date.getTime()))return '—';
  return new Intl.DateTimeFormat(locale,{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
 }
 if(typeof value==='boolean')return translateAdminCopy(locale,value?'是':'否',undefined,activityCopy);
 if(['status','kind','category','key'].includes(key))return translateAdminCopy(locale,statusLabels[String(value)]??String(value),undefined,activityCopy);
 return typeof value==='number'?new Intl.NumberFormat(locale).format(value):String(value);
}
export function activityMetric(key:string,value:number|null,locale:Locale='zh-CN'):string{if(value===null)return translateAdminCopy(locale,'未采集 / 无法计算',undefined,activityCopy);return key.toLowerCase().includes('rate')?`${new Intl.NumberFormat(locale,{minimumFractionDigits:1,maximumFractionDigits:1}).format(value)}%`:new Intl.NumberFormat(locale,{maximumFractionDigits:2}).format(value);}
export function isActivityPermissionError(error:unknown){const text=error instanceof Error?error.message:typeof error==='string'?error:JSON.stringify(error??'');return /PLATFORM_ADMIN_REQUIRED|ACCOUNT_DISABLED|AUTH_REQUIRED|403|401|没有访问权限|forbidden/i.test(text);}
export function activityError(error:unknown){const text=error instanceof Error?error.message:String(error??'');return /ADMIN_ACTIVITY_CONFLICT/.test(text)?'另一管理员已处理，最新状态已刷新；请核对后重新确认。':/EMAIL_RETRY_UNAVAILABLE/.test(text)?'这封邮件已无法重试，请核对载荷过期时间和尝试次数。':/EMAIL_SERVICE_UNCONFIGURED/.test(text)?'邮件服务尚未配置。':'读取或提交失败，请重试。';}
