import React,{useState,useRef,useEffect} from 'react';

const sample=[{id:'route',question:'这张工单应交给哪个部门处理？',options:[{id:'billing',description:'账单、支付与退款'},{id:'technical',description:'技术故障、报错与连接问题'},{id:'sales',description:'产品咨询、报价与购买'}]}];
export default function DecisionPlayground({routes}){
 const [criteria,setCriteria]=useState(JSON.stringify(sample,null,2)),[result,setResult]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),controller=useRef();
 useEffect(()=>()=>controller.current?.abort(),[]);
 async function submit(e){
  e.preventDefault();if(busy)return;setError('');setResult(null);
  const f=new FormData(e.currentTarget);let parsed;
  try{parsed=JSON.parse(criteria);}catch{setError('问题配置不是有效 JSON。');return;}
  controller.current=new AbortController();setBusy(true);
  try{const r=await fetch('/v1/decisions',{method:'POST',signal:controller.current.signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+f.get('key')},body:JSON.stringify({model:f.get('model'),state:f.get('state'),criteria:parsed})});const data=await r.json();if(!r.ok)throw Error(data.error?.message||'决策失败');setResult(data);}catch(e){setError(e.name==='AbortError'?'已停止等待；上游已开始的计算可能继续。':e.message);}finally{setBusy(false);}
 }
 return <div className="playground"><section className="panel"><h2>发起决策请求</h2><p className="hint">输入业务内容和候选选项，直接获取结构化结果。请先发布决策服务并创建授权 Key。</p><form onSubmit={submit}>
  <label className="field" htmlFor="decision-model"><span>逻辑模型</span></label><select id="decision-model" name="model" required><option value="">选择已发布的决策模型</option>{routes.filter(r=>r.enabled&&r.protocol==='decision').map(r=><option key={r.id} value={r.name}>{r.name}</option>)}</select>
  <label className="field">平台 API Key<input name="key" type="password" autoComplete="off" required/></label>
  <label className="field">业务内容<textarea name="state" rows={4} required defaultValue="我的订单被重复扣款，请帮我退回多扣的钱。"/></label>
  <label className="field">问题与选项（JSON）<textarea className="editor" rows={12} value={criteria} onChange={e=>setCriteria(e.target.value)} spellCheck={false}/></label>
  <p className="hint">1～8 个问题，每题 2～16 个选项。CPU 服务逐题计算；长文本会增加等待时间。</p>
  <button className="primary" disabled={busy}>{busy?'正在判断…':'发送决策请求'}</button>{busy&&<button type="button" onClick={()=>controller.current?.abort()}>停止等待</button>}
 </form></section><section className="panel" aria-live="polite"><h2>决策结果</h2>{error&&<div className="error" role="alert">{error}</div>}{!result&&<p>{busy?'CPU 模型正在计算选项概率…':'发送请求后，显示每个问题的选择与概率。'}</p>}{result&&<>
  <p className="hint">概率为候选选项内的相对分数，尚未校准，不能当作业务准确率。</p>
  {result.results.map(r=><section key={r.id}><h3>{r.id} → {r.winner}</h3>{r.ranked.map(p=><div key={p.id} className="decision-probability"><span>{p.id}</span><progress aria-label={r.id+' '+p.id+' 概率'} max="1" value={p.prob}/><strong>{(p.prob*100).toFixed(1)}%</strong></div>)}</section>)}
  <p>耗时 {result.latency_ms} ms · 输入 {result.usage?.prompt_tokens??'待核对'} Token · 输出 0 Token</p><details><summary>完整响应</summary><pre className="response">{JSON.stringify(result,null,2)}</pre></details>
 </>}</section></div>;
}
