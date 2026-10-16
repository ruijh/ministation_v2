import React,{useState,useEffect} from 'react';
import {DeploymentHealth} from './Operations.jsx';
import {DeploymentDiagnostics,ServiceOnboarding} from './DeploymentGuide.jsx';
export default function ServiceWorkspace({api,target,admin,writable,onDone}){
 const [tab,setTab]=useState('health'),[data,setData]=useState(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;setData(null);setError('');if(['diagnostics','logs'].includes(tab))api('/deployments/'+target.id+'/'+tab).then(d=>{if(active)setData(d);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[tab,api,target.id]);
 return <><div className="context-nav" role="group" aria-label="服务详情视图">{[['health','运行状态'],['diagnostics','诊断'],...(writable?[['logs','日志']]:[]),...(admin?[['connect','接入与发布']]:[])].map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>setTab(id)} disabled={!target.resource_name&&id!=='health'}>{label}</button>)}</div>{error&&<p role="alert" className="error">{error}</p>}{tab==='health'&&<DeploymentHealth api={api} target={target}/>} {tab==='connect'&&<ServiceOnboarding api={api} kind="deployment" id={target.id} onDone={onDone}/>} {['diagnostics','logs'].includes(tab)&&!data&&!error&&<p role="status">正在读取…</p>}{data&&tab==='diagnostics'&&<DeploymentDiagnostics value={data}/>} {data&&tab==='logs'&&<pre className="code">{data.text}</pre>}</>;
}
