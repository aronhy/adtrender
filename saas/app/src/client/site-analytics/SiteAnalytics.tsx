/// <reference types="vite/client" />
import { createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { createSiteAnalytics, type Choice } from './analytics';
import type { GrowthStatus } from './growth';
import './site-analytics.css';

type Runtime = ReturnType<typeof createSiteAnalytics>;
const idleGrowth = (): GrowthStatus => 'idle';
const noSubscription = (_listener: () => void) => () => {};
const ConsentContext = createContext<{ choice: Choice; choose: (value: Exclude<Choice, null>) => void; enabled: boolean } | null>(null);

export function AnalyticsBoundary({ runtime, children }: { runtime: Runtime; children?: ReactNode }) {
  const location = useLocation();
  const target = `${location.pathname}${location.search}${location.hash}`;
  const blocked = runtime.mustReload(target);
  const [choice, setChoice] = useState<Choice>(() => runtime.choice());
  const growthStatus = useSyncExternalStore(runtime.growth?.subscribe ?? noSubscription, runtime.growth?.status ?? idleGrowth, idleGrowth);
  const choose = (value: Exclude<Choice, null>) => { runtime.choose(value); setChoice(runtime.choice()); };
  useLayoutEffect(() => { runtime.install(); return () => runtime.dispose(); }, [runtime]);
  useLayoutEffect(() => { if (blocked) runtime.leave(target, true); }, [runtime, blocked, target]);
  useEffect(() => { if (!blocked) { runtime.start(); runtime.page(); } }, [runtime, blocked, target]);
  // A router can update without History (for example navigate from a child).
  // Returning before children render is the final boundary, not a stop command.
  if (blocked) return <p role="status" className="analytics-navigation">正在打开页面…</p>;
  return <ConsentContext.Provider value={{ choice, choose, enabled: runtime.enabled() }}>{children}
    {runtime.enabled() && choice === null && <aside className="analytics-consent" aria-label="网站统计选择"><div><strong>允许网站统计？</strong><p>允许后，Google Analytics 和 Microsoft Clarity 用于公开页面的来源、地区与使用统计；我们也会将本浏览器的来源与注册、首次收藏结果关联，了解渠道效果。拒绝不影响使用。<Link to="/privacy">隐私说明</Link></p></div><div className="analytics-actions"><button type="button" onClick={() => choose('rejected')}>拒绝统计</button><button type="button" onClick={() => choose('accepted')}>接受统计</button></div></aside>}
    {growthStatus === 'revocation_pending' && <aside className="analytics-consent" role="status"><p>本浏览器已停止统计，服务器撤回确认尚未完成。</p><button type="button" onClick={() => runtime.growth?.revoke()}>重试撤回</button></aside>}
  </ConsentContext.Provider>;
}

export function SiteAnalytics({ children }: { children?: ReactNode }) {
  const [runtime] = useState(() => typeof window === 'undefined' ? null : createSiteAnalytics(window, {
    ga4: import.meta.env.VITE_GA4_MEASUREMENT_ID,
    clarity: import.meta.env.VITE_CLARITY_PROJECT_ID,
    growth: true,
  }));
  return runtime ? <AnalyticsBoundary runtime={runtime}>{children}</AnalyticsBoundary> : <>{children}</>;
}

export function AnalyticsPreferences() {
  const consent = useContext(ConsentContext);
  if (!consent?.enabled) return <p>当前页面未启用可选网站统计。</p>;
  return <section className="analytics-preferences" aria-label="网站统计偏好"><h2>网站统计偏好</h2><p>当前选择：{consent.choice === 'accepted' ? '已允许统计' : consent.choice === 'rejected' ? '已拒绝统计' : '尚未选择'}</p><div className="analytics-actions">{consent.choice !== 'accepted' && <button type="button" onClick={() => consent.choose('accepted')}>允许统计</button>}<button type="button" onClick={() => consent.choose('rejected')}>{consent.choice === 'accepted' ? '撤回统计同意' : '拒绝统计'}</button></div><p>撤回后将重新打开本页，停止后续统计。已经发送的数据不会因撤回自动删除。</p></section>;
}
