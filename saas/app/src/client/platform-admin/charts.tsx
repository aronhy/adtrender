import { useAdminCopy } from "./admin-i18n";
import { useEffect, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, Line, LineChart, Pie, PieChart, Cell, ResponsiveContainer, Tooltip, useActiveTooltipCoordinate, usePlotArea, XAxis, YAxis } from 'recharts';
import { Button } from './shared';
type Point = Record<string, string | number | null>;
type Series = {
    key: string;
    label: string;
    color?: string;
};
const categorical = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'];
const stateColors = ['var(--status-active)', 'var(--status-unknown)', 'var(--status-conflict)', 'var(--ink-secondary)'];
function useChartReady() { const [ready, setReady] = useState(false), [animate, setAnimate] = useState(false); useEffect(() => { setReady(true); const mq = matchMedia('(prefers-reduced-motion: reduce)'); const change = () => setAnimate(!mq.matches); change(); mq.addEventListener('change', change); return () => mq.removeEventListener('change', change); }, []); return { ready, animate }; }
function Frame({ title, caveat, data, series, children, defaultTable = false, forceTable = false }: {
    defaultTable?: boolean;
    forceTable?: boolean;
    title: string;
    caveat?: string;
    data: Point[];
    series: Series[];
    children: ReactNode;
}) { const { t, locale } = useAdminCopy(); const [table, setTable] = useState(defaultTable); useEffect(() => { if (defaultTable)
    setTable(true); }, [defaultTable]); const xKey = data[0] && 'date' in data[0] ? 'date' : data[0] && 'day' in data[0] ? 'day' : 'label'; return <section className="pa-panel pa-chart"><header><h3>{title}</h3><Button variant="ghost" size="sm" aria-pressed={table || forceTable} disabled={forceTable} onClick={() => setTable(!table)}>{forceTable ? t("数据") : table ? t("查看图表") : t("查看数据")}</Button></header>{table || forceTable ? <div className="pa-table-wrap"><table className="pa-table"><caption>{title}{t("数据")}</caption><thead><tr><th>{t("日期 / 分类")}</th>{series.map(s => <th key={s.key} className="numeric">{s.label}</th>)}</tr></thead><tbody>{data.map((point, i) => <tr key={i}><td>{point[xKey]}</td>{series.map(s => <td key={s.key} className="numeric">{point[s.key] ?? '—'}</td>)}</tr>)}</tbody></table></div> : children}{!data.length && <p className="pa-caveat">{t("这个周期尚无数据。")}</p>}{caveat && <p className="pa-caveat">{caveat}</p>}</section>; }
function Crosshair() { const { t, locale } = useAdminCopy(); const coordinate = useActiveTooltipCoordinate(), area = usePlotArea(); if (!coordinate || !area)
    return null; return <g className="pa-crosshair" stroke="var(--line-strong)" strokeDasharray="3 3"><line x1={coordinate.x} x2={coordinate.x} y1={area.y} y2={area.y + area.height}/><line x1={area.x} x2={area.x + area.width} y1={coordinate.y} y2={coordinate.y}/></g>; }
function Legend({ series, colors }: {
    series: Series[];
    colors: string[];
}) { const { t, locale } = useAdminCopy(); return <ul className="pa-chart-legend">{series.map((s, i) => <li key={s.key}><span aria-hidden="true" style={{ background: s.color ?? colors[i] }}/>{s.label}</li>)}</ul>; }
export function LineTrend({ title, data, series, caveat }: {
    title: string;
    data: Point[];
    series: Series[];
    caveat?: string;
}) { const { t, locale } = useAdminCopy(); const { ready, animate } = useChartReady(); const colors = series.length === 1 ? ['var(--accent)'] : categorical; const xKey = data[0] && 'date' in data[0] ? 'date' : data[0] && 'day' in data[0] ? 'day' : 'label'; return <Frame {...{ title, data, series, caveat }} forceTable={series.length > 3}>{series.length > 3 ? <p className="pa-caveat">{t("系列较多，请切换数据表查看。")}</p> : <>{series.length > 1 && <Legend series={series} colors={colors}/>}<div className="pa-chart-body" role="img" aria-label={title}>{ready ? <ResponsiveContainer width="100%" height="100%" minWidth={0}><LineChart data={data} margin={{ top: 12, right: 24, bottom: 8, left: 0 }}><CartesianGrid stroke="var(--n-100)" vertical={false}/><XAxis dataKey={xKey} tick={{ fill: 'var(--ink-muted)', fontSize: 12 }} tickLine={false} axisLine={{ stroke: 'var(--line)' }}/><YAxis domain={[0, 'auto']} allowDecimals={false} tick={{ fill: 'var(--ink-muted)', fontSize: 12 }} tickLine={false} axisLine={false}/><Tooltip cursor={<Crosshair />} contentStyle={{ background: 'var(--surface)', borderColor: 'var(--line)', color: 'var(--ink)' }}/>{series.map((s, i) => <Line key={s.key} dataKey={s.key} name={s.label} stroke={colors[i]} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={animate} animationDuration={400} animationEasing="ease-out" type="linear"><LabelList dataKey={s.key} content={({ x, y, index }) => Number(index) === data.length - 1 && x !== undefined && y !== undefined ? <text x={Number(x) - 4} y={Number(y) - 10} textAnchor="end" fill="var(--ink-secondary)" fontSize={12}>{s.label}</text> : null}/></Line>)}</LineChart></ResponsiveContainer> : <div className="pa-chart-skeleton" aria-label={t("图表加载中")}/>}</div></>}</Frame>; }
export function BarRanking({ title, data, caveat }: {
    title: string;
    data: {
        label: string;
        value: number;
    }[];
    caveat?: string;
}) { const { t, locale } = useAdminCopy(); const { ready, animate } = useChartReady(); const sorted = [...data].sort((a, b) => a.label === t("其他") ? 1 : b.label === t("其他") ? -1 : b.value - a.value); return <Frame title={title} data={sorted} series={[{ key: 'value', label: t("数量") }]} caveat={caveat} forceTable={data.length > 8}><div className="pa-chart-body" role="img" aria-label={title}>{ready ? <ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart data={sorted.slice(0, 8)} layout="vertical" margin={{ left: 0, right: 38 }}><XAxis type="number" domain={[0, 'auto']} hide/><YAxis type="category" dataKey="label" width={100} tick={{ fill: 'var(--ink-secondary)', fontSize: 12 }} tickLine={false} axisLine={false}/><Tooltip cursor={{ fill: 'var(--surface-sunken)' }}/><Bar dataKey="value" name={t("数量")} fill="var(--accent)" maxBarSize={20} radius={[0, 4, 4, 0]} isAnimationActive={animate} animationDuration={400} animationEasing="ease-out" label={{ position: 'right', fill: 'var(--ink-secondary)', fontSize: 12 }}/></BarChart></ResponsiveContainer> : <div className="pa-chart-skeleton"/>}</div>{data.length > 8 && <p className="pa-caveat">{t("图中显示前 8 项；完整分类见数据表。")}</p>}</Frame>; }
export function StackedBars({ title, data, series, caveat }: {
    title: string;
    data: Point[];
    series: Series[];
    caveat?: string;
}) { const { t, locale } = useAdminCopy(); const { ready, animate } = useChartReady(); return <Frame {...{ title, data, series, caveat }} forceTable={series.length > 4}><Legend series={series} colors={stateColors}/><div className="pa-chart-body" role="img" aria-label={title}>{ready ? <ResponsiveContainer width="100%" height="100%" minWidth={0}><BarChart data={data} margin={{ top: 12, right: 16, left: 0, bottom: 8 }}><CartesianGrid stroke="var(--n-100)" vertical={false}/><XAxis dataKey={data[0] && 'date' in data[0] ? 'date' : data[0] && 'day' in data[0] ? 'day' : 'label'} tick={{ fill: 'var(--ink-muted)', fontSize: 12 }}/><YAxis domain={[0, 'auto']} allowDecimals={false} tick={{ fill: 'var(--ink-muted)', fontSize: 12 }}/><Tooltip cursor={{ fill: 'var(--surface-sunken)' }} formatter={(value, name, item) => { const row = item.payload as Point; const total = series.reduce((n, part) => n + Number(row[part.key] ?? 0), 0); return [`${value} (${total ? Math.round(Number(value) / total * 100) : 0}%)`, name]; }}/>{series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={s.label} stackId="result" fill={s.color ?? stateColors[i % 4]} maxBarSize={48} stroke="var(--surface)" strokeWidth={2} isAnimationActive={animate} animationDuration={400} animationEasing="ease-out"/>)}</BarChart></ResponsiveContainer> : <div className="pa-chart-skeleton"/>}</div></Frame>; }
export function ResultDonut({ title, data, caveat }: {
    title: string;
    data: {
        label: string;
        value: number;
        color?: string;
    }[];
    caveat?: string;
}) { const { t, locale } = useAdminCopy(); const { ready, animate } = useChartReady(); const total = data.reduce((n, p) => n + p.value, 0); const nonzero = data.filter(p => p.value > 0); if (nonzero.length < 3 || nonzero.length > 4 || nonzero.some(p => p.value / total < .05))
    return <BarRanking {...{ title, data, caveat }}/>; return <Frame title={title} data={data} series={[{ key: 'value', label: t("数量") }]} caveat={caveat}><Legend series={data.map(p => ({ key: p.label, label: `${p.label} ${p.value}`, color: p.color }))} colors={stateColors}/><div className="pa-chart-body" role="img" aria-label={`${title} ${t("记录总数")} ${total.toLocaleString(locale)}`}>{ready ? <ResponsiveContainer width="100%" height="100%" minWidth={0}><PieChart><Pie data={data} dataKey="value" nameKey="label" innerRadius={74} outerRadius={90} isAnimationActive={animate} animationDuration={400} animationEasing="ease-out" label={({ name, value }) => `${name} ${Math.round(Number(value) / total * 100)}%`} labelLine>{data.map((p, i) => <Cell key={p.label} fill={p.color ?? stateColors[i]}/>)}</Pie><text x="50%" y="50%" textAnchor="middle" fill="var(--ink)" fontSize={28} fontWeight={650}>{total}</text><text x="50%" y="60%" textAnchor="middle" fill="var(--ink-muted)" fontSize={12}>{t("记录总数")}</text><Tooltip /></PieChart></ResponsiveContainer> : <div className="pa-chart-skeleton"/>}</div></Frame>; }
export function RatioBar({ used, limit, zeroLabel = '上限为 0', meterLabel = '额度使用率' }: {
    used: number;
    limit: number;
    zeroLabel?: string;
    meterLabel?: string;
}) { const { t, locale } = useAdminCopy(); const ratio = limit > 0 ? Math.min(100, Math.max(0, used / limit * 100)) : 0; return <span className="pa-ratio"><span role="meter" aria-label={t(meterLabel)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={ratio}><i style={{ width: `${ratio}%`, background: (limit === 0 ? used > 0 : used >= limit) ? 'var(--status-conflict)' : ratio >= 90 ? 'var(--status-unknown)' : 'var(--accent)' }}/></span><small>{used.toLocaleString(locale)} / {limit.toLocaleString(locale)}{limit === 0 ? `（${t(zeroLabel)}）` : used >= limit ? t("（已达到上限）") : ratio >= 90 ? t("（接近上限）") : ''}</small></span>; }
