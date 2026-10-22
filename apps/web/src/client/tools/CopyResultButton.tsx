import {useEffect,useRef,useState} from 'react';
import {Check,Copy} from 'lucide-react';

export function CopyResultButton({text,label='复制结果',className=''}:{text:string;label?:string;className?:string}) {
 const [status,setStatus]=useState<'idle'|'copying'|'copied'|'failed'>('idle');
 const attempt=useRef(0),pending=useRef(false);
 useEffect(()=>{attempt.current++;pending.current=false;setStatus('idle');return()=>{attempt.current++;};},[text]);
 async function copy(){
  if(pending.current||!text)return;
  const ticket=++attempt.current;pending.current=true;setStatus('copying');
  try {
   if(!navigator.clipboard?.writeText)throw Error('CLIPBOARD_UNAVAILABLE');
   await navigator.clipboard.writeText(text);
   if(ticket===attempt.current)setStatus('copied');
  } catch {if(ticket===attempt.current)setStatus('failed');}
  finally {if(ticket===attempt.current)pending.current=false;}
 }
 return <span className="tool-copy-control"><button type="button" className={`button secondary tool-copy ${className}`} disabled={!text||status==='copying'} onClick={()=>void copy()}>{status==='copied'?<Check size={16} aria-hidden="true"/>:<Copy size={16} aria-hidden="true"/>}{status==='copying'?'正在复制…':status==='copied'?'已复制':label}</button><span role="status" aria-live="polite" className="tool-copy-feedback">{status==='failed'?'复制失败，请手动选择并复制。':status==='copied'?'内容已复制。':''}</span></span>;
}
