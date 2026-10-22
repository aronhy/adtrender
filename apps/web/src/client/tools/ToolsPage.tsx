import {Link,useParams} from 'react-router';
import {ArrowUpRight,Calculator,ChevronRight,Search,Sparkles,type LucideIcon} from 'lucide-react';
import {freeTools,readyFreeTools,getFreeTool} from './registry';
import {ToolLayout,ToolMeta} from './ToolLayout';
import {CalculatorTool} from './CalculatorTool';
import {HookTool} from './HookTool';
import {AdFinderTool} from './AdFinderTool';
import './tools.css';

const groups:Array<{id:string;title:string;description:string;icon:LucideIcon;category:string}>= [
 {id:'calculators',title:'成本与收益',description:'把假设填进来，把账算清楚。',icon:Calculator,category:'calculators'},
 {id:'creative',title:'广告开头',description:'从一个卖点，展开不同表达。',icon:Sparkles,category:'creative'},
 {id:'research',title:'广告研究',description:'从品牌或关键词开始查找。',icon:Search,category:'research'},
];
export function ToolsIndexPage() {
 return <main id="main-content" className="free-tools tools-index"><ToolMeta title="免费工具" description="免费使用 ROAS、利润、ROI、LTV 与 Shopify 成本计算器，生成广告 Hook，查找竞品广告。" path="/tools"/><div className="tool-content"><header className="tools-index-heading"><div><p className="tool-eyebrow">ADTRENDER / FREE TOOLS</p><h1>免费工具</h1><p>计算成本与收益，整理广告开头，开始竞品研究。</p></div><span className="tools-index-count"><strong>{String(readyFreeTools.length).padStart(2,'0')}</strong><span>项工具，无需登录</span></span></header><nav className="tool-category-nav" aria-label="工具分类">{groups.map(group=><a key={group.id} href={'#'+group.id}>{group.title}<ChevronRight size={14} aria-hidden="true"/></a>)}</nav><div className="tool-directory">{groups.map(group=>{const Icon=group.icon;return <section className="tool-directory-group" id={group.id} key={group.id}><header><Icon size={22} aria-hidden="true"/><h2>{group.title}</h2><p>{group.description}</p></header><ul>{readyFreeTools.filter(tool=>tool.category===group.category).map(tool=><li key={tool.slug}><Link to={'/tools/'+tool.slug}><div><h3>{tool.title}</h3><p>{tool.description}</p></div><ArrowUpRight size={21} aria-hidden="true"/></Link></li>)}</ul></section>;})}</div><section className="tools-planned"><header><h2>接下来</h2><p>以下工具尚未开放。</p></header><ul>{freeTools.filter(tool=>tool.status==='planned').map(tool=><li key={tool.slug}><span>{tool.title}</span><small>筹备中</small></li>)}</ul></section></div></main>;
}
function UnavailableTool({planned=false}:{planned?:boolean}) {
 return <main id="main-content" className="free-tools tool-unavailable"><title>{`${planned?'工具尚在筹备':'未找到这个工具'} · AdTrender`}</title><meta name="robots" content="noindex"/><div className="tool-content"><p className="tool-eyebrow">ADTRENDER / FREE TOOLS</p><h1>{planned?'这个工具还在筹备中。':'未找到这个工具。'}</h1><p>{planned?'先使用已开放的免费工具，继续你的计算与研究。':'链接可能已更改，请从工具目录重新选择。'}</p><Link className="button primary" to="/tools">返回免费工具 <ArrowUpRight size={16}/></Link></div></main>;
}
export function FreeToolPage() {
 const {slug=''}=useParams(),tool=getFreeTool(slug);
 if(!tool||tool.status!=='ready')return <UnavailableTool planned={tool?.status==='planned'}/>;
 return <ToolLayout key={tool.slug} tool={tool}>{tool.kind==='calculator'?<CalculatorTool slug={tool.slug}/>:tool.kind==='hooks'?<HookTool/>:<AdFinderTool/>}</ToolLayout>;
}
