import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter,Routes,Route} from 'react-router';
import {describe,it,expect,vi} from 'vitest';
vi.mock('../app-surface',()=>({customerAppOrigin:()=> 'https://adtrender.com'}));
import {ToolsIndexPage,FreeToolPage} from './ToolsPage';
import {readyFreeTools,freeTools} from './registry';
const render=(path:string)=>renderToStaticMarkup(createElement(MemoryRouter,{initialEntries:[path]},createElement(Routes,null,createElement(Route,{path:'/tools',element:createElement(ToolsIndexPage)}),createElement(Route,{path:'/tools/:slug',element:createElement(FreeToolPage)}))));
describe('anonymous public tools',()=>{
 it('lists all eight working tools and labels six future tools without fake links',()=>{const html=render('/tools');for(const tool of readyFreeTools)expect(html).toContain(`href="/tools/${tool.slug}"`);for(const tool of freeTools.filter(t=>t.status==='planned')){expect(html).toContain(tool.title);expect(html).not.toContain(`href="/tools/${tool.slug}"`);}expect(html).toContain('筹备中');expect(html).not.toContain('/help#free-tools');});
 it.each(readyFreeTools)('renders $slug without authentication or a workspace provider',tool=>{const html=render('/tools/'+tool.slug);expect(html).toContain(tool.title);expect(html).toContain('<form');expect(html).toContain('data-clarity-mask="true"');expect(html).not.toContain('正在读取广告数据');expect(html).not.toContain('Workspace context is required');});
 it.each(readyFreeTools)('renders server-readable metadata for $slug',tool=>{const html=render('/tools/'+tool.slug);expect(html).toContain(`<title>${tool.title} · AdTrender</title>`);expect(html).toContain(`rel="canonical" href="https://adtrender.com/tools/${tool.slug}"`);expect(html).toContain('name="description"');});
 it('does not carry financial or research query values into canonical links',()=>{const html=render('/tools/roi-calculator?returns=984325&token=secret#financial');expect(html).toContain('href="https://adtrender.com/tools/roi-calculator"');expect(html).not.toContain('984325');expect(html).not.toContain('token=');});
 it.each(['unknown','shopify-app-detector'])('shows a non-indexable unavailable route for %s',slug=>{const html=render('/tools/'+slug);expect(html).toContain('name="robots" content="noindex"');expect(html).toContain('返回免费工具');expect(html).not.toContain('<form');});
});
