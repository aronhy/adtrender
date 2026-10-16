export const adminModules = [['dashboard','总览'],['users','用户与组织'],['ads','广告与采集'],['analytics','数据分析'],['operations','事务管理'],['email','邮件记录'],['showcase','首页橱窗']] as const;
export type AdminModule = typeof adminModules[number][0] | 'seeds';
const aliases:Record<string,AdminModule>={collection:'ads',customers:'users',accounts:'users',feedback:'operations',system:'dashboard'};
export function adminModule(value:string|null):AdminModule { return value === 'seeds' ? value : adminModules.some(([key])=>key===value) ? value as AdminModule : aliases[value??'']??'dashboard'; }
export function moduleParams(params:URLSearchParams,module:AdminModule):URLSearchParams {
  const next=new URLSearchParams(params);next.set('module',module);
  for(const key of ['cursor','adsTab','usersTab','view','section','tab','status','search','sourceId','organizationId','category','templateKey','eventName','seedId','detailId','pending'])next.delete(key);
  return next;
}
export function defaultRange(days=7,now=new Date()):{from:string;to:string} {
  const local=new Date(now.getTime()+8*3600000);return {from:new Date(local.getTime()-(days-1)*86400000).toISOString().slice(0,10),to:local.toISOString().slice(0,10)};
}
export function validAdminRange(range:{from:string;to:string},now=new Date()):boolean {
  const validDay=(day:string)=>/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(day))&&new Date(day).toISOString().slice(0,10)===day;
  return validDay(range.from)&&validDay(range.to)&&range.from<=range.to&&range.to<=defaultRange(7,now).to&&(Date.parse(range.to)-Date.parse(range.from))/86400000<90;
}
export function permissionError(error:unknown):boolean {
  if(!error||typeof error!=='object')return false;
  const value=error as {statusCode?:number;status?:number;message?:string};
  return [401,403].includes(value.statusCode??value.status??0)||/AUTH_REQUIRED|PLATFORM_ADMIN_REQUIRED|ACCOUNT_DISABLED/.test(value.message??'');
}

export function pendingParams(params:URLSearchParams,item:{module:AdminModule;tab:string;status:string},range:{from:string;to:string}):URLSearchParams {
 const next=moduleParams(params,item.module);next.set('tab',item.tab);next.set('adsTab',item.tab);next.set('status',item.status);
 if(item.module==='ads'&&item.tab==='runs'){next.set('from',range.from);next.set('to',range.to);}else{next.delete('from');next.delete('to');next.set('pending','all');}
 return next;
}
