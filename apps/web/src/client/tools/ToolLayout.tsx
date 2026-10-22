import {useEffect,type ReactNode} from 'react';
import {Link} from 'react-router';
import {ArrowLeft,ArrowUpRight,LockKeyhole} from 'lucide-react';
import {customerAppOrigin} from '../app-surface';
import type {FreeTool} from './registry';
import './tools.css';

export function ToolMeta({title,description,path}:{title:string;description:string;path:string}) {
 useEffect(()=>{document.title=`${title} · AdTrender`;document.querySelector('meta[name="description"]')?.setAttribute('content',description);},[title,description]);
 return <><title>{`${title} · AdTrender`}</title><meta name="description" content={description}/><link rel="canonical" href={customerAppOrigin()+path}/></>;
}
export function ToolLayout({tool,children}:{tool:FreeTool;children:ReactNode}) {
 return <main id="main-content" className="free-tools tool-detail"><ToolMeta title={tool.title} description={tool.description} path={'/tools/'+tool.slug}/><div className="tool-content"><Link className="tool-back" to="/tools"><ArrowLeft size={15} aria-hidden="true"/>全部免费工具</Link><header className="tool-heading"><p className="tool-eyebrow">ADTRENDER / FREE TOOLS</p><h1 id="tool-title">{tool.title}</h1><p>{tool.description}</p><span className="tool-local-note"><LockKeyhole size={13} aria-hidden="true"/>免费使用，无需登录。输入仅在当前页面处理。</span></header><section className="tool-workspace" aria-labelledby="tool-title" data-clarity-mask="true">{children}</section><footer className="tool-bottom-note"><p>把计算与灵感，带回实际广告研究。</p><Link to="/app/ads">进入广告资料库 <ArrowUpRight size={15} aria-hidden="true"/><small>需登录</small></Link></footer></div></main>;
}
