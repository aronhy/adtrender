// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {CopyResultButton} from './CopyResultButton';
let root:Root,host:HTMLDivElement;let original:PropertyDescriptor|undefined;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);original=Object.getOwnPropertyDescriptor(navigator,'clipboard');});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();if(original)Object.defineProperty(navigator,'clipboard',original);else delete(navigator as unknown as {clipboard?:unknown}).clipboard;vi.unstubAllGlobals();});
describe('tool clipboard feedback',()=>{
 it('copies the current result once and cannot submit its containing form',async()=>{const writeText=vi.fn(async()=>undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});await act(async()=>root.render(createElement(CopyResultButton,{text:'4.00 倍'})));expect(host.querySelector('button')!.type).toBe('button');await act(async()=>host.querySelector('button')!.click());expect(writeText).toHaveBeenCalledExactlyOnceWith('4.00 倍');expect(host.textContent).toContain('已复制');});
 it('keeps the result usable and explains when clipboard permission is denied',async()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn(async()=>{throw Error('denied');})}});await act(async()=>root.render(createElement(CopyResultButton,{text:'Result'})));await act(async()=>host.querySelector('button')!.click());expect(host.textContent).toContain('复制失败');expect(host.textContent).toContain('手动');expect(host.querySelector('button')!.disabled).toBe(false);});
 it('does not mark changed content copied after an older write finishes',async()=>{let resolve!:()=>void;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>new Promise<void>(r=>resolve=r)}});await act(async()=>root.render(createElement(CopyResultButton,{text:'Old'})));await act(async()=>host.querySelector('button')!.click());await act(async()=>root.render(createElement(CopyResultButton,{text:'New'})));await act(async()=>resolve());expect(host.textContent).not.toContain('已复制');});
});
