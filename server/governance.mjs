import {z} from 'zod';
import {name,deploymentSchema,fail} from './domain.mjs';

const labels=z.record(z.string().min(1).max(253),z.string().max(63));
export const policySchema=z.object({allowed_registries:z.array(z.string().regex(/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/)).max(30).default([]),allowed_pool_ids:z.array(z.string()).max(100).default([]),require_pool:z.boolean().default(false),max_replicas:z.number().int().min(1).max(100).default(100),max_cpu:z.number().positive().max(1000).default(1000),max_memory_gib:z.number().positive().max(10000).default(10000),max_gpus:z.number().int().min(0).max(128).default(128),required_labels:labels.default({}),defaults:z.object({cpu:z.number().positive().optional(),memory_gib:z.number().positive().optional(),gpus:z.number().int().nonnegative().optional(),replicas:z.number().int().positive().optional(),pool_id:z.string().optional()}).default({})});
export const registry=image=>{const first=image.split('/')[0];return image.includes('/')&&(first.includes('.')||first.includes(':')||first==='localhost')?first:'docker.io';};
export function quantity(value){if(value==null)return 0;const m=String(value).match(/^([0-9.]+)([a-zA-Z]*)$/);if(!m)return NaN;const factors={n:1e-9,u:1e-6,m:1e-3,'':1,k:1e3,K:1e3,M:1e6,G:1e9,T:1e12,Ki:1024,Mi:1024**2,Gi:1024**3,Ti:1024**4};return Number(m[1])*(factors[m[2]]??NaN);}
const match=(selector,node)=>Object.entries(selector).every(([k,v])=>node.metadata?.labels?.[k]===v);
const resource=r=>({cpu:quantity(r?.cpu),memory_gib:quantity(r?.memory)/1024**3,gpus:quantity(r?.['nvidia.com/gpu'])});
const sum=(a,b)=>({cpu:a.cpu+b.cpu,memory_gib:a.memory_gib+b.memory_gib,gpus:a.gpus+b.gpus});
const zero=()=>({cpu:0,memory_gib:0,gpus:0});
export function podRequests(p){
 let total=(p.spec?.containers||[]).reduce((v,c)=>sum(v,resource(c.resources?.requests)),zero());
 // Restartable init containers remain resident alongside application containers.
 let sidecars=zero(),peak=zero();
 for(const c of p.spec?.initContainers||[]){const r=resource(c.resources?.requests);if(c.restartPolicy==='Always')sidecars=sum(sidecars,r);const stage=c.restartPolicy==='Always'?sidecars:sum(sidecars,r);for(const k of Object.keys(peak))peak[k]=Math.max(peak[k],stage[k]);}
 total=sum(total,sidecars);const podLevel=resource(p.spec?.resources?.requests);for(const k of Object.keys(total))total[k]=Math.max(total[k],peak[k],podLevel[k]);return sum(total,resource(p.spec?.overhead));
}
export function createGovernance(s,kube){
 const policy=project=>s.list('policy',project)[0]||policySchema.parse({});
 function prepare(raw,project){
  const p=policy(project),spec=deploymentSchema.parse({...p.defaults,...raw});
  if(spec.pool_id){const pool=s.get('pool',spec.pool_id,project);if(!pool)fail(422,'POOL_FORBIDDEN','资源池不存在或不属于当前项目');for(const [k,v] of Object.entries(pool.selector)){if(spec.node_selector[k]!==undefined&&spec.node_selector[k]!==v)fail(422,'POOL_SELECTOR_CONFLICT','节点选择器与资源池冲突');}spec.node_selector={...spec.node_selector,...pool.selector};}
  return spec;
 }
 function checks(spec,project){const p=policy(project);return [
  {name:'项目镜像策略',ok:!p.allowed_registries.length||p.allowed_registries.includes(registry(spec.image)),detail:'镜像仓库必须在项目允许列表内'},
  {name:'项目资源池策略',ok:(!p.require_pool||!!spec.pool_id)&&(!spec.pool_id||!!s.get('pool',spec.pool_id,project))&&(!p.allowed_pool_ids.length||p.allowed_pool_ids.includes(spec.pool_id)),detail:'资源池必须属于当前项目且获准使用'},
  {name:'项目资源上限',ok:spec.replicas<=p.max_replicas&&spec.cpu<=p.max_cpu&&spec.memory_gib<=p.max_memory_gib&&spec.gpus<=p.max_gpus,detail:`最多 ${p.max_replicas} 副本；每副本 ${p.max_cpu} CPU / ${p.max_memory_gib} GiB / ${p.max_gpus} GPU`},
  {name:'项目标签策略',ok:Object.entries(p.required_labels).every(([k,v])=>spec.labels?.[k]===v),detail:'必填标签：'+JSON.stringify(p.required_labels)},
  {name:'资源池标签',ok:!spec.pool_id||Object.entries(s.get('pool',spec.pool_id,project)?.selector||{}).every(([k,v])=>spec.node_selector[k]===v),detail:'部署节点选择器须匹配资源池'}];}
 function enforce(spec,project){const violations=checks(spec,project).filter(c=>!c.ok);if(violations.length)fail(422,'POLICY_REJECTED','部署不符合项目策略',violations);return spec;}
 function native(docs,project){const p=policy(project);for(const d of docs){const pod=d.kind==='CronJob'?d.spec?.jobTemplate?.spec?.template:d.spec?.template;if(!pod)continue;const poolId=pod.metadata?.annotations?.['ministation.io/pool-id'];const replicas=d.spec?.replicas??d.spec?.parallelism??d.spec?.jobTemplate?.spec?.parallelism??1;for(const c of [...(pod.spec.containers||[]),...(pod.spec.initContainers||[])]){const r=resource(c.resources?.limits);enforce({image:c.image,pool_id:poolId,replicas,cpu:r.cpu,memory_gib:r.memory_gib,gpus:r.gpus,labels:pod.metadata?.labels||{},node_selector:pod.spec.nodeSelector||{}},project);}const limits=c=>({...c,resources:{requests:c.resources?.limits}});const total=podRequests({spec:{...pod.spec,containers:pod.spec.containers.map(limits),initContainers:pod.spec.initContainers?.map(limits)}});enforce({image:pod.spec.containers[0].image,pool_id:poolId,replicas,cpu:total.cpu,memory_gib:total.memory_gib,gpus:total.gpus,labels:pod.metadata?.labels||{},node_selector:pod.spec.nodeSelector||{}},project);}return docs;}
 async function capacity(project){
  const pools=s.list('pool',project),p=s.get('project',project,'system');if(!kube.enabled)return {configured:false,pools,quota:{cpu:p.cpu_quota,memory_gib:p.memory_quota,gpus:p.gpu_quota},nodes:[],allocation_available:false};
  let nodes;try{nodes=(await kube.nodes()).items;}catch{return {configured:true,pools,quota:{cpu:p.cpu_quota,memory_gib:p.memory_quota,gpus:p.gpu_quota},nodes:[],allocation_available:false,allocation_error:'集群连接不可用；可继续管理资源池配置'};}let pods,allocationError=null;
  try{pods=(await kube.request('/api/v1/pods')).items;}catch{allocationError='缺少跨命名空间 Pod 读取权限；不估算全局剩余容量';}
  const rows=nodes.map(n=>{const allocatable=resource(n.status.allocatable);const requested=pods?pods.filter(p=>p.spec.nodeName===n.metadata.name&&!['Succeeded','Failed'].includes(p.status?.phase)).reduce((a,p)=>sum(a,podRequests(p)),zero()):null;return {name:n.metadata.name,labels:n.metadata.labels,ready:n.status.conditions?.some(c=>c.type==='Ready'&&c.status==='True'),cordoned:!!n.spec.unschedulable,taints:n.spec.taints||[],allocatable,requested,remaining:requested?Object.fromEntries(Object.keys(allocatable).map(k=>[k,Math.max(0,allocatable[k]-requested[k])])):null};});
  return {configured:true,quota:{cpu:p.cpu_quota,memory_gib:p.memory_quota,gpus:p.gpu_quota},allocation_available:!!pods,allocation_error:allocationError,nodes:rows,pools:pools.map(pool=>({...pool,nodes:nodes.filter(n=>match(pool.selector,n)).map(n=>n.metadata.name)})),note:'剩余值基于 Kubernetes requests；污点、亲和性、拓扑和资源碎片仍可能阻止调度。资源池可能重叠，不能相加。'};
 }
 return {policy,prepare,checks,enforce,native,capacity};
}
export function installGovernance(app,{s,kube,governance,write,audit}){
 app.get('/api/pools',(req,res)=>res.json(s.list('pool',req.project)));
 app.post('/api/pools',(req,res)=>{write(req,true);const v=z.object({name,description:z.string().max(1000).default(''),selector:labels.refine(v=>Object.keys(v).length>0,'至少一个节点标签')}).parse(req.body);const pool=s.put('pool',req.project,v.name,v);audit(req,'pool.create',pool.id);res.status(201).json(pool);});
 app.post('/api/pools/:id/delete',(req,res)=>{write(req,true);if(s.list('distributed',req.project).some(g=>g.status!=='Deleted'&&g.spec.pool_id===req.params.id)||s.list('deployment',req.project).some(d=>d.spec.pool_id===req.params.id)||s.list('template',req.project).some(t=>t.spec.pool_id===req.params.id)||governance.policy(req.project).allowed_pool_ids.includes(req.params.id)||governance.policy(req.project).defaults.pool_id===req.params.id)fail(409,'POOL_IN_USE','资源池仍被部署、模板或策略引用');if(!s.get('pool',req.params.id,req.project))fail(404,'NOT_FOUND','资源池不存在');s.remove('pool',req.params.id,req.project);audit(req,'pool.delete',req.params.id);res.json({ok:true});});
 app.get('/api/policy',(req,res)=>res.json(governance.policy(req.project)));
 app.post('/api/policy',(req,res)=>{write(req,true);const p=policySchema.parse(req.body);for(const id of [...p.allowed_pool_ids,...(p.defaults.pool_id?[p.defaults.pool_id]:[])])if(!s.get('pool',id,req.project))fail(422,'POOL_FORBIDDEN','策略包含无权访问的资源池');const old=s.list('policy',req.project)[0];if(old)z.number().int().positive().parse(req.body.version);const value=old?s.update('policy',old.id,req.project,p,req.body.version):s.put('policy',req.project,'项目部署策略',p);audit(req,'policy.update',value.id);res.json(value);});
 app.get('/api/capacity',async(req,res)=>{write(req,true);res.json(await governance.capacity(req.project));});
}
