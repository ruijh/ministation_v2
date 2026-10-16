import {distributedUsage} from './distributed.mjs';
import {fail} from './domain.mjs';

// A conservative starting point constrained by one real node and project limits.
// GPU memory/model compatibility is deliberately not inferred from GPU count.
export function recommendEnvironment(capacity,policy,remaining,selector={}){
 const matches=n=>Object.entries(selector).every(([k,v])=>n.labels?.[k]===v);
 const nodes=capacity.nodes.filter(matches);
 const visible=nodes.map(n=>({name:n.name,ready:n.ready,cordoned:n.cordoned,blocked_by_taints:n.taints.some(t=>['NoSchedule','NoExecute'].includes(t.effect)),allocatable:n.allocatable,remaining:n.remaining,hardware:{architecture:n.labels?.['kubernetes.io/arch']||null,gpu_model:n.labels?.['nvidia.com/gpu.product']||null,gpu_memory_mib:Number(n.labels?.['nvidia.com/gpu.memory'])>0?Number(n.labels['nvidia.com/gpu.memory']):null,source:'Kubernetes node labels; absent values are unknown'}}));
 let state='available',reason='',recommendation=null;
 if(!capacity.configured){state='unconfigured';reason='尚未接入推理集群。可以接入远程服务，或在高级配置中准备部署草稿。';}
 else if(!capacity.allocation_available){state='unknown';reason=capacity.allocation_error||'无法读取节点剩余容量，暂不生成资源推荐。';}
 else if(!nodes.some(n=>n.allocatable.gpus>0)){state='no_gpu';reason='目标范围未发现可分配的 NVIDIA GPU。建议接入远程服务；CPU 模型请使用已验证的自定义镜像。';}
 else if(remaining.gpus<1||policy.max_gpus<1){state='quota_blocked';reason='当前项目剩余 GPU 配额或策略不允许申请 GPU。请联系管理员调整，平台不会自动提高配额。';}
 else {
  const candidates=visible.filter(n=>n.ready&&!n.cordoned&&!n.blocked_by_taints&&n.remaining&&n.remaining.gpus>=1).map(n=>({node:n.name,cpu:Math.floor(Math.min(4,n.remaining.cpu,remaining.cpu,policy.max_cpu)*10)/10,memory_gib:Math.floor(Math.min(16,n.remaining.memory_gib,remaining.memory_gib,policy.max_memory_gib)*2)/2})).filter(n=>n.cpu>=0.1&&n.memory_gib>=2).sort((a,b)=>b.memory_gib-a.memory_gib||b.cpu-a.cpu||a.node.localeCompare(b.node));
  if(candidates.length){const c=candidates[0];recommendation={resources:{cpu:c.cpu,memory_gib:c.memory_gib,gpus:1,tensor_parallel:1,shared_memory_gib:0.5},example_node:c.node,reasons:['优先单卡、单副本，避免无依据地启用多卡或 PD。','CPU/内存同时受一个候选节点的剩余 requests、项目剩余配额和项目策略约束。'],confidence:'capacity_only'};}
  else {state='capacity_blocked';reason='没有单个可调度节点同时满足 GPU、CPU 和内存条件，或项目资源不足。';}
 }
 return {state,reason,nodes:visible,remaining_quota:remaining,recommendation,limitations:['未验证模型权重、KV Cache 显存、引擎镜像或驱动兼容性；资源起点不代表模型能装入显存。','容量为请求量快照，不是实时空闲显存，也不预留资源。部署前仍需预检。'],pd:{recommended:false,reason:'PD 需要模型显存、节点网络和负载测量，不能仅凭 GPU 数量推荐。'}};
}

export function installEnvironment(app,{s,kube,governance}){
 app.get('/api/deployment-guide/environment',async(req,res)=>{
  const policy=governance.policy(req.project),poolId=req.query.pool_id||policy.defaults.pool_id;
  if(poolId&&typeof poolId!=='string')fail(422,'INVALID_POOL','资源池无效');
  const pool=poolId?s.get('pool',poolId,req.project):null;
  if(poolId&&!pool)fail(404,'POOL_NOT_FOUND','资源池不存在或没有权限');
  if(poolId&&policy.allowed_pool_ids.length&&!policy.allowed_pool_ids.includes(poolId))fail(403,'POOL_FORBIDDEN','项目策略未允许该资源池');
  const p=s.get('project',req.project,'system'),used=distributedUsage(s,req.project);
  for(const d of s.list('deployment',req.project).filter(d=>!['Draft','Stopped','Failed'].includes(d.status))){const v=d.scaling_reservation||d.spec;used.cpu+=v.cpu*v.replicas;used.memory+=v.memory_gib*v.replicas;used.gpu+=v.gpus*v.replicas;}
  const remaining={cpu:Math.max(0,p.cpu_quota-used.cpu),memory_gib:Math.max(0,p.memory_quota-used.memory),gpus:Math.max(0,p.gpu_quota-used.gpu)};
  const capacity=await governance.capacity(req.project),result=recommendEnvironment(capacity,policy,remaining,pool?.selector||{});
  if(!poolId&&(policy.require_pool||policy.allowed_pool_ids.length)){result.state='pool_required';result.reason='请先选择项目允许的资源池，再生成资源推荐。';result.recommendation=null;result.nodes=[];}
  let volumes=[],volume_error=null;
  if(kube.enabled)try{volumes=(await kube.request(`/api/v1/namespaces/${p.namespace}/persistentvolumeclaims`)).items.map(v=>({name:v.metadata.name,phase:v.status?.phase||'Unknown',access_modes:v.spec?.accessModes||[]}));}catch{volume_error='无法读取项目模型卷；可在高级配置中手工填写，并通过预检确认。';}
  const templates=s.list('template',req.project).map(t=>{
   const v=t.spec,checks=governance.checks(v,req.project),quotaOK=v.cpu*v.replicas<=remaining.cpu&&v.memory_gib*v.replicas<=remaining.memory_gib&&v.gpus*v.replicas<=remaining.gpus;
   const fits=result.nodes.some(n=>n.ready&&!n.cordoned&&!n.blocked_by_taints&&n.remaining&&n.remaining.cpu>=v.cpu&&n.remaining.memory_gib>=v.memory_gib&&n.remaining.gpus>=v.gpus&&Object.entries(v.node_selector||{}).every(([k,val])=>capacity.nodes.find(x=>x.name===n.name)?.labels?.[k]===val));
   const volumeOK=!v.model_pvc||volumes.some(p=>p.name===v.model_pvc&&p.phase==='Bound');
   const state=!capacity.configured||!capacity.allocation_available||volume_error?'unknown':!quotaOK||checks.some(c=>!c.ok)||!fits||!volumeOK?'blocked':'candidate';
   return {id:t.id,name:t.name,state,reason:state==='candidate'?'满足当前单副本容量、总配额与策略检查；仍需验证模型、卷文件及多副本调度。':state==='unknown'?'环境信息不完整，需重新预检。':'当前容量、配额、策略或模型卷不满足，请调整后预检。'};
  });
  res.json({...result,templates,observed_at:new Date().toISOString(),scope:'target_cluster',pool_id:poolId||'',volumes,volume_error});
 });
}
