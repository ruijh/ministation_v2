import {z} from 'zod';
import {name,deploymentSchema,deploymentManifest,assertURL,publicObject} from './domain.mjs';
import {id} from './store.mjs';

export const engineTemplates=[{id:'vllm',label:'vLLM',description:'单节点 GPU 文本对话，自动生成 vllm serve 参数。'}, {id:'sglang',label:'SGLang',description:'单节点 GPU 文本对话，自动生成 launch_server 参数。'}];
const guideSchema=z.object({name,engine:z.enum(['vllm','sglang']),image:z.string().regex(/@sha256:[a-f0-9]{64}$/,'请填写固定 SHA-256 摘要的镜像'),model_pvc:z.string().regex(/^[a-z][a-z0-9-]*$/),model_path:z.string().regex(/^\/models\/[a-zA-Z0-9_./-]+$/).refine(p=>!p.split('/').includes('..'),'模型目录必须位于 /models 下'),served_model:z.string().regex(/^[a-zA-Z0-9_.:/-]{1,150}$/),cpu:z.number().positive().max(1000),memory_gib:z.number().positive().max(10000),gpus:z.number().int().min(1).max(128),tensor_parallel:z.number().int().min(1).max(128),shared_memory_gib:z.number().positive().max(128).default(1),pool_id:z.string().optional(),model_id:z.string().optional()}).superRefine((v,c)=>{if(v.gpus!==v.tensor_parallel)c.addIssue({code:'custom',path:['tensor_parallel'],message:'此单实例模板要求 TP 数等于申请的 GPU 数；副本与多节点请使用对应部署入口'});if(v.shared_memory_gib>=v.memory_gib)c.addIssue({code:'custom',path:['shared_memory_gib'],message:'共享内存上限需小于容器内存；它占用容器内存额度'});});
export function buildEngineTemplate(input){const v=guideSchema.parse(input);return deploymentSchema.parse({...v,kind:'llm',replicas:1,port:8000,health_path:'/health',model_mount:'/models',command:v.engine==='vllm'?['vllm']:['python3','-m','sglang.launch_server'],args:[...(v.engine==='vllm'?['serve',v.model_path]:['--model-path',v.model_path]),'--served-model-name',v.served_model,'--host','0.0.0.0','--port','8000',v.engine==='vllm'?'--tensor-parallel-size':'--tp-size',String(v.tensor_parallel)]});}

export function installDeploymentGuide(app,{s,kube,governance,checkDeployment,get,write,config}){
 app.get('/api/deployment-guide/templates',(_,res)=>res.json(engineTemplates));
 app.post('/api/deployment-guide/preview',async(req,res)=>{
  write(req);const spec=governance.prepare({...buildEngineTemplate(req.body),labels:governance.policy(req.project).required_labels},req.project),result=checkDeployment(spec,req),checks=[...result.checks],p=s.get('project',req.project,'system');
  if(kube.enabled){
   const capacity=await governance.capacity(req.project);
   if(!capacity.allocation_available)checks.push({name:'节点剩余容量',ok:false,detail:capacity.allocation_error||'无法读取容量，不能确认调度条件'});
   else {const eligible=capacity.nodes.filter(n=>n.ready&&!n.cordoned&&!n.taints.some(t=>['NoSchedule','NoExecute'].includes(t.effect))&&Object.entries(spec.node_selector).every(([k,v])=>n.labels?.[k]===v)&&n.remaining.cpu>=spec.cpu&&n.remaining.memory_gib>=spec.memory_gib&&n.remaining.gpus>=spec.gpus);checks.push({name:'节点剩余容量',ok:eligible.length>0,detail:eligible.length?`${eligible.length} 个节点满足当前 requests、标签和污点检查；最终由调度器决定`:'没有节点同时满足 CPU、内存、GPU、资源池与污点条件'});}

   try{const pvc=await kube.request(`/api/v1/namespaces/${p.namespace}/persistentvolumeclaims/${encodeURIComponent(spec.model_pvc)}`);checks.push({name:'模型卷',ok:pvc.status?.phase==='Bound',detail:pvc.status?.phase==='Bound'?'卷已绑定；仍需确认模型文件存在且 UID 1000 可读':'请先创建并绑定本项目的模型 PVC'});}catch(e){checks.push({name:'模型卷',ok:false,detail:e.status===404?'模型 PVC 不存在，请先准备模型卷':e.message});}
   try{await kube.assertQuota(p.namespace);for(const m of deploymentManifest(spec,p.namespace,'preview-'+id().slice(0,8)))await kube.dryRun(m);checks.push({name:'集群服务端校验',ok:true,detail:'清单通过 dry-run；未创建资源或预留容量'});}catch(e){checks.push({name:'集群服务端校验',ok:false,detail:e.message});}
  }
  res.json({spec,checks,valid:checks.every(c=>c.ok),warnings:['模板仅提供基础启动配置，不代表性能最优。请核对模型架构对 TP 的支持、GPU 显存与镜像兼容性。','预检不运行模型、不检查卷内文件，也不预留节点资源。保存草稿后，实际部署仍会重新校验。','镜像须支持 UID 1000 非 root 运行；模型与缓存应预先准备。共享内存计入容器内存。']});
 });
 for(const kind of ['deployment','distributed'])app.get(`/api/${kind==='deployment'?'deployments':'distributed'}/:id/onboarding`,(req,res)=>{
  const source=get(kind,req),p=s.get('project',req.project,'system'),field=kind+'_id';
  const existing=s.list('backend',req.project).filter(b=>b[field]===source.id).map(publicObject);
  const args=source.spec.args||[],index=args.indexOf('--served-model-name');
  const upstream_model=kind==='distributed'?source.spec.served_model:index>=0?args[index+1]||'':'';
  const base_url=kind==='distributed'?source.endpoint||'':source.resource_name?`http://${source.resource_name}.${p.namespace}.svc:${source.spec.port}/v1`:'';
  let address_issue='';try{assertURL(base_url,config.upstreamHosts);}catch(e){address_issue=e.message;}
  res.json({source_id:source.id,ready:kind==='distributed'?source.status==='Ready':source.status==='InfrastructureReady'&&!!source.conditions?.InfrastructureReady,suggestion:{name:source.name,[field]:source.id,base_url,upstream_model,logical_model:upstream_model,protocol:'chat'},existing,routes:s.list('route',req.project).filter(r=>r.target_kind==='backend'&&existing.some(b=>b.id===r.target_id)),address_issue,allowed_hosts:config.upstreamHosts});
 });
}
