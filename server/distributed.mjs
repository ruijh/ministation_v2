import {z} from 'zod';
import {name,fail,deploymentManifest} from './domain.mjs';
import {id,now} from './store.mjs';
import {routeBackendIds} from './traffic.mjs';

const dns=z.string().regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/).max(63);
export const distributedSchema=z.object({
 name,engine:z.literal('sglang').default('sglang'),image:z.string().regex(/^[^\s]+@sha256:[a-f0-9]{64}$/),
 nodes:z.array(dns).min(2).max(8).refine(v=>new Set(v).size===v.length,'节点不能重复'),
 gpus_per_node:z.number().int().min(1).max(8),cpu:z.number().positive().max(1000),memory_gib:z.number().positive().max(10000),
 model_pvc:dns,model_path:z.string().regex(/^\/models(?:\/[a-zA-Z0-9_.-]+)*$/).refine(p=>!p.split('/').some(v=>v==='.'||v==='..'),'模型路径不能包含相对目录'),
 served_model:z.string().regex(/^[a-zA-Z0-9_.-]+$/).max(100),pool_id:z.string().optional(),labels:z.record(z.string(),z.string()).default({}),
}).strict();
export const groupSpec=v=>({name:v.name,kind:'llm',image:v.image,cpu:v.cpu,memory_gib:v.memory_gib,gpus:v.gpus_per_node,replicas:v.nodes.length,command:[],args:[],port:8000,health_path:'/health',model_pvc:v.model_pvc,model_mount:'/models',pool_id:v.pool_id,labels:v.labels,node_selector:{}});
export function distributedUsage(s,project,exclude){return s.list('distributed',project).filter(g=>g.id!==exclude&&g.status!=='Deleted').reduce((a,g)=>({cpu:a.cpu+g.spec.cpu*g.spec.nodes.length,memory:a.memory+g.spec.memory_gib*g.spec.nodes.length,gpu:a.gpu+g.spec.gpus_per_node*g.spec.nodes.length}),{cpu:0,memory:0,gpu:0});}
export function distributedManifests(v,namespace,prefix,nodeSelector={}){
 const group={'ministation.io/distributed':prefix},rankLabel='ministation.io/rank';
 const rendezvous=prefix+'-rendezvous',address=rendezvous+'.'+namespace+'.svc';
 const services=[{apiVersion:'v1',kind:'Service',metadata:{name:rendezvous,namespace},spec:{clusterIP:'None',publishNotReadyAddresses:true,selector:{...group,[rankLabel]:'0'},ports:[{name:'rendezvous',port:20000,targetPort:20000}]}},{apiVersion:'v1',kind:'Service',metadata:{name:prefix,namespace},spec:{type:'ClusterIP',selector:{...group,[rankLabel]:'0'},ports:[{name:'http',port:8000,targetPort:8000}]}}];
 const deployments=v.nodes.map((node,rank)=>{
  const [d]=deploymentManifest({...groupSpec(v),replicas:1,node_selector:{...nodeSelector,'kubernetes.io/hostname':node}},namespace,prefix+'-'+rank);
  d.spec.strategy={type:'Recreate'};d.spec.template.metadata.labels={...d.spec.template.metadata.labels,...group,[rankLabel]:String(rank)};
  if(v.pool_id)d.spec.template.metadata.annotations={'ministation.io/pool-id':v.pool_id};
  const pod=d.spec.template.spec;delete pod.topologySpreadConstraints;
  pod.terminationGracePeriodSeconds=60;
  pod.volumes.push({name:'shm',emptyDir:{medium:'Memory',sizeLimit:`${Math.min(1,v.memory_gib/4)}Gi`}});
  const c=pod.containers[0];c.command=['python3','-m','sglang.launch_server'];
  c.args=['--model-path',v.model_path,'--served-model-name',v.served_model,'--tp-size',String(v.nodes.length*v.gpus_per_node),'--nnodes',String(v.nodes.length),'--node-rank',String(rank),'--dist-init-addr',address+':20000','--host','0.0.0.0','--port','8000'];
  c.env=[{name:'HF_HUB_OFFLINE',value:'1'},{name:'TRANSFORMERS_OFFLINE',value:'1'},{name:'HF_HOME',value:'/tmp/huggingface'}];
  c.volumeMounts.push({name:'shm',mountPath:'/dev/shm'});c.ports.push({name:'rendezvous',containerPort:20000});
  if(rank){delete c.startupProbe;c.readinessProbe={exec:{command:['python3','-c',`import urllib.request; urllib.request.urlopen('http://${address}:8000/health',timeout=2).close()`]},periodSeconds:10,timeoutSeconds:3};}
  return d;
 });
 return [...services,...deployments].map(d=>({...d,metadata:{...d.metadata,labels:{...d.metadata.labels,...group,'app.kubernetes.io/managed-by':'ministation-distributed'}}}));
}
export function installDistributed(app,{s,kube,governance,checkDeployment,get,write,audit,traffic}){
 const locks=new Set();let timer,busy;
 const save=(g,patch)=>s.update('distributed',g.id,g.project_id,patch);
 function published(g){const bids=s.list('backend',g.project_id).filter(b=>b.distributed_id===g.id).map(b=>b.id);const contains=n=>bids.includes(n?.backend_id)||n?.children?.some(contains);return s.list('route',g.project_id).some(r=>r.enabled&&(r.target_kind==='backend'?routeBackendIds(r).some(b=>bids.includes(b)):contains(s.get('flow',r.target_id,g.project_id)?.graph)));}
 async function plan(raw,req,exclude){
  const v=distributedSchema.parse(raw),spec=governance.enforce(governance.prepare(groupSpec(v),req.project),req.project);
  const check=checkDeployment(spec,req,exclude);if(!check.valid)fail(422,'PREFLIGHT_FAILED','分布式模型组预检未通过',check.checks);
  const p=s.get('project',req.project,'system'),capacity=await governance.capacity(req.project);
  if(!capacity.allocation_available)fail(422,'CAPACITY_UNKNOWN','必须能读取全局 Pod 申请量后再启动分布式模型组');
  for(const node of v.nodes){const n=capacity.nodes.find(n=>n.name===node);if(!n||!n.ready||n.cordoned||n.taints.some(t=>['NoSchedule','NoExecute'].includes(t.effect))||n.labels['kubernetes.io/hostname']!==node||!Object.entries(spec.node_selector).every(([k,val])=>n.labels[k]===val)||n.remaining.cpu<v.cpu||n.remaining.memory_gib<v.memory_gib||n.remaining.gpus<v.gpus_per_node)fail(422,'NODE_UNAVAILABLE','节点不可用、不满足资源池或剩余资源不足',{node});}
  const pvc=await kube.request(`/api/v1/namespaces/${p.namespace}/persistentvolumeclaims/${v.model_pvc}`);
  if(pvc.status?.phase!=='Bound'||!(pvc.spec?.accessModes||[]).some(m=>['ReadOnlyMany','ReadWriteMany'].includes(m)))fail(422,'SHARED_MODEL_REQUIRED','模型卷必须已绑定且支持 ReadOnlyMany 或 ReadWriteMany');
  await kube.assertQuota(p.namespace);
  return {spec:v,namespace:p.namespace,node_selector:spec.node_selector,total:{nodes:v.nodes.length,gpus:v.nodes.length*v.gpus_per_node,cpu:v.nodes.length*v.cpu,memory_gib:v.nodes.length*v.memory_gib},warnings:['实验性 SGLang TP 编排；没有 GPU 推理实测认证。','容量检查不是资源预留或 gang scheduling；并发原生工作负载仍可能占用资源。','需要跨 Pod 通信、兼容的 GPU/驱动/引擎及相同模型文件；不自动开启 hostNetwork、RDMA 或特权模式。']};
 }
 async function inspect(g){
  const members=[];let ready=g.manifests.length===g.spec.nodes.length+2&&g.resources.length===g.manifests.length,error=ready?null:'创建记录不完整，需要人工核对或清理';
  try{for(const m of g.manifests){const actual=await kube.request(kube.path(m)+'/'+m.metadata.name),owned=g.resources.find(r=>r.name===m.metadata.name&&r.kind===m.kind);if(!owned||actual.metadata.uid!==owned.uid)fail(409,'OWNERSHIP_CHANGED','资源 UID 不匹配，需要人工核对');if(m.kind==='Deployment'){const ok=actual.status?.observedGeneration>=actual.metadata.generation&&actual.status?.availableReplicas===1;ready&&=ok;members.push({name:m.metadata.name,rank:Number(m.spec.template.metadata.labels['ministation.io/rank']),node:m.spec.template.spec.nodeSelector['kubernetes.io/hostname'],ready:ok,conditions:actual.status?.conditions||[]});}}}catch(e){ready=false;error=e.message;}
  const status=ready?'Ready':error?'NeedsAttention':'Starting';
  if(!ready)for(const b of s.list('backend',g.project_id).filter(b=>b.distributed_id===g.id&&b.status==='EndpointValidated'))s.update('backend',b.id,g.project_id,{status:'Unverified',reason:'分布式模型组未就绪'});
  if(g.status!==status)s.audit(g.project_id,'distributed-observer','distributed.state',g.id,{from:g.status,to:status});
  return save(g,{status,members,error,checked_at:now()});
 }
 async function refresh(g){g=s.get('distributed',g.id,g.project_id);if(!g||locks.has(g.id)||['Deleted','Deleting','Creating'].includes(g.status))return g;locks.add(g.id);try{return await inspect(g);}finally{locks.delete(g.id);}}
 app.get('/api/distributed',(_req,res)=>res.json(s.list('distributed',_req.project)));
 app.post('/api/distributed/preview',async(req,res)=>{write(req,true);const p=await plan(req.body,req);const manifests=distributedManifests(p.spec,p.namespace,'msd-preview',p.node_selector);governance.native(manifests,req.project);for(const m of manifests)await kube.dryRun(m);res.json({...p,manifests});});
 app.post('/api/distributed',async(req,res)=>{
  write(req,true);const v=distributedSchema.parse(req.body);
  // Reserve project totals before the first await. Every later preflight counts this record.
  const spec=governance.enforce(governance.prepare(groupSpec(v),req.project),req.project),check=checkDeployment(spec,req);if(!check.valid)fail(422,'PREFLIGHT_FAILED','分布式模型组预检未通过',check.checks);
  let g=s.put('distributed',req.project,v.name,{spec:v,status:'Creating',resources:[],manifests:[]});locks.add(g.id);
  audit(req,'distributed.create',g.id);
  try{const p=await plan(v,req,g.id),manifests=distributedManifests(v,p.namespace,'msd-'+g.id.slice(0,8),p.node_selector);governance.native(manifests,req.project);g=save(g,{manifests,endpoint:`http://msd-${g.id.slice(0,8)}.${p.namespace}.svc:8000/v1`});for(const m of manifests)await kube.dryRun(m);const freshSpec=governance.enforce(governance.prepare(groupSpec(v),req.project),req.project);if(!checkDeployment(freshSpec,req,g.id).valid)fail(422,'PREFLIGHT_FAILED','创建前项目配额已变化');for(const m of manifests){const created=await kube.apply(m);if(!created.metadata?.uid)throw Error('集群响应缺少 UID');g=save(g,{resources:[...g.resources,{kind:m.kind,name:m.metadata.name,uid:created.metadata.uid}]});}g=save(g,{status:'Starting'});}catch(e){g=save(g,{status:'NeedsAttention',error:e.message});audit(req,'distributed.create.failed',g.id,{code:e.code||'UNKNOWN'});}finally{locks.delete(g.id);}
  res.status(201).json(g);
 });
 app.post('/api/distributed/:id/refresh',async(req,res)=>{write(req);res.json(await refresh(get('distributed',req)));});
 app.post('/api/distributed/:id/delete',async(req,res)=>{
  write(req,true);let g=get('distributed',req);if(locks.has(g.id))fail(409,'OPERATION_RUNNING','模型组操作正在执行');if(g.status==='Deleted')return res.json(g);if(published(g))fail(409,'ROUTE_STILL_ENABLED','请先排空并下线关联的所有服务目录');
  const active=s.list('backend',req.project).filter(b=>b.distributed_id===g.id).some(b=>s.db.prepare("SELECT 1 FROM usage WHERE target_id=? AND status='in_progress'").get(b.id));const linkedIds=s.list('backend',req.project).filter(b=>b.distributed_id===g.id).map(b=>b.id);const inflight=[...traffic.active.values()].some(r=>r.project===req.project&&r.backendIds.some(b=>linkedIds.includes(b)));if(active||inflight)fail(409,'REQUESTS_IN_FLIGHT','仍有在途调用');
  locks.add(g.id);
  try{g=save(g,{status:'Deleting'});for(const m of [...g.manifests].reverse()){let actual;try{actual=await kube.request(kube.path(m)+'/'+m.metadata.name);}catch(e){if(e.status===404)continue;throw e;}const owned=g.resources.find(r=>r.kind===m.kind&&r.name===m.metadata.name);if(!owned||owned.uid!==actual.metadata.uid)fail(409,'OWNERSHIP_CHANGED','资源 UID 缺失或变化，拒绝删除');await kube.request(kube.path(m)+'/'+m.metadata.name,'DELETE',{apiVersion:'v1',kind:'DeleteOptions',preconditions:{uid:owned.uid},propagationPolicy:'Foreground'});}
   // Deletion acceptance does not release quota: all resources must be confirmed absent.
   let remaining=false;for(const m of g.manifests){try{await kube.request(kube.path(m)+'/'+m.metadata.name);remaining=true;}catch(e){if(e.status!==404)throw e;}}
   g=save(g,{status:remaining?'Deleting':'Deleted',error:null});for(const b of s.list('backend',req.project).filter(b=>b.distributed_id===g.id))s.update('backend',b.id,req.project,{status:'Unverified',reason:'分布式模型组已删除或正在删除'});audit(req,'distributed.delete',g.id);
  }catch(e){g=save(g,{status:'NeedsAttention',error:e.message});throw e;}finally{locks.delete(g.id);}res.json(g);
 });
 return {refresh,plan,start(){if(timer)return;for(const p of s.list('project','system'))for(const g of s.list('distributed',p.id).filter(g=>g.status==='Creating'))save(g,{status:'NeedsAttention',error:'控制面重启，请核对资源；不会重放创建操作'});timer=setInterval(()=>{if(busy)return;busy=(async()=>{for(const p of s.list('project','system'))for(const g of s.list('distributed',p.id).filter(g=>['Starting','Ready','NeedsAttention'].includes(g.status)&&g.manifests.length))try{await refresh(g);}catch{}})().finally(()=>{busy=null;});},15000);timer.unref();},async stop(){clearInterval(timer);timer=null;await busy;}};
}
