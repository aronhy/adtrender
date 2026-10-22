/// <reference types="vite/client" />
import { createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { createSiteAnalytics, publicPage, type Choice } from './analytics';
import type { GrowthStatus } from './growth';
import { isFreeToolPath } from '../../shared/free-tools';
import './site-analytics.css';

type Runtime = ReturnType<typeof createSiteAnalytics>;
const idleGrowth = (): GrowthStatus => 'idle';
const noSubscription = (_listener: () => void) => () => {};
const ConsentContext = createContext<{ choice: Choice; choose: (value: Exclude<Choice, null>) => void; enabled: boolean } | null>(null);

function changesDocument(address: string | null, target: string) {
  if (!address) return false;
  const initial = new URL(address), destination = new URL(target, initial);
  const kind = (value: string) => {
    const page = publicPage(value);
    return !page ? 'private' : isFreeToolPath(page.path) ? 'tools' : 'marketing';
  };
  return destination.origin === initial.origin && kind(destination.href) !== kind(initial.href);
}

export function AnalyticsBoundary({ runtime, documentAddress = null, children }: { runtime: Runtime | null; documentAddress?: string | null; children?: ReactNode }) {
  const location = useLocation();
  const target = `${location.pathname}${location.search}${location.hash}`;
  // Keep the initial document boundary even before the deferred runtime exists.
  // A child's early navigation must not mount tool/private data in this document.
  const blocked = changesDocument(documentAddress, target) || (runtime?.mustReload(target) ?? false);
  const [choice, setChoice] = useState<Choice>(() => runtime?.choice() ?? null);
  const growthStatus = useSyncExternalStore(runtime?.growth?.subscribe ?? noSubscription, runtime?.growth?.status ?? idleGrowth, idleGrowth);
  const enabled = runtime?.enabled() ?? false;
  const choose = (value: Exclude<Choice, null>) => { if (runtime) { runtime.choose(value); setChoice(runtime.choice()); } };
  useLayoutEffect(() => { if (runtime) { setChoice(runtime.choice()); runtime.install(); return () => runtime.dispose(); } }, [runtime]);
  useLayoutEffect(() => { if (blocked) runtime?.leave(target, true); }, [runtime, blocked, target]);
  useEffect(() => { if (runtime && !blocked) { runtime.start(); runtime.page(); } }, [runtime, blocked, target]);
  // A router can update without History (for example navigate from a child).
  // Returning before children render is the final boundary, not a stop command.
  if (blocked) return <p role="status" className="analytics-navigation">正在打开页面…</p>;
  return <ConsentContext.Provider value={{ choice, choose, enabled }}>{children}
    {enabled && choice === null && <aside className="analytics-consent" aria-label="网站统计选择"><div><strong>允许网站统计？</strong><p>{runtime?.documentType === 'tools' ? '允许后，我们通过第一方服务记录工具页面的访问与来源。工具输入和结果不会发送到统计服务，工具页不加载第三方统计或会话回放。' : '允许后，Google Analytics 和 Microsoft Clarity 用于公开页面的来源、地区与使用统计；'}我们也会将本浏览器的来源与注册、首次收藏结果关联，了解渠道效果。拒绝不影响使用。<Link to="/privacy">隐私说明</Link></p></div><div className="analytics-actions"><button type="button" onClick={() => choose('rejected')}>拒绝统计</button><button type="button" onClick={() => choose('accepted')}>接受统计</button></div></aside>}
    {growthStatus === 'revocation_pending' && <aside className="analytics-consent" role="status"><p>本浏览器已停止统计，服务器撤回确认尚未完成。</p><button type="button" onClick={() => runtime?.growth?.revoke()}>重试撤回</button></aside>}
  </ConsentContext.Provider>;
}

export function SiteAnalytics({ children }: { children?: ReactNode }) {
  const [documentAddress] = useState(() => typeof window === 'undefined' ? null : window.location.href);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  useEffect(() => { setRuntime(createSiteAnalytics(window, {
    ga4: import.meta.env.VITE_GA4_MEASUREMENT_ID,
    clarity: import.meta.env.VITE_CLARITY_PROJECT_ID,
    growth: true,
  })); }, []);
  // Server and first hydration render share the same Provider and child slots,
  // preserving useId and form nodes when consent UI is added after hydration.
  return <AnalyticsBoundary runtime={runtime} documentAddress={documentAddress}>{children}</AnalyticsBoundary>;
}

export function AnalyticsPreferences() {
  const consent = useContext(ConsentContext);
  if (!consent?.enabled) return <p>当前页面未启用可选网站统计。</p>;
  return <section className="analytics-preferences" aria-label="网站统计偏好"><h2>网站统计偏好</h2><p>当前选择：{consent.choice === 'accepted' ? '已允许统计' : consent.choice === 'rejected' ? '已拒绝统计' : '尚未选择'}</p><div className="analytics-actions">{consent.choice !== 'accepted' && <button type="button" onClick={() => consent.choose('accepted')}>允许统计</button>}<button type="button" onClick={() => consent.choose('rejected')}>{consent.choice === 'accepted' ? '撤回统计同意' : '拒绝统计'}</button></div><p>撤回后将重新打开本页，停止后续统计。已经发送的数据不会因撤回自动删除。</p></section>;
}
