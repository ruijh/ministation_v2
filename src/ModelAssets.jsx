import React,{useEffect,useRef,useState} from 'react';
import {Plus,Trash2,RefreshCw,Download,Search,CheckCircle2,XCircle,FileType2,HardDrive,FolderOpen,AlertTriangle,Loader2,Edit2,Check,X,ArrowRight,Link2} from 'lucide-react';

const fmtGib=g=>g==null?'—':(Number(g).toFixed(1)+' GiB');
const num=n=>n==null?'—':Number(n).toLocaleString('zh-CN');

async function req(path,body,method){
 const q=path.startsWith('/api')?path:'/api'+path;
 const r=await fetch(q,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Ministation-Client':'console'},body:body==null?undefined:JSON.stringify(body)});
 const d=await r.json().catch(()=>({}));
 if(!r.ok)throw Object.assign(new Error(d.error?.message||'请求失败'),{code:d.error?.code});
 return d;
}
function FitBadge({fit}){if(!fit)return <Badge c="dull">未知</Badge>;if(fit.supported===true)return <Badge c="good">✓ 可运行</Badge>;if(fit.supported===false)return <Badge c="bad">✗ 不支持</Badge>;return <Badge c="dull">未知</Badge>;}
function Badge({c,children}){return <span className={'badge '+(c==='good'?'good':c==='bad'?'bad':'')}>{children}</span>;}

export async function streamSSE(path,body,handle){
 const resp=await fetch((path.startsWith('/api')?path:'/api'+path),{method:'POST',headers:{'Content-Type':'application/json','X-Ministation-Client':'console'},body:JSON.stringify(body)});
 if(!resp.ok){const d=await resp.json().catch(()=>({}));throw new Error(d.error?.message||'请求失败:'+resp.status);}
 if(!resp.body)throw new Error('响应不支持流式读取');
 const reader=resp.body.getReader(),dec=new TextDecoder();let buf='',finished=false;
 while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});
  let idx;while((idx=buf.indexOf('\n\n'))!==-1){const block=buf.slice(0,idx);buf=buf.slice(idx+2);const evt={};
   for(const l of block.split('\n')){if(l.startsWith('event:'))evt.event=l.slice(6).trim();else if(l.startsWith('data:')){try{evt.data=JSON.parse(l.slice(5));}catch{}}}
   handle(evt);if(evt.event==='done'||evt.event==='error')finished=true;}}
 return finished;
}

function ScanSection({writable,refresh,onGoDeploy}){
 const [roots,setRoots]=useState([]),[scan,setScan]=useState(null),[scanning,setScanning]=useState(false),
  [newRoot,setNewRoot]=useState(''),[err,setErr]=useState(''),[busy,setBusy]=useState(''),
  [editing,setEditing]=useState(null),[draft,setDraft]=useState('');
 async function loadRoots(){try{setRoots(await req('/api/materials/roots'));}catch(e){setErr(e.message);}}
 async function rescan(){setScanning(true);setErr('');try{setScan(await req('/api/materials/models'));}catch(e){setErr(e.message);}finally{setScanning(false);}}
 useEffect(()=>{loadRoots();rescan();},[]);
 async function addRoot(e){e.preventDefault();setBusy('add');try{await req('/api/materials/roots',{path:newRoot});setNewRoot('');await loadRoots();await rescan();}catch(e){setErr(e.message);}finally{setBusy('');}}
 async function removeRoot(id){setBusy(id);try{await req('/api/materials/roots/'+id,undefined,'DELETE');await loadRoots();await rescan();}catch(e){setErr(e.message);}finally{setBusy('');}}
 async function saveNote(path,desc){try{await req('/api/materials/model-note',{path,description:desc},'PUT');setEditing(null);}catch(e){setErr(e.message);}}
 async function toImport(m){try{await req('/api/materials/import',{path:m.path,description:m.description});await rescan();refresh();}catch(e){setErr(e.message);}}
 const host=scan?.host;const fitHint=host?.gpu?.count?`${host.gpu.count}×${(host.gpu.memory_mib/1024).toFixed(0)} GiB`:(host?.memory_gib?`内存 ${host.memory_gib} GiB`:'');
 return <section className="panel">
  <div className="panel-title"><h2>本机模型扫描</h2><button disabled={scanning} onClick={rescan}><RefreshCw size={14} className={scanning?'spin':''}/>重新扫描</button></div>
  <p className="hint">在这里添加模型目录，系统只识别目录下的一级子模型（含 config.json + 权重的 HF 目录，或 .gguf 文件）。已添加目录也会出现在「本机部署」的模型选择里。</p>
  {err&&<div role="alert" className="error">{err}</div>}
  <div className="env-steps" style={{flexDirection:'row',flexWrap:'wrap'}}>
   <span className="hint" style={{margin:0}}>扫描目录：</span>
   {(roots||[]).map(r=>r.is_dir?<span key={r.id||r.path} className="chip">{r.path}{r.source==='manual'&&<button className="icon" disabled={busy===r.id} onClick={()=>removeRoot(r.id)}><Trash2 size={13}/></button>}<small>{r.source==='env'?'(环境)':''}</small></span>:null)}
  </div>
  <form onSubmit={addRoot} style={{display:'flex',gap:8,padding:'0 22px 18px'}}>
   <input value={newRoot} onChange={e=>setNewRoot(e.target.value)} placeholder="/data/models（绝对路径）"/>
   <button className="primary" disabled={!newRoot.trim()||busy}><Plus size={15}/>添加目录</button>
  </form>
  <div className="table-scroll"><table><thead><tr><th>模型 / 路径</th><th>类型</th><th>规模</th><th>架构</th><th>上下文</th><th>GPU 适配 {fitHint&&<small>（{fitHint}）</small>}</th><th>描述</th><th>操作</th></tr></thead>
   <tbody>{scanning?<tr><td colSpan="8" className="hint">正在扫描…</td></tr>:scan?.models?.length?(scan.models).map(m=><tr key={m.path}><td><strong>{m.name}</strong><small>{m.path}</small></td>
    <td>{m.kind==='gguf'?<Badge>GGUF</Badge>:<Badge>HF</Badge>}</td>
    <td>{fmtGib(m.size_gib)}</td><td><strong>{m.arch||'—'}</strong><small>{m.model_type||''}</small></td><td>{m.max_ctx?num(m.max_ctx):'—'}</td>
    <td><FitBadge fit={m.fit}/><small>{m.fit?.reason}</small></td>
    <td>{editing===m.path?<div className="stack"><input value={draft} onChange={e=>setDraft(e.target.value)} autoFocus/><div className="row-actions"><button onClick={()=>saveNote(m.path,draft)}><Check size={13}/>保存</button><button onClick={()=>setEditing(null)}><X size={13}/>取消</button></div></div>:<small>{m.description||'—'}</small>}</td>
    <td><div className="row-actions"><button onClick={()=>{setEditing(m.path);setDraft(m.description||'');}}><Edit2 size={13}/>描述</button><button disabled={!writable} onClick={()=>toImport(m)}><Link2 size={13}/>导入资产</button><button onClick={()=>onGoDeploy()}><ArrowRight size={13}/>本机部署</button></div></td></tr>):<tr><td colSpan="8" className="hint">暂无扫描结果，请先添加模型目录。</td></tr>}</tbody></table></div>
 </section>;
}

function ModelScopeSection({writable,onImported}){
 const [data,setData]=useState(null),[loading,setLoading]=useState(false),[q,setQ]=useState(''),[onlyFit,setOnlyFit]=useState(true),
  [custom,setCustom]=useState(''),[err,setErr]=useState(''),[dir,setDir]=useState(''),[dirSaved,setDirSaved]=useState(false),
  [list,setList]=useState([]),[console,setConsole]=useState([]),[dling,setDling]=useState(false),[dlResult,setDlResult]=useState(''),[busyId,setBusyId]=useState('');
 async function loadCatalog(refresh){setLoading(true);setErr('');try{const d=await req('/api/materials/modelscope/catalog'+(refresh?'?refresh=1':''));setData(d);setList(d.models||[]);if(d.failed?.length)setErr(`${d.failed.length} 个模型查询失败（可能不存在或网络不通），可改为手动输入模型 ID。`);}catch(e){setErr(e.message);}finally{setLoading(false);}}
 useEffect(()=>{loadCatalog(false);req('/api/materials/modelscope/settings').then(s=>setDir(s.dir)).catch(()=>{});},[]);
 async function saveDir(){try{const s=await req('/api/materials/modelscope/settings',{dir},'POST');setDir(s.dir);setDirSaved(true);setTimeout(()=>setDirSaved(false),2000);}catch(e){setErr(e.message);}}
 async function inspect(){if(!custom.trim())return;setErr('');try{const m=await req('/api/materials/modelscope/inspect?model='+encodeURIComponent(custom.trim()));const fitted={...m,fit:m.fit,custom:true};setList(prev=>prev.some(x=>x.id===fitted.id)?prev:[fitted,...prev]);setCustom('');}catch(e){setErr(e.message||('查询失败：'+custom));}}
 const filtered=(list||[]).filter(m=>{if(onlyFit&&m.fit?.supported!==true)return false;if(!q)return true;const s=m.id+' '+(m.chinese||'')+(m.name||'');return s.toLowerCase().includes(q.toLowerCase());});
 const host=data?.host;const fitHint=host?.gpu?.count?`${host.gpu.count}×${(host.gpu.memory_mib/1024).toFixed(0)} GiB`:(host?.memory_gib?`内存 ${host.memory_gib} GiB`:'');
 async function download(m){setDling(true);setBusyId(m.id);setConsole([]);setDlResult('');try{const ok=await streamSSE('/api/materials/modelscope/download',{model:m.id},evt=>{if(evt.event==='stage'){setConsole(p=>[...p,{cls:'meta',text:`── ${evt.data.label||evt.data.stage} ──`}]);if(evt.data.status==='fail')setConsole(p=>[...p,{cls:'bad',text:'✗ '+evt.data.label}]);}else if(evt.event==='line')setConsole(p=>[...p,{cls:evt.data.text.startsWith('$')?'cmd':null,text:evt.data.text}]);else if(evt.event==='done'){setDlResult('success');setConsole(p=>[...p,{cls:'good',text:'✓ 下载完成：'+evt.data.dir}]);}else if(evt.event==='error'){setDlResult('fail');setConsole(p=>[...p,{cls:'bad',text:'✗ '+evt.data.message}]);}});if(!ok&&!console.length)setDlResult('fail');}catch(e){setDlResult('fail');setConsole(p=>[...p,{cls:'bad',text:'✗ '+e.message}]);}finally{setDling(false);setBusyId('');}}
 return <section className="panel">
 <div className="panel-title"><h2>ModelScope（魔搭）模型清单</h2> <div className="row-actions"><label className="inline-check"><input type="checkbox" checked={onlyFit} onChange={e=>setOnlyFit(e.target.checked)}/>只看本机可支持</label><button disabled={loading||dling} onClick={()=>loadCatalog(true)}><RefreshCw size={14} className={loading?'spin':''}/>刷新清单</button></div></div>
 <p className="hint">清单默认使用本机缓存{data?.updated_at?`（更新于 ${new Date(data.updated_at).toLocaleString('zh-CN')}）`:''}，只有点击“刷新清单”才会重新访问魔搭。按当前服务器资源（{fitHint||'无 GPU'}）自动筛选可落地的模型：不适配的模型不会提供下载入口。下载工具会自动安装到独立的 .venv-ms 环境，不污染 vLLM 环境。</p>
  {err&&<div role="alert" className="error">{err}</div>}
  <div className="stack" style={{margin:12}}>
   <div className="row-actions" style={{alignItems:'center'}}>
    <span className="hint" style={{margin:0}}>下载存放目录</span><input style={{maxWidth:420}} value={dir} onChange={e=>setDir(e.target.value)} placeholder="/home/.../Models"/>
    <button onClick={saveDir}><Check size={14}/>保存{dirSaved&&' ✓'}</button>
   </div>
   <form className="row-actions" onSubmit={e=>{e.preventDefault();inspect();}}>
    <input style={{maxWidth:360}} value={custom} onChange={e=>setCustom(e.target.value)} placeholder="自定义模型 ID，如 Qwen/Qwen2.5-7B-Instruct"/>
    <button type="submit" disabled={!custom.trim()}><Search size={14}/>查询并评估</button>
   </form>
  </div>
  {dling&&<div className="env-console" style={{height:200,margin:'0 22px 18px'}}>{console.map((l,i)=><div key={i} className={l.cls}>{l.text}</div>)}</div>}
  <div className="table-scroll"><table><thead><tr><th>模型 | 中文名</th><th>权重</th><th>架构 / 支持</th><th>热度</th><th>适配评估{fitHint&&<small>（{fitHint}）</small>}</th><th>下载</th></tr></thead>
   <tbody>{filtered.length?filtered.map(m=><tr key={m.id}><td><strong>{m.id}</strong><small>{m.chinese||m.description||''}</small></td>
    <td>{fmtGib(m.weights_gib)}{m.repo_gib?<small>仓库 {m.repo_gib.toFixed(0)} GiB</small>:null}</td>
    <td><strong>{m.architecture||'—'}</strong><small>{m.vllm_friendly?'vLLM 官方支持':'未知引擎支持'}</small></td>
    <td><small>下载 {num(m.downloads)} · Star {num(m.stars)}</small></td>
    <td><FitBadge fit={m.fit}/><small>{m.fit?.reason}</small></td>
    <td>{m.fit?.supported===true?<button className="primary" disabled={dling||busyId===m.id} onClick={()=>download(m)}><Download size={14}/>{dling&&busyId===m.id?'下载中…':'下载'}</button>:<button disabled title={m.fit?.reason||'当前服务器资源不支持'}>{dling?'下载中…':'不支持'}</button>}</td></tr>):<tr><td colSpan="6" className="hint">{loading?'正在从魔搭读取清单…':'没有匹配的模型，试试调整筛选或输入自定义模型 ID。'}</td></tr>}</tbody></table></div>
  <div className="stack" style={{padding:'0 22px 18px'}}>{dlResult==='success'&&<div role="status" className="notice">下载完成，可到「服务部署 → 本机部署」创建引擎使用。</div>}</div>
 </section>;
}

export default function ModelAssets({data,refresh,writable}){
 const imported=(data||[]);
 return <><ScanSection writable={writable} refresh={refresh} onGoDeploy={()=>{location.hash='deployments';}}/>
 <ModelScopeSection writable={writable} onImported={refresh}/>
 <section className="panel"><div className="panel-title"><h2>已导入模型版本</h2></div>
  <p className="hint">从「本机模型扫描」导入，或手动记录的模型版本；每个版本在本机部署时作为通配匹配用。</p>
  {imported.length?<div className="table-scroll"><table><thead><tr><th>名称</th><th>来源路径</th><th>任务</th><th>来源</th><th>创建时间</th>{writable&&<th>操作</th>}</tr></thead><tbody>{imported.map(r=><tr key={r.id}><td>{r.name}</td><td><small>{r.model_name}</small></td><td>{r.task||'chat'}</td><td>{r.source==='local'?'本地快照':'外部引用'}</td><td>{new Date(r.created_at).toLocaleString('zh-CN')}</td>{writable&&<td><div className="row-actions"><button className="danger" onClick={async()=>{if(!confirm('删除模型版本「'+r.name+'」？若已被某部署引用，后端会拒绝并提示先解除关联。'))return;try{await req('/api/models/'+r.id,undefined,'DELETE');refresh&&refresh();}catch(e){alert(e.message);}}}><Trash2 size={13}/>删除</button></div></td>}</tr>)}</tbody></table></div>:<div className="empty"><FolderOpen size={32}/><h3>尚未导入模型</h3><p>在「本机模型扫描」里点“导入资产”，或手动导入模型版本。</p></div>}</section></>;
}
