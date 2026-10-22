import React,{useEffect,useRef,useState} from 'react';
import {Pin,Edit2,Trash2,Download,Upload,Play,Copy,Check,RefreshCw,LayoutTemplate,SlidersHorizontal} from 'lucide-react';

async function req(path,body,method){
const q=path.startsWith('/api')?path:'/api'+path;
 const r=await fetch(q,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Ministation-Client':'console'},body:body===undefined?undefined:JSON.stringify(body)});
 let d;try{d=await r.json();}catch{d=null;}
 if(!r.ok)throw Object.assign(new Error(d?.error?.message||'请求失败 HR'+r.status),{code:d?.error?.code});
 return d;
}
function fmtTime(s){if(!s)return '—';return new Date(s).toLocaleString('zh-CN');}
const varListToText=vs=>(vs||[]).map(v=>[v.key,(v.label||'').replace(/\n/g,' '),(v.required?'1':'0'),v.default??''].join('|')).join('\n');
function textToVarList(text){
 return String(text||'').split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{const p=l.split('|');return {key:p[0].trim(),label:(p[1]||'').trim(),required:p[2]==='1',default:p[3]!==undefined&&p[3]!==''?p[3]:undefined};});
}
// 客户端迷你渲染（用于内置模板；项目模板走服务端 /render 校验）
function clientRender(spec,declared,values){
 const missing=[];const val=k=>{const d=declared.find(x=>x.key===k);const v=values[k]!==undefined?values[k]:d?.default;if((d?.required??true)&&(v===undefined||v===''))missing.push(d?.label||k);return v==null?'':String(v);};
 const walk=v=>{if(typeof v==='string')return v.replace(/{{([A-Za-z0-9_.-]+)}}/g,(_,k)=>val(k));if(Array.isArray(v))return v.map(walk);if(v&&typeof v==='object'){const o={};for(const[k,x]of Object.entries(v))o[k]=walk(x);return o;}return v;};
 const out=walk(spec);if(missing.length)throw new Error('请填写模板参数：'+[...new Set(missing)].join('、'));
 return out;
}

function VariablesDialog({tpl,onClose,onDone}){
 const [values,setValues]=useState({});const [busy,setBusy]=useState(false);const [err,setErr]=useState('');
 const vs=tpl.variables||[];
 function setVar(key,val){setValues(s=>({...s,[key]:val}));}
 async function go(){
  setBusy(true);setErr('');
  try{
   let spec,id=tpl.id;
   if(tpl.builtin){spec=clientRender(tpl.spec,vs,values);}
   else{const r=await req('/api/templates/'+tpl.id+'/render',{values});spec=r.spec;id=tpl.id;}
   onDone({id,spec,scope:tpl.scope});
  }catch(e){setErr(e.message);}finally{setBusy(false);}
 }
 return <div className="modal"><div className="modal-card">
  <h2>{tpl.name} · 模板参数</h2>
  <p className="hint">填写模板参数后生成部署配置。带 * 为必填。</p>
  <div className="form-grid">
   {vs.map(v=><div className="field" key={v.key}><label htmlFor={'tv-'+v.key}>{v.label||v.key}{v.required?' *':''}</label><input id={'tv-'+v.key} defaultValue={v.default==null?'':v.default} placeholder={v.label||v.key} onChange={e=>setVar(v.key,e.target.value)}/></div>)}
   {!vs.length&&<p className="hint">此模板没有参数，直接生成配置。</p>}
  </div>
  {err&&<p className="error" role="alert">{err}</p>}
  <div className="form-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy} onClick={go}>{busy?'生成中…':'生成配置并创建'}</button></div>
 </div></div>;
}

function EditDialog({tpl,onClose,onSaved}){
 const [busy,setBusy]=useState(false),[err,setErr]=useState('');
 async function save(f){setBusy(true);setErr('');try{const fd=new FormData(f);await req('/api/templates/'+tpl.id,{name:fd.get('name')||tpl.name,description:fd.get('description')||'',pinned:fd.get('pinned')==='on',variables:textToVarList(fd.get('variables'))},'PUT');await onSaved();onClose();}catch(e){setErr(e.message);}finally{setBusy(false);}}
 return <div className="modal"><div className="modal-card"><h2>编辑模板 · {tpl.name}</h2>
  <form onSubmit={e=>{e.preventDefault();save(e.currentTarget);}}>
   <div className="form-grid">
    <div className="field"><label>模板名称</label><input name="name" defaultValue={tpl.name} required maxLength={100}/></div>
    <div className="field"><label>说明</label><input name="description" defaultValue={tpl.description||''} maxLength={1000}/></div>
   </div>
   <div className="field"><label><input type="checkbox" name="pinned" defaultChecked={!!tpl.pinned}/> 置顶显示</label></div>
   <div className="field"><label>参数（每行：键|说明|必填(1/0)|默认值）</label><textarea name="variables" rows={6} defaultValue={varListToText(tpl.variables)} className="mono"/></div>
   {err&&<p className="error" role="alert">{err}</p>}
   <div className="form-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy?'保存中…':'保存'}</button></div>
  </form>
 </div></div>;
}

function ImportDialog({onClose,onSaved,writable}){
 const [busy,setBusy]=useState(false),[err,setErr]=useState(''),[text,setText]=useState('');
 async function doImport(){
  setBusy(true);setErr('');
  try{
   const s=text.trim();if(!s)throw new Error('请粘贴 YAML 或 JSON');
   const body=s.startsWith('{')?{template:JSON.parse(s)}:{yaml:s};
   await req('/api/templates/import',body);await onSaved();onClose();
  }catch(e){setErr(e.message);}finally{setBusy(false);}
 }
 async function pickFile(e){const f=e.target.files?.[0];if(!f)return;setText(await f.text());}
 return <div className="modal"><div className="modal-card"><h2>导入部署模板（跨项目/跨平台共享）</h2>
  <p className="hint">粘贴从「导出」得到的 YAML（或 JSON 对象），或选择本机模板文件。导入到当前项目，重名自动加后缀。</p>
  <div className="row-actions"><label className="primary ghost"><Upload size={14}/>选择文件<input type="file" accept=".yaml,.yml,.json,.txt" style={{display:'none'}} onChange={pickFile}/></label></div>
  <textarea className="mono" rows={10} value={text} onChange={e=>setText(e.target.value)} placeholder="apiVersion: ministation.io/v1&#10;kind: DeploymentTemplate&#10;template:&#10;  name: ..."/>
  {err&&<p className="error" role="alert">{err}</p>}
  <div className="form-actions"><button type="button" onClick={onClose}>取消</button><button className="primary" disabled={busy||!text.trim()} onClick={doImport}>{busy?'导入中…':'导入'}</button></div>
 </div></div>;
}

export default function TemplatesPage({api,refresh,writable,onDeploy,onLocal}){
 const [rows,setRows]=useState([]),[cat,setCat]=useState([]),[busy,setBusy]=useState(''),[err,setErr]=useState(''),
  [dlg,setDlg]=useState(null); // {kind:'vars'|'edit'|'import'|'confirm', tpl, from}
 async function load(){setBusy('l');try{setRows(await req('/api/templates'));}catch(e){setErr(e.message);}finally{setBusy('');}}
 useEffect(()=>{load();req('/api/templates/catalog').then(c=>setCat(c.templates||[])).catch(e=>setErr(e.message));},[]);
 async function del(t){try{await req('/api/templates/'+t.id,undefined,'DELETE');setDlg(null);await load();}catch(e){setErr(e.message);}}
 async function pin(t){try{await req('/api/templates/'+t.id,{pinned:!t.pinned},'PUT');await load();if(dlg)setDlg(null);}catch(e){setErr(e.message);}}
 async function useTemplate(t,valuesDone){setDlg({kind:'vars',tpl:t});}
 function varsDone({id,spec,scope}){
  const ft=id||null;setDlg(null);
  if(scope==='local'){onLocal(spec,ft);}
  else{req('/api/models').then(models=>onDeploy(models,spec,ft)).catch(e=>setErr(e.message));}
 }
 async function copyBuiltin(t){try{await req('/api/templates/import',{template:{name:t.name,description:t.description,scope:t.scope,kind:t.kind,variables:t.variables||[],spec:t.spec}});await load();setErr('');}catch(e){setErr(e.message);}}
 async function exportTpl(t){try{const y=await req('/api/templates/'+t.id+'/export');const blob=new Blob([typeof y==='string'?y:JSON.stringify(y)],{type:'text/yaml'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=String(t.name||'template').replace(/[\\/:*?"<>|]+/g,'-')+'.yaml';a.click();}catch(e){setErr(e.message);}}
 const rowsSorted=[...rows].sort((a,b)=>(b.pinned?1:0)-(a.pinned?1:0));
 return <>
  <section className="panel">
   <div className="panel-title"><h2>项目部署模板</h2><div className="row-actions"><button disabled={busy==='l'} onClick={load}><RefreshCw size={14} className={busy==='l'?'spin':''}/>刷新</button>{writable&&<button onClick={()=>setDlg({kind:'import'})}><Upload size={14}/>导入模板</button>}</div></div>
   <p className="hint">模板 = 已验证部署的不可变快照：镜像摘要、启动参数、资源、挂载，以及可参数化的 {'{{变量}}'}。可用于重复创建、跨项目共享（导出 YAML / 导入），或直接使用下方内置模板。</p>
   {err&&<div role="alert" className="error">{err}</div>}
   <div className="table-scroll"><table><thead><tr><th>模板 / 说明</th><th>作用域</th><th>参数</th><th>版本 / 来源</th><th>使用</th><th>保存时间</th><th>操作</th></tr></thead>
    <tbody>{rowsSorted.length?rowsSorted.map(t=><tr key={t.id}><td><strong>{t.pinned?'📌 ':''}{t.name}</strong><small>{t.description||''}</small></td>
     <td>{t.scope==='local'?<span className="chip">本机</span>:<span className="chip">集群</span>}</td>
     <td><small>{t.variables?.length?t.variables.map(v=>v.key).join('、'):'固定配置'}</small></td>
     <td><small>{t.source_deployment?`来源 ${String(t.source_deployment).slice(0,8)} · 修订 ${t.source_revision}`:`模板 v${t.template_revision||1}${t.imported_from?'（导入）':''}`}</small></td>
     <td><small>{t.usage||0} 次</small></td><td><small>{fmtTime(t.verified_at||t.updated_at)}</small></td>
     <td><div className="row-actions"><button onClick={()=>setDlg({kind:'vars',tpl:{...t,builtin:false}})}><Play size={13}/>使用模板</button>{writable&&<><button onClick={()=>setDlg({kind:'edit',tpl:t})}><Edit2 size={13}/>编辑</button><button onClick={()=>pin(t)} title="置顶/取消置顶"><Pin size={13}/>{t.pinned?'取消置顶':'置顶'}</button><button onClick={()=>exportTpl(t)}><Download size={13}/>导出</button><button className="danger" onClick={()=>setDlg({kind:'confirm',tpl:t})}><Trash2 size={13}/>删除</button></>}</div></td></tr>):<tr><td colSpan="7" className="hint">暂无模板。可在「服务部署」中从已就绪服务保存模板，或从下方内置模板“复制到项目”。</td></tr>}</tbody></table></div>
  </section>
  <section className="panel">
   <div className="panel-title"><h2>内置模板（预置栈）</h2></div>
   <p className="hint">开箱即用的常用配方：本机部署（llama.cpp / vLLM / 自定义）直接预填向导；集群部署以变量填充镜像与资源（镜像需带 sha256 摘要）。本机配方与「环境初始化」联动。</p>
   <div className="entry-grid">
    {cat.map(c=><div className="template-card" key={c.id}><div className="template-card-head"><LayoutTemplate size={18}/><strong>{c.name}</strong><span className={'chip '+(c.scope==='local'?'':'')}>{c.scope==='local'?'本机':'集群'}</span></div>
     <p>{c.description}</p><small className="hint">参数：{c.variables.map(v=>v.key).join('、')||'无'}</small>
     <div className="row-actions" style={{marginTop:10}}>{writable&&<><button onClick={()=>copyBuiltin(c)}><Copy size={13}/>复制到项目</button></>}<button className="primary" onClick={()=>setDlg({kind:'vars',tpl:{...c,builtin:true}})}><Play size={13}/>使用此模板</button></div></div>)}
   </div>
  </section>
  {dlg?.kind==='vars'&&<VariablesDialog tpl={dlg.tpl} onClose={()=>setDlg(null)} onDone={varsDone}/>}
  {dlg?.kind==='edit'&&writable&&<EditDialog tpl={dlg.tpl} onClose={()=>setDlg(null)} onSaved={load}/>}
  {dlg?.kind==='import'&&writable&&<ImportDialog onClose={()=>setDlg(null)} onSaved={load}/>}
  {dlg?.kind==='confirm'&&writable&&<div className="modal"><div className="modal-card"><h2>删除模板 · {dlg.tpl.name}</h2><p className="hint">仅删除模板本身，不影响已从它创建的部署。</p><div className="form-actions"><button type="button" onClick={()=>setDlg(null)}>取消</button><button className="danger" disabled={busy} onClick={()=>del(dlg.tpl)}>删除</button></div></div></div>}
 </>;
}
