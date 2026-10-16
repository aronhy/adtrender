import { useAdminCopy } from "./admin-i18n";
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { config } from 'wasp/client';
import type { DashboardHealth } from '../../server/platform-admin-dashboard';
import { RefreshCw } from 'lucide-react';
import { getPlatformAdminData, platformAdminCommand } from 'wasp/client/operations';
import { useApp } from '../App';
import { SeedAdminModule } from '../admin-seeds/SeedAdminModule';
import { adminModule, adminModules, defaultRange, moduleParams, permissionError, validAdminRange } from './navigation';
import { AdminEmpty, AdminError, AdminSkeleton, Button, adminDate, useAdminResource } from './shared';
import { DashboardModule } from './DashboardModule';
import { UsersModule } from './UsersModule';
import { AdsModule } from './AdsModule';
import { ApplicationTasks } from './ApplicationTasks';
import { AnalyticsModule, OperationsModule, EmailModule } from './ActivityModules';
import './platform-admin.css';
export function AdminPage() {
    const { t, locale } = useAdminCopy();
    const { state, commandVersion } = useApp();
    const [params, setParams] = useSearchParams();
    const module = adminModule(params.get('module'));
    const [reload, setReload] = useState(0), [updated, setUpdated] = useState<string>(), [forbidden, setForbidden] = useState(false);
    const defaults = defaultRange();
    const from = params.get('from') ?? defaults.from, to = params.get('to') ?? defaults.to;
    const range = { from, to };
    const valid = validAdminRange(range);
    useEffect(() => { if (params.get('module') !== module) {
        setParams(next => { const p = new URLSearchParams(next); p.set('module', module); return p; }, { replace: true });
    } }, [module, params, setParams]);
    useEffect(() => { setForbidden(false); }, [module, state.user.isAdmin]);
    const load = useCallback(async (payload: Record<string, unknown>) => { try {
        const value = await getPlatformAdminData({ module: module === 'seeds' ? 'ads' : module, payload });
        if(module==='dashboard'&&payload.view==='health'){
            const snapshot=value as DashboardHealth;
            try {
                const response=await fetch(`${config.apiUrl}/health`,{signal:AbortSignal.timeout(8000)});
                const probe=await response.json() as {api?:string;database?:string};
                for(const service of snapshot.services){if(service.name==='API'||service.name==='数据库'){
                    const key=service.name==='API'?'api':'database';service.status=probe[key]==='ok'?'HEALTHY':probe[key]==='unavailable'?'UNAVAILABLE':'UNKNOWN';
                    service.at=new Date();service.note=service.name==='API'?'独立 /health 接口探测。':'独立 /health 数据库探测；不引用 Worker 心跳。';
                }}
            }catch{for(const service of snapshot.services){if(service.name==='API'||service.name==='数据库'){service.status='UNKNOWN';service.note='独立 /health 探测暂时失败；本次管理查询仍可返回。';}}}
        }

        const dto = value as {
            asOf?: string;
        };
        if (dto.asOf)
            setUpdated(String(dto.asOf));
        return value;
    }
    catch (error) {
        if (permissionError(error))
            setForbidden(true);
        throw error;
    } }, [module]);
    const execute = useCallback(async (payload: Record<string, unknown>) => { try {
        const result = await platformAdminCommand({ module: module === 'seeds' ? 'ads' : module, payload });
        setReload(v => v + 1);
        return result;
    }
    catch (error) {
        if (permissionError(error))
            setForbidden(true);
        throw error;
    } }, [module]);
    const props = { load, execute, reload: reload + commandVersion };
    const changeRange = (r: {
        from: string;
        to: string;
    }) => setParams(next => { const p = new URLSearchParams(next); p.set('from', r.from); p.set('to', r.to); p.delete('cursor'); return p; });
    const showRange = module === 'dashboard' || module === 'users';
    const rangeControls=<div className="pa-range-controls"><label>{t("时间范围")}<select aria-label={t("时间范围")} value={from === defaults.from && to === defaults.to ? '7' : from === defaultRange(30).from && to === defaults.to ? '30' : 'custom'} onChange={e => { if (e.target.value !== 'custom')
            changeRange(defaultRange(Number(e.target.value))); }}><option value="7">{t("近 7 天")}</option><option value="30">{t("近 30 天")}</option><option value="custom">{t("自定义")}</option></select></label><label>{t("开始日期")}<input type="date" value={from} max={to} onChange={e => changeRange({ ...range, from: e.target.value })}/></label><label>{t("结束日期")}<input type="date" value={to} min={from} max={defaults.to} onChange={e => changeRange({ ...range, to: e.target.value })}/></label></div>;
    return <div className="platform-admin"><header><div><h1>{t("平台管理")}</h1><p className="pa-subtitle">{t("平台全局数据。切换工作区不改变这里的范围。")}</p></div><div className="pa-updated"><span>{t("数据更新时间：")}{updated ? adminDate(updated,locale) : '—'}</span><Button variant="ghost" size="icon" aria-label={t("刷新管理数据")} onClick={() => setReload(v => v + 1)}><RefreshCw size={16}/></Button></div></header>
 <nav className="pa-tabs" aria-label={t("平台管理模块")}>{adminModules.map(([key, label]) => <Link key={key} to={`?${moduleParams(params, key)}`} aria-current={module === key ? 'page' : undefined}>{t(label)}</Link>)}</nav>
 {!state.user.isAdmin || forbidden ? <AdminEmpty title={t("没有访问权限")}>{t("当前账号没有有效的平台管理权限，请联系平台管理员。")}</AdminEmpty> : <>
 {module==='dashboard'&&<div className="pa-toolbar pa-range">{rangeControls}</div>}
 {showRange && !valid ? <AdminEmpty title={t("请选择有效时间范围")}>{t("最多 90 天，结束日期不能超过今天。")}</AdminEmpty> : <>
 {module === 'dashboard' && <DashboardModule {...props} range={range}/>}
 {module === 'users' && <UsersModule {...props} rangeControls={rangeControls} range={{ from: new Date(`${from}T00:00:00+08:00`).toISOString(), to: new Date(Date.parse(`${to}T00:00:00+08:00`) + 86400000).toISOString() }}/>}
 {module === 'ads' && <><AdsModule {...props} applicationTasks={<ApplicationTasks {...props}/>}/><p className="pa-caveat"><Link to={`?${moduleParams(params, 'seeds')}`}>{t("打开种子管理 →")}</Link>{t("· 种子管理沿用独立工作流。")}</p></>}
 {module === 'analytics' && <AnalyticsModule {...props}/>}{module === 'operations' && <OperationsModule {...props}/>}{module === 'email' && <EmailModule {...props}/>}{module === 'showcase' && <Showcase {...props}/>}{module === 'seeds' && <SeedAdminModule />}
 </>}
 </>}
 </div>;
}
function Showcase({ load, reload }: {
    load: (payload: Record<string, unknown>) => Promise<unknown>;
    reload: number;
}) { const { t, locale } = useAdminCopy(); const resource = useAdminResource<{
    available: boolean;
    reason: string;
}>(load, {}, reload); return <>{!!resource.error && <AdminError error={resource.error} retry={resource.refresh}/>}{resource.loading && !resource.data ? <AdminSkeleton /> : resource.data && <AdminEmpty title={t("首页橱窗尚未启用")}>{t(resource.data.reason)}</AdminEmpty>}</>; }
