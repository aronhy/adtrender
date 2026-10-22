import {useEffect,useState} from 'react';
import {Image} from 'lucide-react';

type Props={url:string|null;advertiserName:string|null};
function ImageAttempt({url,advertiserName}:Props){
 const [attempt,setAttempt]=useState(0),[failed,setFailed]=useState(false);
 useEffect(()=>{
  if(!failed||attempt>=2)return;
  const timer=setTimeout(()=>{setFailed(false);setAttempt(value=>value+1);},750*(attempt+1));
  return ()=>clearTimeout(timer);
 },[failed,attempt]);
 if(!url)return <div className="studio-source-empty"><Image size={27}/><span>查看来源素材</span></div>;
 if(failed)return <div className="studio-source-empty" role="status"><Image size={27}/><span>{attempt<2?'正在重新加载素材…':'素材暂时加载失败'}</span>{attempt>=2&&<small>打开详情查看素材</small>}</div>;
 return <img key={attempt} src={url} alt={advertiserName?`${advertiserName} 广告素材`:'广告素材'} loading="lazy" onError={()=>setFailed(true)}/>;
}
/** Retry transient requests without changing signed media URLs. */
export function PublicAdImage(props:Props){return <ImageAttempt key={props.url||'empty'} {...props}/>;}
