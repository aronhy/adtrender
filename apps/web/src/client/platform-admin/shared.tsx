import { useAdminCopy } from "./admin-i18n";
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, X } from 'lucide-react';
import { permissionError } from './navigation';
import { Button } from './ui/button';
export { Button } from './ui/button';
export type AdminModuleProps = {
    load: (payload: Record<string, unknown>) => Promise<unknown>;
    execute: (payload: Record<string, unknown>) => Promise<unknown>;
    reload: number;
    rangeControls?: ReactNode;
    range?: {
        from: string;
        to: string;
    };
};
export function useAdminResource<T>(load: AdminModuleProps['load'], payload: Record<string, unknown>, reload: number) {
    const key = JSON.stringify(payload);
    const [data, setData] = useState<T>();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<unknown>();
    const [version, setVersion] = useState(0);
    useEffect(() => { let live = true; setLoading(true); setError(undefined); void load(JSON.parse(key) as Record<string, unknown>).then(value => { if (live)
        setData(value as T); }, reason => { if (live) {
        setError(reason);
        if (permissionError(reason))
            setData(undefined);
    } }).finally(() => { if (live)
        setLoading(false); }); return () => { live = false; }; }, [load, key, reload, version]);
    return { data, loading, error, refresh: useCallback(() => setVersion(v => v + 1), []) };
}
export function adminDate(value: unknown,locale='zh-CN') { if (!value)
    return '—'; const date = new Date(String(value)); return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hong_Kong' }).format(date) : '—'; }
export function AdminNotice({ children, tone = 'neutral' }: {
    children: ReactNode;
    tone?: 'neutral' | 'warning' | 'error';
}) { const { t, locale } = useAdminCopy(); return <div className={`pa-notice pa-notice-${tone}`} role={tone === 'error' ? 'alert' : 'note'}><AlertCircle size={16} aria-hidden="true"/><div>{children}</div></div>; }
export function AdminEmpty({ title, children }: {
    title: string;
    children?: ReactNode;
}) { const { t, locale } = useAdminCopy(); return <div className="pa-empty"><h3>{title}</h3>{children && <p>{children}</p>}</div>; }
export function AdminSkeleton() { const { t, locale } = useAdminCopy(); return <div className="pa-skeleton" aria-label={t("正在读取管理数据")} role="status">{Array.from({ length: 5 }, (_, i) => <div key={i}/>)}</div>; }
export function AdminError({ error, retry }: {
    error: unknown;
    retry: () => void;
}) { const { t, locale } = useAdminCopy(); return permissionError(error) ? <AdminEmpty title={t("没有访问权限")}>{t("当前身份没有平台管理权限，请联系平台管理员。")}</AdminEmpty> : <AdminNotice tone="error">{t("暂时无法读取数据。已加载内容仍保留。")}<Button variant="ghost" size="sm" onClick={retry}>{t("重试")}</Button></AdminNotice>; }
export function AdminKpis({ items }: {
    items: Array<{
        label: string;
        value: ReactNode;
        note?: string;
    }>;
}) { const { t, locale } = useAdminCopy(); return <div className="pa-kpis" style={{'--pa-kpi-count':items.length} as CSSProperties}>{items.map(item => <div key={item.label}><span>{item.label}</span><strong>{item.value}</strong>{item.note && <small>{item.note}</small>}</div>)}</div>; }
const overlays: string[] = [];
let overlayBase: {
    overflow: string;
    main: HTMLElement | null;
    inert: boolean;
    focus: HTMLElement | null;
} | undefined;
function AdminOverlay({ title, onClose, children, footer, drawer = false }: {
    title: string;
    onClose: () => void;
    children: ReactNode;
    footer?: ReactNode;
    drawer?: boolean;
}) {
    const { t, locale } = useAdminCopy();
    const id = useId();
    const ref = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        const before = document.activeElement as HTMLElement | null;
        if (!overlays.length) {
            const main = document.querySelector<HTMLElement>('.workspace-shell');
            overlayBase = { overflow: document.body.style.overflow, main, inert: main?.inert ?? false, focus: before };
            document.body.style.overflow = 'hidden';
            if (main)
                main.inert = true;
        }
        overlays.push(id);
        const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? []).filter(el => el.getClientRects().length);
        (focusable()[0] ?? ref.current)?.focus();
        const key = (event: KeyboardEvent) => { if (overlays.at(-1) !== id)
            return; if (event.key === 'Escape') {
            event.preventDefault();
            closeRef.current();
        } if (event.key === 'Tab') {
            const list = focusable();
            const first = list[0] ?? ref.current, last = list.at(-1) ?? ref.current;
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            }
            else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        } };
        document.addEventListener('keydown', key);
        return () => { document.removeEventListener('keydown', key); const index = overlays.indexOf(id); if (index >= 0)
            overlays.splice(index, 1); if (!overlays.length && overlayBase) {
            const base = overlayBase;
            overlayBase = undefined;
            document.body.style.overflow = base.overflow;
            if (base.main)
                base.main.inert = base.inert;
            if (base.focus?.isConnected)
                base.focus.focus();
        }
        else if (before?.isConnected)
            before.focus(); };
    }, [id]);
    return createPortal(<div className={`pa-overlay ${drawer ? 'pa-overlay-drawer' : 'pa-overlay-modal'}`} onClick={event => { if (event.target === event.currentTarget)
        onClose(); }}><div ref={ref} className={drawer ? 'pa-drawer' : 'pa-dialog'} role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}><header><h2 id={id}>{title}</h2><Button variant="ghost" size="icon" aria-label={t("关闭")} onClick={onClose}><X size={18}/></Button></header><div className="pa-overlay-body">{children}</div>{footer && <footer>{footer}</footer>}</div></div>, document.body);
}
export function AdminDrawer(props: {
    title: string;
    onClose: () => void;
    children: ReactNode;
    footer?: ReactNode;
}) { const { t, locale } = useAdminCopy(); return <AdminOverlay {...props} drawer/>; }
export function AdminConfirm({ title, onClose, onConfirm, danger = false, match, identityRequired = false, children, disabled = false, confirmLabel }: {
    title: string;
    onClose: () => void;
    onConfirm: (reason: string) => Promise<void>;
    danger?: boolean;
    match?: string;
    identityRequired?: boolean;
    children?: ReactNode;
    disabled?: boolean;
    confirmLabel?: string;
}) {
    const { t, locale } = useAdminCopy();
    const [reason, setReason] = useState(''), [confirmation, setConfirmation] = useState(''), [identity, setIdentity] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const valid = !!reason.trim() && (!match || confirmation === match) && (!identityRequired || identity);
    return <AdminOverlay title={title} onClose={() => { if (!busy)
        onClose(); }} footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>{t("取消")}</Button><Button variant={danger ? 'destructive' : 'default'} disabled={!valid || busy || disabled} onClick={async () => { setBusy(true); setError(''); try {
        await onConfirm(reason.trim());
        onClose();
    }
    catch (error) {
        setError(error instanceof Error ? error.message : t("操作未完成，请核对当前状态后重试。输入已保留。"));
    }
    finally {
        setBusy(false);
    } }}>{busy ? t("提交中…") : confirmLabel ?? t("确认并记录")}</Button></>}>
    {error && <AdminNotice tone="error">{error}</AdminNotice>}<p>{t("本次操作会记录操作者、目标、变更结果与原因。")}</p>{children}{match && <label>{t("输入目标标识")}<strong>{match}</strong>{t("完全匹配")}<input value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off"/></label>}
    {identityRequired && <label className="pa-checkbox"><input type="checkbox" checked={identity} onChange={e => setIdentity(e.target.checked)}/>{t("已核验申请人身份")}</label>}<label>{t("操作或处理原因 *")}<textarea value={reason} maxLength={500} rows={4} required onChange={e => setReason(e.target.value)}/></label>
  </AdminOverlay>;
}
export function AdminPagination({ page, nextCursor, onPrevious, onNext, loading = false }: {
    page: number;
    nextCursor?: string | null;
    onPrevious: () => void;
    onNext: () => void;
    loading?: boolean;
}) { const { t, locale } = useAdminCopy(); return <div className="pa-pagination"><span>{t("第")}{page}{t("页")}</span><Button variant="secondary" size="sm" disabled={page <= 1 || loading} onClick={onPrevious}>{t("上一页")}</Button><Button variant="secondary" size="sm" disabled={!nextCursor || loading} onClick={onNext}>{t("下一页")}</Button></div>; }
export function AdminStatus({ value }: {
    value: unknown;
}) {
    const { t, locale } = useAdminCopy();
    const key = String(value ?? 'UNKNOWN');
    const labels: Record<string, string> = { ACTIVE: t("启用"), PAUSED: t("暂停"), DISABLED: t("停用"), READY: t("就绪"), PENDING: t("待处理"), QUEUED: t("排队"), RUNNING: t("执行中"), FAILED: t("失败"), SUCCEEDED: t("成功"), NO_RESULTS: t("可靠无结果"), PARTIAL: t("部分结果"), SENT: t("已发送"), RETRYING: t("重试中"), EXPIRED: t("已过期"), RESOLVED: t("已处理"), OPEN: t("待处理"), HEALTHY: t("正常"), DEGRADED: t("需关注"), UNKNOWN: t("未知"), UNAVAILABLE: t("不可用"), TRIALING: t("试用中"), CANCELED: t("已取消"), RESERVED: t("预占"), SETTLED: t("已结算"), RELEASED: t("已释放") };
    const tone = ['ACTIVE', 'READY', 'SUCCEEDED', 'SENT', 'HEALTHY', 'SETTLED', 'RESOLVED'].includes(key) ? 'active' : ['FAILED', 'DEGRADED'].includes(key) ? 'conflict' : ['UNKNOWN', 'QUEUED', 'PENDING', 'RUNNING', 'TRIALING', 'RESERVED', 'PARTIAL'].includes(key) ? 'unknown' : 'neutral';
    return <span className={`pa-badge pa-badge-${tone}`}>{labels[key] ?? key}</span>;
}
