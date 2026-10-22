import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { Activity, ArrowUpRight, Bell, BookOpen, ChevronRight, CircleHelp, CreditCard, Folders, Grid2X2, Layers, LayoutDashboard, LogOut, Menu, Moon, Package, Radar, Search, Settings, Store, Sun, Users, UserRound, X, GitCompareArrows } from 'lucide-react';
import type { AppState } from '../types';
import type { LucideIcon } from 'lucide-react';
import './studio-shell.css';
import { showFullSettings } from './settings-navigation';

type StudioNavItem = readonly [string,string,LucideIcon];
const groups: ReadonlyArray<{label:string;items:readonly StudioNavItem[]}> = [
  { label: '研究', items: [['/app/overview','数据总览',LayoutDashboard],['/app/ads','广告资料库',Search],['/app/advertisers','广告主',Store],['/app/products','推广商品',Package],['/app/compare','竞品对比',GitCompareArrows]] },
  { label: '持续观察', items: [['/app/tracking','品牌监控',Radar],['/app/activity','投放动态',Activity],['/app/notifications','通知中心',Bell]] },
  { label: '工作区', items: [['/app/collections','收藏夹',Folders],['/app/account','我的账户',UserRound],['/app/team','团队成员',Users],['/app/billing','方案与账单',CreditCard],['/app/settings','偏好设置',Settings]] },
];
const rail = [['/app/overview','工作台',Grid2X2],['/app/ads','探索',Search],['/app/tracking','监控',Radar],['/app/collections','收藏',Folders],['/app/account','我的',UserRound]] as const;
export function StudioShell({ state, contextHref, onWorkspaceChange, onSignOut, notice, onDismissNotice, children }: {
  state?: AppState; contextHref: (path: string) => string; onWorkspaceChange: (id: string) => void; onSignOut: () => void; notice?: string; onDismissNotice: () => void; children: ReactNode;
}) {
  const { pathname,search,hash } = useLocation(); const [open,setOpen]=useState(false);
  const [theme,setTheme]=useState(() => {try{return localStorage.getItem('adtrender.interface.theme')==='light'?'light':'dark';}catch{return 'dark';}});
  const panel=useRef<HTMLElement>(null),toggle=useRef<HTMLButtonElement>(null);
  const detailTitle = pathname.startsWith('/app/ads/') ? '广告详情' : pathname.startsWith('/app/advertisers/') ? '广告主详情' : pathname.startsWith('/app/products/') ? '商品详情' : pathname.startsWith('/app/collections/') ? '收藏夹详情' : undefined;
  const researchTitle = [['/app/channels','渠道研究'],['/app/landing','落地页研究'],['/app/research','收藏与研究笔记']].find(([path])=>pathname===path||pathname.startsWith(path+'/'))?.[1];
  const legacyTitle=pathname==='/app/settings'&&showFullSettings(search,hash)?'团队与设置':undefined;
  const title=legacyTitle||detailTitle||researchTitle||groups.flatMap(group=>group.items).find(([path])=>pathname===path||pathname.startsWith(path+'/'))?.[1]||'我的工作区';
  useEffect(()=>{setOpen(false);document.title=`${title} · AdTrender`;},[pathname,title]);
  useEffect(()=>{try{localStorage.setItem('adtrender.interface.theme',theme);}catch{/* Theme remains available for this session. */}},[theme]);
  useEffect(()=>{
    if(!open)return;const previous=document.activeElement;
    const nodes=()=>Array.from(panel.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),select:not([disabled])')||[]).filter(node=>node.getClientRects().length);
    nodes()[0]?.focus();const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);toggle.current?.focus();}if(event.key==='Tab'){const items=nodes(),first=items[0],last=items.at(-1);if(event.shiftKey&&(document.activeElement===first||!panel.current?.contains(document.activeElement))){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}};
    document.addEventListener('keydown',key);const overflow=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.removeEventListener('keydown',key);document.body.style.overflow=overflow;if(previous instanceof HTMLElement)previous.focus();};
  },[open]);
  const isRailActive=(path:string)=>path==='/app/ads'?['/app/ads','/app/advertisers','/app/products','/app/compare'].some(v=>pathname.startsWith(v)):path==='/app/account'?['/app/account','/app/team','/app/billing','/app/settings'].includes(pathname):pathname.startsWith(path);
  return <div className="studio-shell" data-theme={theme}>
    <a className="studio-skip" href="#main-content">跳到主要内容</a>
    <aside className="studio-rail" aria-label="主要导航"><Link className="studio-mark" to="/" aria-label="AdTrender 首页"><img src="/ui/assets/brand.svg" alt="" /></Link><nav>{rail.map(([path,label,Icon])=><Link key={path} to={contextHref(path)} className={isRailActive(path)?'active':''} aria-label={label} title={label}><Icon size={22}/><span>{label}</span></Link>)}</nav><div className="studio-rail-bottom"><Link to="/help" aria-label="帮助中心"><CircleHelp size={21}/><span>帮助</span></Link><button onClick={()=>setTheme(theme==='dark'?'light':'dark')} aria-label="切换深浅主题">{theme==='dark'?<Sun size={21}/>:<Moon size={21}/>}<span>外观</span></button><Link className="studio-avatar" to={contextHref('/app/account')} aria-label="我的账户">{(state?.user.displayName||state?.user.email||'我').slice(0,1).toUpperCase()}</Link></div></aside>
    {open&&<button className="studio-scrim" aria-label="关闭导航" onClick={()=>setOpen(false)}/>}
    <aside ref={panel} id="studio-navigation" className={`studio-local ${open?'is-open':''}`} role={open?'dialog':undefined} aria-modal={open||undefined} aria-label="工作区导航"><div className="studio-workspace"><span><Layers size={19}/></span><div><strong>{state?.selectedWorkspace?.name||'我的研究空间'}</strong>{state&&state.workspaces.length>1&&<select value={state.selectedWorkspace?.id||''} onChange={event=>onWorkspaceChange(event.target.value)} aria-label="切换工作区">{state.workspaces.map(workspace=><option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select>}</div><button className="studio-close" onClick={()=>setOpen(false)} aria-label="关闭导航"><X size={18}/></button></div>{groups.map(group=><nav className="studio-nav-group" key={group.label} aria-label={group.label}><p>{group.label}</p>{group.items.map(([path,label,Icon])=><NavLink to={contextHref(path)} key={path} onClick={()=>setOpen(false)}><Icon size={17}/>{label}</NavLink>)}</nav>)}<div className="studio-local-foot"><span>ADTRENDER WORKSPACE</span><p>看清竞争对手的广告，<br/>积累自己的创意与研究。</p><Link to={contextHref('/app/research')}>收藏与研究笔记 <ArrowUpRight size={14}/></Link><Link to={contextHref('/app/settings')+'#feedback'}>反馈与安全设置 <ArrowUpRight size={14}/></Link><button onClick={onSignOut}><LogOut size={14}/>退出登录</button></div></aside>
    <div className="studio-frame" inert={open||undefined}><header className="studio-topbar"><div className="studio-breadcrumb"><button ref={toggle} aria-controls="studio-navigation" aria-expanded={open} aria-label="打开工作区导航" onClick={()=>setOpen(true)}><Menu size={22}/></button><Link to={contextHref('/app/overview')}>我的工作区</Link><ChevronRight size={17}/><strong>{title}</strong></div><div className="studio-top-actions"><Link to="/help" className="studio-help"><BookOpen size={17}/>帮助中心</Link><Link to={contextHref('/app/ads')} aria-label="搜索广告"><Search size={22}/></Link><Link to={contextHref('/app/notifications')} aria-label="通知中心"><Bell size={21}/></Link></div></header><main id="main-content" className="studio-content" tabIndex={-1}>{notice&&<div className="studio-notice" role="status"><span>{notice}</span><button onClick={onDismissNotice} aria-label="关闭提示"><X size={16}/></button></div>}{children}</main></div>
  </div>;
}
