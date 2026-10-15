import React,{useState} from 'react';
export default function PDOptions({presets,busy,topology,invalidate}){
 const [choice,setChoice]=useState('balanced'),[values,setValues]=useState({prefill_nodes:1,max_model_len:8192,prefill_batch:4096,decode_batch:2048,max_num_seqs:32,gpu_memory_utilization:0.85,timeout_seconds:120});
 const selected=presets.find(p=>p.id===choice),nodes=topology.nodes.split(',').map(n=>n.trim()).filter(Boolean),decode=nodes.length-values.prefill_nodes;
 const inputs=[['prefill_nodes','Prefill 节点数量',1,7,1],['max_model_len','最大上下文 Token',512,131072,1],['prefill_batch','Prefill 批次 Token 上限',512,32768,1],['decode_batch','Decode 批次 Token 上限',512,32768,1],['max_num_seqs','每实例最大序列数',1,256,1],['gpu_memory_utilization','GPU 显存使用比例',0.5,0.95,0.01],['timeout_seconds','请求超时（秒）',10,600,1]];
 return <section className="pd-options" aria-label="PD 参数指导">
  <h3>按场景选择调优起点</h3><p>这些组合未经硬件性能认证。先测量基线，再根据 TTFT、生成间隔和显存占用调整；普通网络或短请求可能更适合合并部署。</p>
  <div className="pd-presets">{presets.map(p=><button key={p.id} type="button" disabled={busy} aria-pressed={choice===p.id} onClick={()=>{invalidate();setChoice(p.id);setValues({...values,prefill_nodes:p.prefill,max_model_len:p.max_model_len,prefill_batch:p.prefill_batch,decode_batch:p.decode_batch,max_num_seqs:p.max_num_seqs,gpu_memory_utilization:p.gpu_memory_utilization});}}><strong>{p.label}</strong><span>{p.prefill}P + {p.decode}D</span><small>{p.description}</small></button>)}</div>
  <input type="hidden" name="pd_preset" value={choice}/>
  <div className="pd-summary" role="status"><strong>{nodes.length?`${values.prefill_nodes} Prefill → ${Math.max(0,decode)} Decode`:'填写下方节点名称后显示拓扑'}</strong><p>每实例 TP = {topology.gpus || 1}；总 GPU = {nodes.length*(Number(topology.gpus)||1)}。路由器额外占用首节点 0.5 CPU / 0.5 GiB。</p>{nodes.length>0&&decode<1&&<p className="error">至少保留一个 Decode 节点。</p>}{selected&&nodes.length!==selected.prefill+selected.decode&&<p>此预设建议 {selected.prefill+selected.decode} 个独立节点；当前填写 {nodes.length} 个，请按可用资源调整。</p>}</div>
  <p>节点列表的前 {values.prefill_nodes} 个用于 Prefill，其余用于 Decode。每个实例都必须独立容纳模型；增加 P/D 实例不会合并模型显存。首版保持两侧相同 TP、镜像和模型。</p>
  <div className="field"><label htmlFor="pd-router-image">PD 路由器镜像摘要（Node.js 24+）</label><input id="pd-router-image" name="pd_router_image" required disabled={busy} placeholder="registry/node@sha256:…"/><small>使用含 node 命令、支持非 root 用户的镜像。无需另行安装 npm 依赖。</small></div>
  <details><summary>调整参数与资源取舍{choice==='custom'?' · 已自定义':''}</summary><p>更大的上下文和并发通常需要更多 KV 显存；较大 Prefill 批次可能提升输入处理效率，也可能增加等待。先保留显存余量，再逐步提高并发。</p><div className="form-grid">{inputs.map(([key,label,min,max,step])=><div className="field" key={key}><label htmlFor={'pd-'+key}>{label}</label><input id={'pd-'+key} name={'pd_'+key} type="number" min={min} max={max} step={step} required disabled={busy} value={values[key]} onChange={e=>{setChoice('custom');setValues({...values,[key]:e.target.value===''?'':Number(e.target.value)});}}/></div>)}</div></details>
 </section>;
}
