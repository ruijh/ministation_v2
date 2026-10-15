import React,{useEffect,useState} from 'react';

const time=v=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'尚未观测';
const ms=v=>v==null?'—':`${Math.round(v)} ms`;
const percent=v=>v==null?'—':`${(v*100).toFixed(1)}%`;
export function ServiceMetrics({data}){
 const s=data.summary;
 return <><p className="hint">最近 {data.hours} 小时 · {data.scope}。待核对用量不等于调用失败；进程中断结果单独计为未知。更新时间：{time(data.generated_at)}</p>
 <div className="metrics">{[['请求数',s.requests,'当前窗口'],['错误率',percent(s.error_rate),`${s.failed} 次失败 / ${s.unknown} 次结果未知`],['P95 请求延迟',ms(s.p95_ms),'已结束请求的端到端延迟'],['P95 首 Token',ms(s.ttft_p95_ms),`${s.ttft_samples} 个有首 Token 记录的样本`]].map(([label,value,hint])=><div key={label}><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>)}</div>
 <section className="panel"><div className="panel-title"><h2>按逻辑模型统计</h2><span>窗口内仍在处理：{s.in_flight}</span></div>{data.models.length?<div className="table-scroll"><table><thead><tr>{['逻辑模型','请求数','失败 / 未知','错误率','P95 延迟','P95 首 Token'].map(v=><th key={v}>{v}</th>)}</tr></thead><tbody>{data.models.map(m=><tr key={m.model}><td>{m.model}</td><td>{m.requests}</td><td>{m.failed} / {m.unknown}</td><td>{percent(m.error_rate)}</td><td>{ms(m.p95_ms)}</td><td>{ms(m.ttft_p95_ms)}</td></tr>)}</tbody></table></div>:<p className="empty">当前时间窗口没有调用记录，指标不会填充模拟数据。</p>}</section>
 <section className="panel"><div className="panel-title"><h2>每小时请求趋势</h2></div><div className="request-trend">{data.buckets.map(b=><div key={b.start}><time>{new Date(b.start).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time><meter aria-label={`${time(b.start)} 请求数`} min="0" max={Math.max(1,...data.buckets.map(x=>x.requests))} value={b.requests}/><span>{b.requests} 次 / {b.failed} 失败</span></div>)}</div></section></>;
}
export function DeploymentHealth({api,target}){
 const [data,setData]=useState(null),[error,setError]=useState('');
 useEffect(()=>{let disposed=false,timeout;async function refresh(){try{const d=await api('/deployments/'+target.id+'/health');if(!disposed){setData(d);setError('');}}catch(e){if(!disposed)setError(e.message);}finally{if(!disposed)timeout=setTimeout(refresh,5000);}}refresh();return()=>{disposed=true;clearTimeout(timeout);};},[target.id]);
 const o=data?.observation;
 return <>{error&&<p className="error" role="alert">{error}</p>}{!data?<p>正在读取运行状态…</p>:<><div className="hint">后台约每 15 秒检查集群，每 5 秒刷新本视图。只读取容器状态，不发起模型调用。</div><dl><dt>当前阶段</dt><dd>{o?.stage||'等待后台首次观测'}</dd><dt>最近观测</dt><dd>{time(o?.checked_at)}</dd><dt>就绪副本 / 期望副本</dt><dd>{o?.ready_replicas??'—'} / {o?.desired_replicas??'—'}</dd><dt>模型协议验证</dt><dd>{data.conditions.ModelReady?'已验证':'尚未验证'}</dd><dt>目录发布</dt><dd>{data.conditions.EndpointReady?'已发布':'未发布'}</dd></dl>{o?.reason&&<p className="error">{o.reason}</p>}{o?.advice&&<p className="hint">{o.advice}</p>}<h3>状态变化时间线</h3>{data.events.length?<ol className="deployment-timeline">{data.events.map(e=><li key={e.id}><time>{time(e.created_at)}</time><strong>{e.stage}</strong>{e.reason&&<p>{e.reason}</p>}<small>{e.advice}</small></li>)}</ol>:<p>尚无状态变化记录；草稿保存后需先提交部署。</p>}</>}</>;
}
