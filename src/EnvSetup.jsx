import React,{useEffect,useRef,useState} from 'react';
import {CheckCircle2,XCircle,RefreshCw,Play,Loader2,AlertTriangle,HardDrive,FileCode2,Wrench,Server,Cpu,Boxes} from 'lucide-react';

// 环境初始化：把本机 GPU 服务器“从跑不起来到跑通”的前置步骤做成一个带动态 Console 的向导。
// 阶段（下载/安装/部署/配置/验证）由服务端预定义，这里只负责实时展示推流与状态。

const PHASE_LABEL={download:'下载',install:'安装',deploy:'部署',config:'配置',verify:'验证'};
const PHASE_COLOR={download:'#3b82f6',install:'#f59e0b',deploy:'#8b5cf6',config:'#06b6d4',verify:'#22c55e'};

function PlanCard({env}){
 if(!env)return null;
 const set=[['GPU','nvidia-smi',env.gpu_count>0?`${env.gpu_count}× ${env.gpu[0]||''}`:'未检测到（或驱动/权限不足）',env.gpu_count>0,HardDrive],
 ['CUDA 工具链','nvcc',env.cuda_ver?`${env.cuda_home} · ${env.cuda_ver}`:'未发现 /usr/local/cuda',!!env.cuda_ver,Server],
 ['ninja','Triton JIT 构建',env.ninja||'未安装',!!env.ninja,Wrench],
 ['Python 头文件','Triton 编译 cuda_utils.c',env.python_headers_path?'已安装 (Python.h)':'未安装（需 python3-devel）',!!env.python_headers,FileCode2],
 ['vLLM 运行环境','.venv-vllm',env.vllm_venv?`vLLM ${env.vllm_venv}`:'未安装',!!env.vllm_venv,Boxes],
 ['torch CUDA 可用','.venv-vllm',env.torch_cuda_available===true?'可用':'不可用（宿主机为准）',env.torch_cuda_available===true,Cpu],
 ['当前用户','root 与否',env.is_root?'root（可自动装系统包）':'非 root（systemd 阶段手动执行）',env.is_root,FileCode2],
 ['可用磁盘','df',env.disk_free_gib!=null?`${env.disk_free_gib} GiB`:'未知',true,HardDrive]];
 return <section className="panel settings"><div className="panel-title"><h2>运行环境检测</h2><small>{env.os}</small></div>
  <div className="env-grid">{set.map(([k, ,v,ok,i])=>{const I=i;return <div key={k} className={'env-item '+(ok?'ok':'warn')}><I size={20}/><div><strong>{k}</strong><small>{v}</small></div></div>;})}</div>
 </section>;
}

export default function EnvSetup(){
 const [plan,setPlan]=useState(null),[err,setErr]=useState(''),[selected,setSelected]=useState(null);
 const [status,setStatus]=useState({}),[lines,setLines]=useState([]),[running,setRunning]=useState(false),[result,setResult]=useState(''),[autoScroll,setAutoScroll]=useState(true);
 const box=useRef(null);
 async function load(){try{setErr('');setPlan(await ((await fetch('/api/env-plan')).json()));}catch(e){setErr(e.message);}}
 useEffect(()=>{load();},[]);
 useEffect(()=>{if(plan)setSelected(prev=>prev??new Set(plan.stages.map(s=>s.id)));},[plan]);
 useEffect(()=>{if(autoScroll&&box.current)box.current.scrollTop=box.current.scrollHeight;},[lines,autoScroll]);
 function toggle(id){setSelected(prev=>{const n=new Set(prev);n.has(id)?n.delete(id):n.add(id);return n;});}
 async function run(){
  if(!selected?.size||running)return;
  setRunning(true);setResult('');setStatus({});setLines([]);
  try{
   const resp=await fetch('/api/env-run',{method:'POST',headers:{'Content-Type':'application/json','X-Ministation-Client':'console'},body:JSON.stringify({stages:[...selected]})});
   if(!resp.ok){const d=await resp.json().catch(()=>({}));throw new Error(d.error?.message||'请求失败');}
   if(!resp.body){throw new Error('响应不支持流式读取');}
   const reader=resp.body.getReader();const dec=new TextDecoder();let buf='',finished=false;
   const handle=evt=>{
    if(!evt)return;
    if(evt.event==='stage'){const d=evt.data;if(!d)return;
     const label=PHASE_LABEL[d.phase]||d.phase;
     if(d.status==='start')setLines(p=>[...p,{stage:'meta',cls:'meta',text:`── [${label}] ${d.label} ──`}]);
     setStatus(prev=>({...prev,[d.stage]:d.status}));
     if(d.status==='ok'||d.status==='skip')setLines(p=>[...p,{stage:d.stage,cls:ok(d.status),text:ok(d.status)==='good'?'✓ 完成':'→ 已跳过'}]);
     if(d.status==='fail')setLines(p=>[...p,{stage:d.stage,cls:'bad',text:'✗ 失败：'+(d.text||'')}]);
    }
    else if(evt.event==='line'){const d=evt.data;if(d&&d.text)setLines(p=>[...p,{stage:d.stage,cls:d.text.startsWith('$ ')?'cmd':null,text:d.text}]);}
    else if(evt.event==='done'){finished=true;setResult('success');setLines(p=>[...p,{stage:'meta',cls:'good',text:'══ 环境初始化完成 ══'}]);}
    else if(evt.event==='error'){finished=true;setResult('fail');setLines(p=>[...p,{stage:'meta',cls:'bad',text:'✗ 初始化失败：'+(evt.data?.message||'未知错误')}]);}
   };
   while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});
    let idx;while((idx=buf.indexOf('\n\n'))!==-1){const block=buf.slice(0,idx);buf=buf.slice(idx+2);const evt={};
     for(const l of block.split('\n')){if(l.startsWith('event:'))evt.event=l.slice(6).trim();else if(l.startsWith('data:')){try{evt.data=JSON.parse(l.slice(5));}catch{} }}
     handle(evt);}}
   if(!finished)setResult('fail');
  }catch(e){setErr(e.message||'初始化失败');setResult('fail');}
  finally{setRunning(false);await load();}
 }
 function ok(st){return st==='ok'||st==='skip'?'good':st==='fail'?'bad':'';}
 const doneCount=plan?plan.stages.filter(s=>status[s.id]).length:0;
 return <section className="panel settings">
  <div className="panel-title"><h2>环境初始化（单机 GPU 服务器）</h2>
   <button onClick={load} disabled={running}><RefreshCw size={14}/>重新检测</button></div>
  <p className="hint">一键完成 MiniStation 本机部署所需的运行环境：系统依赖（Download/Install）、vLLM 虚拟环境（Install）、CUDA 工具链与 flashinfer JIT（Deploy）、启动脚本（Config）与最终自检（Verify）。全程目标机执行，控制台实时展示每一条命令与输出。</p>
  {err&&<div role="alert" className="error">{err}</div>}
  <PlanCard env={plan?.env}/>
  <section className="panel"><div className="panel-title"><h2>初始化步骤 <small>{selected?selected.size:0}/{plan?plan.stages.length:0} 项 · {doneCount} 已完成</small></h2></div>
   {plan?<div className="env-steps">{plan.stages.map(s=>{const st=status[s.id];const L=PHASE_LABEL[s.phase];return <label key={s.id} className={'env-step '+st}>
     <input type="checkbox" checked={(selected||new Set()).has(s.id)} onChange={()=>toggle(s.id)} disabled={running}/>
     <em style={{background:PHASE_COLOR[s.phase],color:'#fff'}}>{L}</em>
     <span><strong>{s.label}</strong><small>{s.skip?'（已就绪，执行时会自动跳过）':'（当前缺失，需要安装）'}</small></span>
     {st==='ok'&&<CheckCircle2 size={16} className="icon-good"/>}{st==='fail'&&<XCircle size={16} className="icon-bad"/>}{st==='skip'&&<CheckCircle2 size={16}/>}
    </label>;})}</div>:<p>正在检测…</p>}
   <div className="form-actions"><button className="primary" onClick={run} disabled={!selected?.size||running}>
     {running?<><Loader2 size={16} className="spin"/>正在初始化…</>:<><Play size={16}/>开始初始化运行环境</>}</button>
    <span className="hint">{result==='success'?'✅ 初始化成功，可前往「服务部署→本机部署」创建引擎':result==='fail'?'❌ 部分阶段失败，请按 Console 提示处理':''}</span></div>
  </section>
  <section className="panel"><div className="panel-title"><h2>执行控制台</h2><label className="inline-check"><input type="checkbox" checked={autoScroll} onChange={e=>setAutoScroll(e.target.checked)}/>自动滚动</label></div>
   <div className="env-console" ref={box}>
    {!lines.length?<div className="env-console-empty"><AlertTriangle size={18}/>尚未开始。点击“开始初始化运行环境”，这里会像终端一样逐行输出下载 → 安装 → 部署 → 配置 → 验证的各阶段日志。</div>
     :lines.map((l,i)=><div key={i} className={l.cls}>{l.text}</div>)}
   </div></section>
 </section>;
}
