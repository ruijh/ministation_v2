import React,{useEffect,useRef,useState} from 'react';
import {Plus} from 'lucide-react';

function Status({value,reason}){const ok=/^Running$/.test(value||'');const bad=/^Stopped$|^Failed$/.test(value||'');return <span className={'badge '+(ok?'good':bad?'bad':'neutral')}>{value}{reason&&<small> · {reason}</small>}</span>;}
function errorText(e){return e.message;}
function date(t){return t?new Date(t).toLocaleString('zh-CN',{hour12:false}):'—';}
function size(n){return n==null?'—':(n<1?Math.round(n*1024)+' MB':n.toFixed(1)+' GiB');}

function EngineHints({engines,model,models}){
 const selected=models?.find(m=>m.path===model);
 return <div className="hint">
  <p>引擎就绪：llama.cpp {engines?.llamacpp?.available?'✓ '+engines.llamacpp.path:'✗ 未找到（可设置 MINISTATION_LOCAL_LLAMACPP_BIN）'} · vLLM {engines?.vllm?.available?'✓ v'+engines.vllm.version:'✗ 未安装（pip install vllm）'}</p>
  {selected?.kind==='hf'&&<p>检测到 HuggingFace 模型目录（{selected.arch||selected.model_type}），请选择 <strong>vLLM</strong> 引擎。{selected.model_type==='deepseek_v4'?'DeepSeek-V4 为 fp8 MoE，CPU 可运行但较慢；装好 NVIDIA 驱动后把 GPU 数量填 1-2 以获得实机推理速度。':''}</p>}
  {selected?.kind==='gguf'&&<p>GGUF 模型（{selected.size_gib} GiB），请选择 <strong>llama.cpp</strong> 引擎。</p>}
 </div>;
}

function DetailCard({api,rec,setRec,onConnect,busy,setBusy,error,setError}){
 const [copied,setCopied]=useState(false);
 // 启动阶段自动刷新状态与日志，直到进入 Running / Stopped / Failed
 useEffect(()=>{if(rec.status!=='Starting')return;const t=setInterval(async()=>{try{setRec(await api('/local/'+rec.id));}catch(e){setError(errorText(e));}},3000);return()=>clearInterval(t);},[rec.status,api,rec.id]);
 async function run(fn){setBusy(true);setError('');try{await fn();}catch(e){setError(errorText(e));}finally{setBusy(false);}}
 async function copyCommand(){try{await navigator.clipboard.writeText(rec.command.join(' '));setCopied(true);setTimeout(()=>setCopied(false),1500);}catch(e){setError(errorText(e));}}
 return <section className="environment-card" aria-label="本机部署详情">
  <h3>本机引擎运行状态</h3>
  <p><Status value={rec.status} reason={rec.reason} /> · 端口 {rec.spec.port} · PID {rec.pid||'—'} · 启动于 {date(rec.started_at)}</p>
  <p className="hint">地址 {rec.base_url} · 引擎 {rec.spec.engine} · 模型 {rec.spec.model}</p>
  {error&&<p className="error" role="alert">{error}</p>}
  {rec.status==='Running'&&<button disabled={busy} onClick={()=>onConnect(rec)}>接入与发布</button>}
  <div className="row-actions">
   {rec.status==='Running'?<button disabled={busy} onClick={()=>run(async()=>{setRec(await api('/local/'+rec.id+'/stop',{}));})}>停止引擎</button>:<button disabled={busy} onClick={()=>run(async()=>{setRec(await api('/local/'+rec.id+'/start',{}));})}>启动引擎</button>}
   <button disabled={busy} onClick={()=>run(async()=>{setRec(await api('/local/'+rec.id+'/restart',{}));})}>重启</button>
   <button disabled={busy} onClick={()=>run(async()=>{setRec(await api('/local/'+rec.id));})}>刷新状态</button>
   <button className="danger" disabled={busy} onClick={()=>run(async()=>{await fetch('/api/local/'+rec.id,{method:'DELETE',headers:{'X-Ministation-Client':'console'}});setRec(null);})}>删除部署</button>
  </div>
  {rec.command&&<details><summary>实际启动命令{copied?'（已复制）':''}</summary><pre className="code">{rec.command.join(' ')}</pre>{rec.command&&<button disabled={busy} onClick={copyCommand}>复制启动命令</button>}</details>}
  {rec.log&&<details open><summary>引擎日志（最近 {rec.log.lines.length} 行）</summary><pre className="code">{rec.log.lines.join('\n')||'（暂无日志）'}</pre></details>}
 </section>;
}

// 列表行下的折叠控制台：启动/运行期间每 2.5s 自动刷新一次，展示最近日志与健康度，
// 启动失败时能看到真实错误过程（而非仅最终状态）。
function LocalConsole({api,id,status}){
 const [open,setOpen]=useState(true);
 const [detail,setDetail]=useState(null);
 const [error,setError]=useState('');
 useEffect(()=>{if(!open)return;let alive=true;const poll=async()=>{try{setDetail(await api('/local/'+id));}catch(e){if(alive)setError(errorText(e));}};poll();const t=setInterval(poll,2500);return()=>{alive=false;clearInterval(t);};},[open,id,api]);
 const d=detail,label=(d?.status||status)+(d?.status==='Starting'?'（启动中，自动刷新）':'');
 return <details open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
  <summary>启动 / 运行控制台 · {label}</summary>
  {error&&<p className="error" role="alert">{error}</p>}
  {d&&<p className="hint">状态 {d.status}{d.reason?` · ${d.reason}`:''}{d.healthy!=null?` · 健康检查 ${d.healthy?'通过':'未通过'}`:''}{d.pid?` · PID ${d.pid}`:''}{d.port?` · 端口 ${d.port}`:''}</p>}
  <pre className="code" style={{maxHeight:240,overflow:'auto',whiteSpace:'pre-wrap'}}>{(d?.log?.lines||[]).join('\n')||'（暂无输出，正在等待引擎日志…）'}</pre>
 </details>;
}

export function LocalDeploymentWizard({api,initial,fromTemplate,onSave,onConnect}){
 const baseName=p=>String(p||'').split('/').filter(Boolean).pop()||'';
 const [host,setHost]=useState(null),[env,setEnv]=useState(null),[engines,setEngines]=useState(null),[models,setModels]=useState([]),[modelVal,setModelVal]=useState(initial?.model||''),[engineVal,setEngineVal]=useState(initial?.engine||'llamacpp'),[created,setCreated]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[recommend,setRecommend]=useState(null),[recBusy,setRecBusy]=useState(false);
 const [servedVal,setServedVal]=useState(initial?.served_model||baseName(initial?.model)||'my-model');
 const [gpusVal,setGpusVal]=useState(initial?.gpus!=null?String(initial.gpus):'');
 const servedTouched=useRef(false);
 const engineTouched=useRef(false);
 // GPU 缺省 = 本机能力检测到的 GPU 数量（用户未改且未预填时才自动填入）
 useEffect(()=>{if(host?.gpu?.count!=null&&gpusVal===''&&initial?.gpus==null)setGpusVal(String(host.gpu.count));},[host]);
 useEffect(()=>{let active=true;Promise.all([api('/local/host'),api('/deployment-guide/environment?target=local'),api('/local/engines'),api('/local/models'),api('/models').catch(()=>[])]).then(([h,e,eg,m,im])=>{if(active){setHost(h);setEnv(e);setEngines(eg);const sc=m.models||[];const byPath=new Map(sc.map(x=>[x.path,x]));const imp=(im||[]).filter(x=>x.model_name).map(x=>{const ex=byPath.get(x.model_name);if(ex){ex.imported=true;return null;}return {path:x.model_name,name:x.name+(x.source==='local'?'（本地快照）':'（已导入）'),kind:/\.gguf$/i.test(x.model_name)?'gguf':null,size_gib:null,arch:null,model_type:null,max_ctx:null,imported:true};}).filter(Boolean);setModels([...imp,...sc]);}}).catch(e=>{if(active)setError(errorText(e));});return()=>{active=false;};},[api]);
 async function submit(f){const values=Object.fromEntries(new FormData(f));const payload={name:values.name,engine:values.engine,model:values.model,served_model:values.served_model,protocol:values.protocol,port:Number(values.port),gpus:Number(values.gpus)};if(Number(values.threads)>0)payload.threads=Number(values.threads);if(Number(values.max_model_len)>0)payload.max_model_len=Number(values.max_model_len);if(values.engine==='custom'){payload.command=(values.command||'').trim().split(/\s+/).filter(Boolean);payload.args=(values.args||'').trim().split(/\s+/).filter(Boolean);}const chosen=models?.find(m=>m.path===payload.model);if(values.engine!=='custom'&&chosen){if(chosen.kind==='hf'&&values.engine==='llamacpp'){setError('该模型是 HuggingFace 模型目录，请改用 vLLM 引擎（llama.cpp 仅支持 .gguf）');return;}if(chosen.kind==='gguf'&&values.engine==='vllm'){setError('该模型是 GGUF 文件，请改用 llama.cpp 引擎');return;}}const gpuAvail=host?.gpu?.count||0;if(payload.gpus>gpuAvail&&gpuAvail>0){setError(`GPU 数量 ${payload.gpus} 超过本机检测到的 ${gpuAvail} 卡；请先把其余 GPU 对控制面可见（nvidia-smi -L），或改为 ${gpuAvail}。`);return;}if(chosen?.size_gib&&payload.gpus>0&&host?.gpu?.memory_mib){const perCard=host.gpu.memory_mib/1024;const cap=perCard*payload.gpus;const need=chosen.size_gib*(payload.engine==='vllm'?1.15:1);if(need>cap){setError(`模型约 ${Math.round(chosen.size_gib)} GiB，${payload.engine==='vllm'?'bf16 加载约需':'约需'} ${Math.round(need)} GiB，超过本机可用显存 ${payload.gpus}×${Math.round(perCard)} GiB。请增加 GPU 数量，或改用 GGUF 量化版（llama.cpp 引擎）。`);return;}}setBusy(true);setError('');try{setCreated(await api('/local',payload));if(fromTemplate)try{await api('/templates/'+fromTemplate+'/use',{});}catch{}}catch(e){setError(errorText(e));}finally{setBusy(false);}}
async function applyRecommend(f){const el=n=>f.elements[n];const model=(el('model').value||'').trim();if(!model){setError('请先选择已导入模型版本，再应用推荐参数');return;}setRecBusy(true);setError('');try{const rec=await api('/local/recommend?model='+encodeURIComponent(model)+'&engine='+encodeURIComponent(el('engine').value)+'&gpus='+encodeURIComponent(el('gpus').value||'0'));for(const k of ['threads','max_model_len','gpus','parallel']){if(rec[k]!=null&&el(k)){el(k).value=String(rec[k]);if(k==='gpus')setGpusVal(String(rec.gpus));}}setRecommend(rec);}catch(e){setError(errorText(e));}finally{setRecBusy(false);}}
 return <div className="deployment-guide">
  <p>本机单机模式：MiniStation 直接在本机启动并管理一个 OpenAI 兼容推理引擎（llama.cpp / vLLM / 自定义命令），无需 Kubernetes。启动后接入发布即可通过统一网关调用。</p>
  {env&&<section className="environment-card" aria-label="本机能力"><h3>本机能力</h3><p><strong>{env.reason}</strong></p><p className="hint">推荐 CPU 起点：{env.recommendation.resources.cpu} CPU / {env.recommendation.resources.memory_gib} GiB。可用磁盘约 {host?.disk_free_gib??'未知'} GiB。</p><p className="hint">GPU：{env.host.gpu?`${env.host.gpu.count}×${env.host.gpu.model}（${env.host.gpu.memory_mib} MiB）`:'未检测到可用驱动（CPU 模式可用）'}</p></section>}
  {error&&<p className="error" role="alert">{error}</p>}
  {!created?<form onSubmit={e=>{e.preventDefault();submit(e.currentTarget);}}>
   <fieldset disabled={busy}><legend>模型与引擎</legend>
    <div className="form-grid"><div className="field"><label htmlFor="l-name">部署名称</label><input id="l-name" name="name" required maxLength={80} defaultValue={initial?.name||("本机 "+new Date().toISOString().slice(0,10))}/></div>
    <div className="field"><label htmlFor="l-engine">推理引擎</label><select id="l-engine" name="engine" value={engineVal} onChange={e=>{engineTouched.current=true;setEngineVal(e.target.value);}}><option value="llamacpp">llama.cpp（GGUF）</option><option value="vllm">vLLM（HF 模型目录）</option><option value="custom">自定义命令</option></select></div>
    <div className="field"><label htmlFor="l-model">已导入版本</label><select id="l-model" name="model" value={modelVal} required onChange={e=>{const v=e.target.value;setModelVal(v);const mw=models?.find(m=>m.path===v);if(mw&&engineVal!=='custom'&&mw.kind&&!engineTouched.current){setEngineVal(mw.kind==='hf'?'vllm':'llamacpp');}if(mw){const b=baseName(v).replace(/\.gguf$/i,'');if(b&&!servedTouched.current&&(!servedVal||servedVal==='my-model'))setServedVal(b);}}}><option value="">— 选择已导入模型版本 —</option>{models.filter(m=>m.imported).map(m=><option key={m.path} value={m.path}>{m.name}</option>)}{modelVal&&!models.some(m=>m.imported&&m.path===modelVal)&&<option value={modelVal}>{baseName(modelVal)}（已选，未在导入列表）</option>}</select>{models.filter(m=>m.imported).length<1&&<small className="hint">暂无已导入版本，请先在「模型资产 → 本机模型扫描→导入资产」导入。</small>}</div>
    <div className="field"><label htmlFor="l-served">对外模型名 <small>(主要改动项)</small></label><input id="l-served" name="served_model" value={servedVal} onChange={e=>{servedTouched.current=true;setServedVal(e.target.value);}} placeholder="客户端调用该模型时的名字" required/></div>
    <div className="field"><label htmlFor="l-port">监听端口</label><input id="l-port" name="port" type="number" min="1024" max="65535" defaultValue={initial?.port||"8080"} required/></div>
    <div className="field"><label htmlFor="l-threads">CPU 线程（可选）</label><input id="l-threads" name="threads" type="number" min="1" defaultValue={initial?.threads||''} placeholder="默认全部核心"/></div>
    <div className="field"><label htmlFor="l-gpus">GPU 数量</label><input id="l-gpus" name="gpus" type="number" min="0" max="16" value={gpusVal} onChange={e=>setGpusVal(e.target.value)}/><small className="hint">{(host?.gpu?.count!=null)?`本机检测到 ${host.gpu.count} 卡，已默认填入`:'未检测到 GPU（CPU 模式）'}</small></div>
    <div className="field"><label htmlFor="l-mll">最大上下文（可选）</label><input id="l-mll" name="max_model_len" type="number" min="256" defaultValue={initial?.max_model_len||''} placeholder="如 8192"/></div>
   </div><EngineHints engines={engines} models={models} model={modelVal} />
   {(()=>{const mm=models?.find(m=>m.path===modelVal);if(!mm||!mm.kind||engineVal==='custom')return null;const bad=(mm.kind==='gguf'&&engineVal==='vllm')||(mm.kind==='hf'&&engineVal==='llamacpp');if(!bad)return null;return <p className="hint" role="alert">⚠ 模型与引擎不匹配：{mm.kind==='gguf'?'该版本是 GGUF 文件，llama.cpp 更合适；如确要 vLLM 需换成非 GGUF 版本。':'该版本是 HuggingFace 目录，llama.cpp 仅支持 .gguf，请改用 vLLM。'}</p>;})()}
   {recommend&&Object.keys(recommend.notes||{}).length>0&&<p className="hint">推荐：{recommend.notes.join('；')}</p>}</fieldset>
   <fieldset disabled={busy}><legend>自定义命令参数（引擎=自定义时适用）</legend>
    <div className="form-grid"><div className="field"><label htmlFor="l-cmd">命令（空格分隔）</label><input id="l-cmd" name="command" defaultValue={initial?.command?.join(' ')||''} placeholder="node /opt/engine/server.mjs"/></div>
    <div className="field"><label htmlFor="l-args">附加参数（空格分隔）</label><input id="l-args" name="args" defaultValue={initial?.args?.join(' ')||''} placeholder="--port 8080"/></div></div></fieldset>
   <div className="form-actions"><button type="button" className="secondary" disabled={busy||recBusy} onClick={e=>applyRecommend(e.currentTarget.form)}>{recBusy?'计算中…':'应用推荐参数'}</button><button className="primary" disabled={busy}>{busy?'启动中…':'启动本机部署'}</button></div>
  </form>:<DetailCard api={api} rec={created} setRec={setCreated} onConnect={onConnect} busy={busy} setBusy={setBusy} error={error} setError={setError}/>}
 </div>;
}

export function LocalDeployments({api,admin,writable,onConnect,onCreate,onDiagnose}){
 const [rows,setRows]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[consoleId,setConsoleId]=useState(null);
 async function load(){setBusy(true);setError('');try{setRows(await api('/local'));}catch(e){setError(errorText(e));}finally{setBusy(false);}}
 useEffect(()=>{load();},[]);
 return <section className="panel"><div className="panel-title"><h2>本机部署</h2>{writable&&<button className="primary" onClick={onCreate||load}><Plus size={16}/>{onCreate?'新建部署':'刷新'}</button>}</div>
  <p className="hint">单机模式在本服务器上直接运行推理引擎（llama.cpp / vLLM / 自定义命令），无需 Kubernetes；启动后可通过“接入与发布”接入网关。</p>
  {error&&<p className="error" role="alert">{error}</p>}
  {!rows?<p role="status">{busy?'读取中…':'暂无记录'}</p>:!rows.length?<p>还没有本机部署。</p>:<div className="table-scroll"><table><thead><tr><th>服务</th><th>引擎 / 模型</th><th>端口</th><th>状态</th><th>操作</th></tr></thead><tbody>{rows.map(r=><React.Fragment key={r.id}><tr><td><strong>{r.name}</strong><small>{r.spec.engine}</small></td><td><small>{r.spec.model}</small></td><td>{r.spec.port}</td><td><Status value={r.status} reason={r.reason}/></td><td><div className="row-actions"><button className={consoleId===r.id?'active':''} onClick={()=>setConsoleId(consoleId===r.id?null:r.id)}>控制台</button>{onDiagnose&&<button title="打包完整引擎日志与主机/GPU/内存/磁盘信息为 zip，供分析或提交" onClick={()=>onDiagnose(r.id)}>分析</button>}{writable&&r.status==='Running'&&<button onClick={()=>onConnect(r)}>接入与发布</button>}{writable&&r.status==='Running'&&<button onClick={async()=>{await api('/local/'+r.id+'/stop',{});load();}}>停止</button>}{writable&&r.status!=='Running'&&<button onClick={async()=>{await api('/local/'+r.id+'/start',{});load();}}>启动</button>}{writable&&<button className="danger" onClick={async()=>{await fetch('/api/local/'+r.id,{method:'DELETE',headers:{'X-Ministation-Client':'console'}});load();}}>删除</button>}</div></td></tr>{consoleId===r.id&&<tr><td colSpan={5}><LocalConsole api={api} id={r.id} status={r.status}/></td></tr>}</React.Fragment>)}</tbody></table></div>}
  </section>;
}
