import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {useLocation,useNavigate} from 'react-router';
import {getCustomerSnapshot,useQuery} from 'wasp/client/operations';

type Publication={snapshotId:string|null;asOf:string|null;enabled:boolean};
type SnapshotContext={snapshotId?:string;asOf?:string|null;enabled:boolean;href:(path:string)=>string;refresh:()=>Promise<unknown>;reportError:(error:unknown)=>void};
export function snapshotVersionUnavailable(error:unknown){return /SNAPSHOT_VERSION_UNAVAILABLE/.test(error instanceof Error?error.message:String(error??''));}
export function snapshotQueryScopeChanged(error:unknown){return /QUERY_SCOPE_CHANGED/.test(error instanceof Error?error.message:String(error??''));}
export function snapshotHref(path:string,snapshotId?:string){if(!snapshotId)return path;const url=new URL(path,'http://studio.invalid');url.searchParams.set('snapshot',snapshotId);return url.pathname+url.search+url.hash;}
const fallback:SnapshotContext={enabled:false,href:path=>path,refresh:async()=>undefined,reportError:()=>{}};
const CustomerSnapshotContext=createContext<SnapshotContext>(fallback);
export function useCustomerSnapshot(){return useContext(CustomerSnapshotContext);}
export function useSnapshotFailure(error:unknown){const {reportError}=useCustomerSnapshot();useEffect(()=>reportError(error),[error,reportError]);}

/** Resolve a publication before mounting readers. The URL and this mounted
 * session keep the chosen version even when a newer publication appears. */
export function CustomerSnapshotProvider({children}:{children:ReactNode}){
 const location=useLocation(),navigate=useNavigate();
 const query=useQuery(getCustomerSnapshot,{}, {refetchOnWindowFocus:false,refetchOnReconnect:false,staleTime:Infinity});
 const publication=query.data as Publication|undefined,pinned=useRef<string|undefined>(undefined);
 const requested=new URLSearchParams(location.search).get('snapshot')||undefined;
 const enabled=publication?.enabled===true;
 const snapshotId=enabled?(requested||pinned.current||publication?.snapshotId||undefined):undefined;
 if(enabled&&snapshotId)pinned.current=snapshotId;
 const currentLocation=useRef(location);currentLocation.current=location;
 const [unavailable,setUnavailable]=useState(false),[refreshing,setRefreshing]=useState(false);
 const reportError=useCallback((error:unknown)=>{
  if(snapshotVersionUnavailable(error))setUnavailable(true);
  if(snapshotQueryScopeChanged(error)){const current=currentLocation.current,params=new URLSearchParams(current.search);const hasPage=['cursor','page','eventCursor'].some(key=>params.has(key));if(hasPage){for(const key of ['cursor','page','eventCursor'])params.delete(key);navigate(current.pathname+(params.size?'?'+params:'')+current.hash,{replace:true});}}
 },[navigate]);
 useEffect(()=>{if(enabled&&snapshotId&&requested!==snapshotId)navigate(snapshotHref(location.pathname+location.search+location.hash,snapshotId),{replace:true});},[enabled,snapshotId,requested,location.pathname,location.search,location.hash,navigate]);
 const refresh=async()=>{
  setRefreshing(true);
  try{
   const result=await query.refetch();const current=result.data as Publication|undefined;
   if(!current||result.error)return;
   if(current.enabled&&!current.snapshotId)return;
   pinned.current=current.enabled?current.snapshotId||undefined:undefined;
   const params=new URLSearchParams(location.search);for(const key of ['snapshot','cursor','page','eventCursor'])params.delete(key);
   if(pinned.current)params.set('snapshot',pinned.current);
   navigate(location.pathname+(params.size?'?'+params:'')+location.hash,{replace:true});
   setUnavailable(false);
  }finally{setRefreshing(false);}
 };
 if(query.isLoading||!publication&&!query.error)return <div className="sa-loading" role="status">正在读取广告数据…</div>;
 if(query.error||unavailable||enabled&&!snapshotId)return <div className="sa-error" role="alert"><h3>{unavailable?'此版广告数据已不可用':'广告数据暂时无法加载'}</h3><p>{unavailable?'刷新以读取当前版本。':'请稍后重试，已保存的研究资料仍然保留。'}</p><button className="button secondary" disabled={refreshing} onClick={()=>void refresh()}>{refreshing?'正在刷新…':'刷新广告数据'}</button></div>;
 return <CustomerSnapshotContext.Provider value={{snapshotId,asOf:publication?.asOf,enabled,href:path=>snapshotHref(path,snapshotId),refresh,reportError}}>{children}</CustomerSnapshotContext.Provider>;
}
