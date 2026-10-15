import {z} from 'zod';
import {deploymentSchema,fail} from './domain.mjs';
import {id,now} from './store.mjs';

export function describeDeployment(actual,pods,service,desired){
 const conditions=actual.status?.conditions||[];
 const containers=pods.flatMap(p=>[...(p.status?.initContainerStatuses||[]),...(p.status?.containerStatuses||[])]);
 const waiting=containers.find(c=>['ImagePullBackOff','ErrImagePull','CrashLoopBackOff','CreateContainerConfigError'].includes(c.state?.waiting?.reason));
 const failed=conditions.find(c=>c.type==='Progressing'&&c.status==='False');
 const scheduled=pods.find(p=>p.status?.conditions?.some(c=>c.type==='PodScheduled'&&c.status==='False'));
 const ready=actual.status?.observedGeneration>=actual.metadata.generation&&(actual.status?.readyReplicas||0)>=desired.replicas;
 const container=actual.spec?.template?.spec?.containers?.find(c=>c.name==='inference');
 if(!container||container.image!==desired.image||JSON.stringify(container.args||[])!==JSON.stringify(desired.args||[])||JSON.stringify(container.command||[])!==JSON.stringify(desired.command||[]))return {stage:'配置偏差',healthy:false,reason:'集群镜像或启动命令与保存的修订不一致',advice:'核对中断的修订任务，确认配置后重新修订。'};
 if(actual.spec?.replicas!==desired.replicas)return {stage:'配置偏差',healthy:false,reason:'实际副本数与保存的配置不同',advice:'核对外部变更或中断操作，再通过修订恢复配置。'};
 if(waiting)return {stage:'容器异常',healthy:false,reason:waiting.state.waiting.reason,advice:waiting.state.waiting.reason.includes('Image')?'检查镜像摘要、仓库访问权限与网络。':'检查容器日志、启动参数及挂载配置。'};
 if(failed)return {stage:'启动超时',healthy:false,reason:failed.message||failed.reason,advice:'检查模型加载耗时、资源限制与健康检查路径。'};
 if(scheduled)return {stage:'等待调度',healthy:false,reason:scheduled.status.conditions.find(c=>c.type==='PodScheduled').message||'尚无可调度节点',advice:'检查节点标签、资源余量、污点和项目配额。'};
 if(!ready)return {stage:pods.length?'启动与模型加载':'等待 Pod',healthy:false,reason:'尚未达到期望的就绪副本数',advice:'查看 Pod 事件和日志；就绪探针通过后将自动更新。'};
 if(!service)return {stage:'入口资源缺失',healthy:false,reason:'未找到关联 Service',advice:'核对部署任务和 Service 资源，避免重复创建。'};
 return {stage:'容器就绪',healthy:true,reason:null,advice:'容器探针已通过；模型协议验证和目录发布单独管理。'};
}

export function createObserver(s,kube){
 s.db.exec(`CREATE TABLE IF NOT EXISTS deployment_events(id TEXT PRIMARY KEY,project_id TEXT,deployment_id TEXT,stage TEXT,reason TEXT,advice TEXT,created_at TEXT);
 CREATE INDEX IF NOT EXISTS deployment_events_scope ON deployment_events(project_id,deployment_id,created_at);`);
 let timer,cycle=null,stopped=false;const pending=new Map();
 function save(d,result){
  const current=s.get('deployment',d.id,d.project_id);
  if(!current||current.version!==d.version)return null;
  const old=s.get('observation','observation:'+d.id,d.project_id),value={...result,checked_at:now()};
  s.tx(()=>{
   if(old)s.update('observation','observation:'+d.id,d.project_id,value);else s.put('observation',d.project_id,d.id,value,'observation:'+d.id);
   if(!old||['stage','reason','healthy'].some(k=>old[k]!==value[k])){
    s.db.prepare('INSERT INTO deployment_events VALUES(?,?,?,?,?,?,?)').run(id(),d.project_id,d.id,value.stage,value.reason,value.advice,value.checked_at);
    s.db.prepare('DELETE FROM deployment_events WHERE deployment_id=? AND id NOT IN (SELECT id FROM deployment_events WHERE deployment_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200)').run(d.id,d.id);
   }
   if(d.status!=='Stopped'){
    const status=value.healthy?'InfrastructureReady':value.stage==='观测不可用'?d.status:'Loading';
    const infrastructure=value.healthy===true;
    if(status!==d.status||d.conditions.InfrastructureReady!==infrastructure||d.reason!==value.reason)s.update('deployment',d.id,d.project_id,{status,reason:value.reason,conditions:{...d.conditions,InfrastructureReady:infrastructure}});
   }
  });
  return value;
 }
 async function inspect(d){
  const project=s.get('project',d.project_id,'system');
  try{
   const actual=await kube.deployment(project.namespace,d.resource_name);
   if(actual.metadata.labels?.['app.kubernetes.io/managed-by']!=='ministation')return save(d,{stage:'资源归属变化',healthy:false,reason:'集群资源不再由 MiniStation 管理',advice:'核对资源归属，禁止自动覆盖外部资源。'});
   const pods=await kube.request(`/api/v1/namespaces/${project.namespace}/pods?labelSelector=${encodeURIComponent('app.kubernetes.io/name='+d.resource_name)}`);
   let service;try{service=await kube.request(`/api/v1/namespaces/${project.namespace}/services/${d.resource_name}`);}catch(e){if(e.status!==404)throw e;}
   const result=d.status==='Stopped'?{stage:actual.spec?.replicas===0?'已停止':'停止状态偏差',healthy:false,reason:actual.spec?.replicas===0?null:'集群中仍有期望副本',advice:'核对集群实际副本数。'}:describeDeployment(actual,pods.items||[],service,d.spec);
   return save(d,{...result,ready_replicas:actual.status?.readyReplicas||0,desired_replicas:d.status==='Stopped'?0:d.spec.replicas});
  }catch(e){return save(d,{stage:e.status===404?'部署资源缺失':'观测不可用',healthy:null,reason:e.status===404?'集群中未找到 Deployment':'暂时无法读取集群状态',advice:e.status===404?'检查中断任务及残留资源后再恢复。':'检查 Kubernetes 连接和访问权限；本状态不代表模型故障。'});}
 }
 function observe(d){
  if(!kube.enabled||!d.resource_name||['Scheduling','Updating'].includes(d.status))return Promise.resolve(null);
  if(pending.has(d.id))return pending.get(d.id);
  const work=inspect(d).finally(()=>pending.delete(d.id));pending.set(d.id,work);return work;
 }
 async function tick(){
  for(const project of s.list('project','system'))for(const d of s.list('deployment',project.id)){if(stopped)return;await observe(d);}
 }
 return {observe,start(interval=15000){if(timer||cycle)return;stopped=false;const run=()=>{cycle=tick().catch(e=>console.error('observer_failed',e.code||'INTERNAL')).finally(()=>{cycle=null;if(!stopped){timer=setTimeout(run,interval);timer.unref();}});};run();},async stop(){stopped=true;clearTimeout(timer);timer=null;await cycle;await Promise.allSettled([...pending.values()]);}};
}

const percentile=(values,p)=>{const sorted=values.filter(v=>v!=null&&Number.isFinite(v)).sort((a,b)=>a-b);return sorted.length?sorted[Math.ceil(sorted.length*p)-1]:null;};
export function summarizeRequests(rows){
 const complete=rows.filter(r=>r.status!=='in_progress');
 const failed=complete.filter(r=>r.status==='failed'||(r.error_code&&r.error_code!=='PROCESS_RESTARTED'));
 const unknown=complete.filter(r=>r.error_code==='PROCESS_RESTARTED');
 const denominator=complete.length-unknown.length;
 return {requests:rows.length,completed:complete.length,in_flight:rows.length-complete.length,failed:failed.length,unknown:unknown.length,error_rate:denominator?failed.length/denominator:null,p95_ms:percentile(complete.map(r=>r.latency_ms),.95),ttft_p95_ms:percentile(complete.map(r=>r.ttft_ms),.95),ttft_samples:complete.filter(r=>r.ttft_ms!=null).length};
}
export function installOperations(app,{s,kube,get,write,audit,observer}){
 app.get('/api/templates',(req,res)=>res.json(s.list('template',req.project)));
 app.post('/api/templates',(req,res)=>{
  write(req);const v=z.object({name:z.string().trim().min(1).max(100),description:z.string().max(1000).default(''),deployment_id:z.string()}).parse(req.body);
  const source=get('deployment',req,v.deployment_id);
  if(!source.conditions.InfrastructureReady)fail(409,'TEMPLATE_NOT_READY','请从容器已就绪的部署保存模板');
  const spec=deploymentSchema.parse(source.spec);if(!/@sha256:[a-f0-9]{64}$/.test(spec.image))fail(422,'IMAGE_DIGEST_REQUIRED','模板需要固定镜像摘要');
  const template=s.put('template',req.project,v.name,{description:v.description,spec,template_revision:1,source_deployment:source.id,source_revision:source.revision,verified_at:now()});audit(req,'template.create',template.id);res.status(201).json(template);
 });
 app.get('/api/deployments/:id/health',(req,res)=>{const d=get('deployment',req);res.json({observation:s.get('observation','observation:'+d.id,req.project),events:s.db.prepare('SELECT * FROM deployment_events WHERE project_id=? AND deployment_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200').all(req.project,d.id),conditions:d.conditions,published:s.list('backend',req.project).filter(b=>b.deployment_id===d.id).map(b=>({name:b.name,status:b.status}))});});
 app.get('/api/metrics',(req,res)=>{
  const hours=z.coerce.number().int().min(1).max(168).default(24).parse(req.query.hours),endTime=Date.now(),since=new Date(endTime-hours*3600000).toISOString();
  const rows=s.db.prepare('SELECT model,status,latency_ms,ttft_ms,error_code,created_at FROM usage WHERE project_id=? AND parent_id IS NULL AND created_at>=?').all(req.project,since);
  const models=[...new Set(rows.map(r=>r.model))].map(model=>({model,...summarizeRequests(rows.filter(r=>r.model===model))}));
  const buckets=Array.from({length:hours},(_,i)=>{const start=endTime-(hours-i)*3600000,end=start+3600000;return {start:new Date(start).toISOString(),...summarizeRequests(rows.filter(r=>Date.parse(r.created_at)>=start&&Date.parse(r.created_at)<end))};});
  res.json({hours,since,generated_at:now(),summary:summarizeRequests(rows),models,buckets,scope:'已进入用量账本的顶层请求；不含鉴权或配额预检拒绝，不重复计算编排子调用'});
 });
}
