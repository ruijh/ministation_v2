import {z} from 'zod';
import {fail} from './domain.mjs';

const identifier=z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
const option=z.object({id:identifier,description:z.string().trim().min(1).max(1000)}).strict();
const criterion=z.object({id:identifier,question:z.string().trim().min(1).max(2000),options:z.array(option).min(2).max(16)}).strict().refine(c=>new Set(c.options.map(o=>o.id)).size===c.options.length,'选项 ID 必须唯一');
export const decisionSchema=z.object({model:z.string().min(1),state:z.union([z.string().trim().min(1).max(16000),z.record(z.string(),z.unknown()),z.array(z.unknown()).min(1)]),criteria:z.array(criterion).min(1).max(8)}).strict().refine(v=>new Set(v.criteria.map(c=>c.id)).size===v.criteria.length,'问题 ID 必须唯一').refine(v=>Buffer.byteLength(JSON.stringify(v.state))<=64000,'state 超过 64 KB').refine(v=>typeof v.state!=='object'||Object.keys(v.state).length>0,'state 不可为空');
export const decisionProbe={state:'用户请求退款。',criteria:[{id:'route',question:'应该由哪个部门处理？',options:[{id:'billing',description:'账单与退款'},{id:'technical',description:'技术故障'}]}]};
export function parseDecision(body){const parsed=decisionSchema.safeParse(body);if(!parsed.success)fail(422,'INVALID_DECISION',parsed.error.issues.map(i=>i.message).join('；'));return parsed.data;}
export function normalizeDecision(data,body){
 if(!Array.isArray(data?.results)||data.results.length!==body.criteria.length)fail(502,'PROTOCOL_MISMATCH','决策服务返回的问题数量不匹配');
 const ids=new Set();
 const results=data.results.map(r=>{
  const c=body.criteria.find(c=>c.id===r.id);
  if(!c||ids.has(r.id)||r.error||!Array.isArray(r.ranked)||r.ranked.length!==c.options.length)fail(502,'PROTOCOL_MISMATCH','决策结果缺失、重复或包含错误');
  ids.add(r.id);const choices=new Set();let sum=0;
  for(const p of r.ranked){if(!c.options.some(o=>o.id===p.id)||choices.has(p.id)||!Number.isFinite(p.prob)||p.prob<0||p.prob>1)fail(502,'PROTOCOL_MISMATCH','决策概率或选项无效');choices.add(p.id);sum+=p.prob;}
  const ranked=[...r.ranked].sort((a,b)=>b.prob-a.prob);
  if(Math.abs(sum-1)>0.0001||!choices.has(r.winner)||ranked.find(p=>p.id===r.winner).prob<ranked[0].prob)fail(502,'PROTOCOL_MISMATCH','决策概率未归一或选择结果不一致');
  return {id:r.id,winner:r.winner,ranked:ranked.map(p=>({id:p.id,prob:p.prob})),input_tokens:Number.isSafeInteger(r.input_tokens)&&r.input_tokens>=0?r.input_tokens:null};
 });
 // The adapter's input count is the sum of actual tokenized forward passes.
 const known=results.every(r=>r.input_tokens!==null);
 return {object:'decision',model:body.model,results,probability_status:'uncalibrated_option_probabilities',usage:known?{prompt_tokens:results.reduce((n,r)=>n+r.input_tokens,0),completion_tokens:0,total_tokens:results.reduce((n,r)=>n+r.input_tokens,0)}:undefined};
}

export async function handleDecision(g,req,res){
 const rid=req.requestId,started=Date.now(),abort=new AbortController();let k,b,body,reserved=false,usage=null,cost=null,route,release,completed=false,attemptRecorded=false,requestError=null;
 res.on('close',()=>{if(!res.writableEnded)abort.abort();});
 try{
  k=g.key((req.headers.authorization||'').replace(/^Bearer /i,''));body=parseDecision(req.body);
  if(!JSON.parse(k.models).includes(body.model))fail(403,'MODEL_FORBIDDEN','该 Key 未授权此模型');
  route=g.routes(k.project_id).find(r=>r.name===body.model);
  if(!route)fail(404,'MODEL_NOT_PUBLISHED','决策模型未发布或已下线');
  if(route.target_kind!=='backend')fail(422,'PROTOCOL_MISMATCH','决策接口只接受决策服务');
  b=g.traffic?g.traffic.choose(route,rid):g.s.get('backend',route.target_id,k.project_id);
  if(!b||b.status!=='EndpointValidated')fail(503,'BACKEND_UNAVAILABLE','决策服务未验证或不可用');
  if(b.protocol!=='decision')fail(422,'PROTOCOL_MISMATCH','请选择决策模型');
  const amount=body.criteria.reduce((n,c)=>n+Buffer.byteLength(JSON.stringify({state:body.state,...c}))*2+1024,0);
  release=g.traffic?.enter(route,rid);g.reserve(k,rid,amount,body.model);reserved=true;
  const result=g.traffic?await g.traffic.request(g,route,rid,b,body,abort.signal):{response:await g.upstream(b,body,abort.signal),backend:b};b=result.backend;const output=normalizeDecision(await result.response.json(),body);
  if(output.usage){usage={input:output.usage.prompt_tokens,output:0,cached:0};cost=Math.round(usage.input*b.input_rate);}
  g.settle(k,rid,usage,usage?'settled':'pending',{model:body.model,target:b.id,cost,rate:String(b.version),latency:Date.now()-started});reserved=false;
  completed=true;res.json({...output,id:rid,latency_ms:Date.now()-started});
 }catch(e){
  requestError=e.code||'DECISION_FAILED';attemptRecorded=!!e.trafficRecorded;if(e.actualBackend)b=e.actualBackend;
  if(reserved)g.settle(k,rid,usage,'pending',{model:body.model,target:b?.id,latency:Date.now()-started,error:e.code||'DECISION_FAILED',cost,rate:String(b?.version)});
  if(!res.headersSent&&!res.destroyed)res.status(e.status||502).json({error:{code:e.code||'DECISION_FAILED',message:e.status?e.message:'决策调用失败',request_id:rid}});
 }finally{abort.abort();release?.();if(route&&(reserved||completed)&&!attemptRecorded)g.traffic?.record(route,rid,b,completed?'settled':'failed',requestError,Date.now()-started);}
}
