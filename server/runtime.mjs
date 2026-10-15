import {z} from 'zod';
import {fail,name} from './domain.mjs';
import {now,id} from './store.mjs';
import {quantity} from './governance.mjs';
import {summarizeRequests} from './operations.mjs';

export const autoscaleSchema=z.object({deployment_id:z.string(),enabled:z.boolean().default(false),metric:z.enum(['cpu','concurrency']),target:z.number().positive().max(100000),min_replicas:z.number().int().min(1).max(100),max_replicas:z.number().int().min(1).max(100),cooldown_seconds:z.number().int().min(15).max(3600).default(120),down_samples:z.number().int().min(2).max(20).default(3)}).refine(v=>v.min_replicas<=v.max_replicas,'最小副本不得大于最大副本').refine(v=>v.metric!=='cpu'||v.target<=100,'CPU目标必须在0至100之间');
export const alertSchema=z.object({name,deployment_id:z.string().optional(),metric:z.enum(['error_rate','p95_ms','unavailable','cpu_percent','memory_percent','gpu_percent']),threshold:z.number().nonnegative().max(3600000),min_samples:z.number().int().min(1).max(10000).default(5),consecutive:z.number().int().min(1).max(20).default(2),window_seconds:z.number().int().min(30).max(3600).default(300),enabled:z.boolean().default(true)});
export function scalingDecision(spec,current,value,lowSamples=0){
 if(value==null||!Number.isFinite(value))return {replicas:current,low_samples:0,reason:'指标不可用，保持副本'};
 if(current<spec.min_replicas)return {replicas:spec.min_replicas,low_samples:0,reason:'恢复最小副本'};
 const ratio=value/spec.target;
 if(ratio>1.1)return {replicas:Math.min(spec.max_replicas,Math.max(current+1,Math.ceil(current*ratio))),low_samples:0,reason:'指标超过目标'};
 const low=ratio<.7?lowSamples+1:0;
 if(low>=spec.down_samples)return {replicas:Math.max(spec.min_replicas,Math.min(spec.max_replicas,current-1)),low_samples:0,reason:'连续低负载，缩减一个副本'};
 return {replicas:current,low_samples:low,reason:low?'等待低负载稳定窗口':'处于目标区间'};
}
export function createRuntime({s,kube,config,traffic,governance,checkDeployment,webhooks}){
 let timer,work=null,stopped=false;const locks=new Set();
 function assertUnlocked(did){if(locks.has(did))fail(409,'SCALING_IN_PROGRESS','弹性伸缩正在进行，请稍后重试');}
 function save(kind,project,key,data){const old=s.get(kind,key,project);return old?s.update(kind,key,project,data):s.put(kind,project,data.name||key,data,key);}
 async function sample(project){
  const namespace=s.get('project',project,'system').namespace;let podMetrics=null,pods=null,reason=null,gpu=null,promCpu=null,promMemory=null,gpuReason='未配置 Prometheus/DCGM';
  if(kube.enabled){const results=await Promise.allSettled([kube.request(`/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`),kube.request(`/api/v1/namespaces/${namespace}/pods`)]);if(results[0].status==='fulfilled')podMetrics=results[0].value.items;if(results[1].status==='fulfilled')pods=results[1].value.items;if(results.some(r=>r.status!=='fulfilled'))reason='Metrics Server 或 Pod 读取不可用，请检查安装与 RBAC';}else reason='未配置 Kubernetes';
  if(config.prometheusUrl){
   async function query(expression){const base=new URL(config.prometheusUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw Error('Invalid monitoring URL');const url=new URL(base.toString().replace(/\/$/,'')+'/api/v1/query');url.searchParams.set('query',expression);const response=await fetch(url,{signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)throw Error('Prometheus unavailable');const data=await response.json();if(data.status!=='success'||!Array.isArray(data.data?.result))throw Error('Invalid Prometheus result');return data.data.result;}
   const fetched=await Promise.allSettled([query(`DCGM_FI_DEV_GPU_UTIL{namespace="${namespace}"}`),query(`sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="${namespace}",container!="",container!="POD"}[2m]))`),query(`sum by (pod) (container_memory_working_set_bytes{namespace="${namespace}",container!="",container!="POD"})`)]);
   if(fetched[0].status==='fulfilled'){gpu=fetched[0].value;gpuReason=null;}else gpuReason='Prometheus/DCGM 查询失败';
   if(fetched[1].status==='fulfilled')promCpu=fetched[1].value;if(fetched[2].status==='fulfilled')promMemory=fetched[2].value;
  }
  const values=[];
  for(const d of s.list('deployment',project)){
   const names=d.resource_name?pods?.filter(p=>p.metadata.labels?.['app.kubernetes.io/name']===d.resource_name&&!['Succeeded','Failed'].includes(p.status?.phase)).map(p=>p.metadata.name)||[]:[];
   const samples=podMetrics?.filter(p=>names.includes(p.metadata.name)&&Date.now()-Date.parse(p.timestamp)<120000)||[];
   const complete=names.length>0&&samples.length===names.length;
   let cpu=complete?samples.reduce((n,p)=>n+p.containers.reduce((v,c)=>v+quantity(c.usage.cpu),0),0):null;
   let memory=complete?samples.reduce((n,p)=>n+p.containers.reduce((v,c)=>v+quantity(c.usage.memory)/1024**3,0),0):null;
   const validSeries=series=>(series||[]).filter(v=>names.includes(v.metric.pod)&&Date.now()/1000-Number(v.value?.[0])<120&&Date.now()/1000-Number(v.value?.[0])>=-10&&Number.isFinite(Number(v.value?.[1]))&&Number(v.value[1])>=0);
   const pc=validSeries(promCpu),pm=validSeries(promMemory);const promComplete=names.length>0&&new Set(pc.map(v=>v.metric.pod)).size===names.length&&new Set(pm.map(v=>v.metric.pod)).size===names.length;
   if(promComplete){cpu=pc.reduce((n,v)=>n+Number(v.value[1]),0);memory=pm.reduce((n,v)=>n+Number(v.value[1])/1024**3,0);}
   const gpuValues=validSeries(gpu).map(v=>Number(v.value[1])).filter(v=>Number.isFinite(v)&&v>=0&&v<=100);
   const value={deployment_id:d.id,name:d.name,cpu_cores:cpu,memory_gib:memory,cpu_percent:cpu==null?null:cpu/(d.spec.cpu*names.length)*100,memory_percent:memory==null?null:memory/(d.spec.memory_gib*names.length)*100,gpu_percent:gpuValues.length?gpuValues.reduce((a,b)=>a+b,0)/gpuValues.length:null,source:promComplete?'Prometheus':'Metrics Server 近期快照',reason:complete||promComplete?null:reason||'Pod 指标缺失或过期',gpu_reason:gpuValues.length?null:gpuReason||'没有匹配 Pod 的有效 GPU 样本',sampled_at:now()};save('telemetry',project,'telemetry:'+d.id,value);values.push(value);
  }return values;
 }
 function evaluateAlerts(project){
  for(const rule of s.list('alert_rule',project)){
   const previous=s.get('alert_state','alert:'+rule.id,project);let value=null;
   if(rule.enabled){
    const d=rule.deployment_id?s.get('deployment',rule.deployment_id,project):null;
    if(rule.metric==='unavailable'){const o=d&&s.get('observation','observation:'+d.id,project);if(o&&Date.now()-Date.parse(o.checked_at)<60000&&o.healthy!==null)value=o.healthy?0:1;}
    else if(rule.metric.endsWith('_percent')){const m=d&&s.get('telemetry','telemetry:'+d.id,project);if(m&&Date.now()-Date.parse(m.sampled_at)<60000)value=m[rule.metric];}
    else{const since=new Date(Date.now()-rule.window_seconds*1000).toISOString();let rows;if(d){const ids=s.list('backend',project).filter(b=>b.deployment_id===d.id).map(b=>b.id);rows=s.db.prepare('SELECT status,error_code,latency_ms,target_id FROM usage WHERE project_id=? AND parent_id IS NULL AND created_at>=?').all(project,since).filter(r=>ids.includes(r.target_id));}else rows=s.db.prepare('SELECT status,error_code,latency_ms FROM usage WHERE project_id=? AND parent_id IS NULL AND created_at>=?').all(project,since);const summary=summarizeRequests(rows);if(summary.completed>=rule.min_samples)value=summary[rule.metric];}
   }
   const streak=value!=null&&value>rule.threshold?(previous?.streak||0)+1:0;
   const status=!rule.enabled?'Disabled':value==null?'Unknown':streak>=rule.consecutive?'Firing':value>rule.threshold?'Pending':'Resolved';
   const changed=status!==previous?.status;const opened=!!previous?.incident_open,notification=status==='Firing'&&!opened?'alert.firing':status==='Resolved'&&opened?'alert.resolved':null;s.tx(()=>{save('alert_state',project,'alert:'+rule.id,{incident_open:status==='Firing'?true:status==='Resolved'?false:opened,rule_id:rule.id,name:rule.name,metric:rule.metric,value,threshold:rule.threshold,status,streak,checked_at:now(),changed_at:changed?now():previous.changed_at,acknowledged:changed?false:previous.acknowledged});
   if(changed)s.audit(project,'controller','alert.'+status.toLowerCase(),rule.id,{metric:rule.metric,value,threshold:rule.threshold});
   if(notification)webhooks?.enqueue(project,{id:id(),type:notification,project_id:project,at:now(),rule_id:rule.id,name:rule.name,metric:rule.metric,value,threshold:rule.threshold});});
  }
 }
 async function scale(policy,project){
  let d=s.get('deployment',policy.deployment_id,project);if(!d||!policy.enabled||!kube.enabled)return;
  const stateKey='autoscale:'+policy.id,old=s.get('autoscale_state',stateKey,project),observation=s.get('observation','observation:'+d.id,project);
  if(locks.has(d.id))return;
  const report=patch=>save('autoscale_state',project,stateKey,{policy_id:policy.id,deployment_id:d.id,last_scaled:old?.last_scaled,low_samples:0,checked_at:now(),...patch});
  if(d.status!=='InfrastructureReady'||!observation?.healthy||Date.now()-Date.parse(observation.checked_at)>60000){report({status:'Waiting',reason:'等待新鲜的就绪观测'});return;}
  if(old?.last_scaled&&Date.now()-Date.parse(old.last_scaled)<policy.cooldown_seconds*1000){report({status:'Cooldown',reason:'冷却期'});return;}
  const telemetry=s.get('telemetry','telemetry:'+d.id,project);
  const value=policy.metric==='concurrency'?traffic.countDeployment(d.id)/d.spec.replicas:telemetry&&Date.now()-Date.parse(telemetry.sampled_at)<60000?telemetry.cpu_percent:null;
  const decision=scalingDecision(policy,d.spec.replicas,value,old?.low_samples||0);
  if(decision.replicas===d.spec.replicas){report({status:value==null?'Unknown':'Stable',value,...decision});return;}
  locks.add(d.id);let wrote=false;
  try{
   const spec={...d.spec,replicas:decision.replicas};governance.enforce(spec,project);const check=checkDeployment(spec,{project},d.id);if(!check.valid)fail(422,'PREFLIGHT_FAILED','伸缩预检未通过',check.checks);
   if(decision.replicas<d.spec.replicas){traffic.blocked.add(d.id);await traffic.waitEmpty(()=>traffic.countDeployment(d.id),30000);}
   const fresh=s.get('deployment',d.id,project);if(fresh.version!==d.version)fail(409,'VERSION_CONFLICT','部署配置已变化');
   const p=s.get('project',project,'system'),actual=await kube.deployment(p.namespace,d.resource_name);
   if(actual.metadata.labels?.['app.kubernetes.io/managed-by']!=='ministation'||actual.spec.replicas!==d.spec.replicas)fail(409,'CLUSTER_DRIFT','集群配置存在偏差，停止自动伸缩');
   if(s.get('autoscale',policy.id,project)?.version!==policy.version)fail(409,'POLICY_CHANGED','伸缩策略已更新');governance.enforce(spec,project);if(!checkDeployment(spec,{project},d.id).valid)fail(422,'PREFLIGHT_FAILED','资源配额已变化');
   const state=s.update('deployment',d.id,project,{status:'Updating',scaling_reservation:spec},d.version);
   await kube.request(`/apis/apps/v1/namespaces/${p.namespace}/deployments/${d.resource_name}/scale`,'PATCH',{metadata:{resourceVersion:actual.metadata.resourceVersion},spec:{replicas:decision.replicas}});wrote=true;
   const revision=d.revision+1;s.update('deployment',d.id,project,{spec,revision,scaling_reservation:null,status:'Loading',conditions:{...d.conditions,InfrastructureReady:false},history:[...(d.history||[]),{revision,spec,reason:'autoscale',created_at:now()}]},state.version);
   report({status:'Scaled',value,replicas:decision.replicas,last_scaled:now(),reason:decision.reason});s.audit(project,'controller','deployment.autoscale',d.id,{from:d.spec.replicas,to:decision.replicas,metric:policy.metric,value});
  }catch(e){const current=s.get('deployment',d.id,project);if(current?.status==='Updating')s.update('deployment',d.id,project,{status:'Reconciling',reason:'伸缩结果需核对：'+(e.code||'ERROR')});report({status:'Blocked',reason:e.status?e.message:'伸缩执行失败，请检查集群',cluster_write_completed:wrote});s.audit(project,'controller','autoscale.blocked',d.id,{code:e.code||'ERROR'});}finally{locks.delete(d.id);traffic.blocked.delete(d.id);}
 }
 async function tick(){for(const p of s.list('project','system')){await sample(p.id);evaluateAlerts(p.id);traffic.evaluate(p.id);for(const policy of s.list('autoscale',p.id)){if(stopped)return;await scale(policy,p.id);}}}
 return {sample,evaluateAlerts,scale,assertUnlocked,tick,start(interval=15000){if(timer||work)return;stopped=false;const run=()=>{work=tick().catch(e=>console.error('runtime_cycle_failed',e.code||'ERROR')).finally(()=>{work=null;if(!stopped){timer=setTimeout(run,interval);timer.unref();}});};run();},async stop(){stopped=true;clearTimeout(timer);timer=null;await work;}};
}
export function installRuntime(app,{s,get,write,audit,runtime,governance}){
 app.get('/api/monitoring',(req,res)=>res.json({telemetry:s.list('telemetry',req.project),rules:s.list('alert_rule',req.project),alerts:s.list('alert_state',req.project),autoscaling:s.list('autoscale',req.project),scaling_states:s.list('autoscale_state',req.project)}));
 app.post('/api/monitoring/sample',async(req,res)=>{write(req,true);await runtime.sample(req.project);runtime.evaluateAlerts(req.project);res.json({ok:true});});
 app.post('/api/alerts',(req,res)=>{write(req,true);const v=alertSchema.parse(req.body);if(['unavailable','cpu_percent','memory_percent','gpu_percent'].includes(v.metric)&&!v.deployment_id)fail(422,'DEPLOYMENT_REQUIRED','该指标需要部署目标');if(v.deployment_id)get('deployment',req,v.deployment_id);const rule=s.put('alert_rule',req.project,v.name,v);audit(req,'alert.create',rule.id);res.status(201).json(rule);});
 app.post('/api/alerts/:id/toggle',(req,res)=>{write(req,true);const rule=get('alert_rule',req),enabled=z.boolean().parse(req.body.enabled);z.number().int().positive().parse(req.body.version);res.json(s.update('alert_rule',rule.id,req.project,{enabled},req.body.version));audit(req,'alert.toggle',rule.id,{enabled});});
 app.post('/api/alerts/:id/acknowledge',(req,res)=>{write(req);const alert=get('alert_state',req);res.json(s.update('alert_state',alert.id,req.project,{acknowledged:true,acknowledged_by:req.user.username}));audit(req,'alert.acknowledge',alert.id);});
 app.get('/api/autoscaling',(req,res)=>res.json({policies:s.list('autoscale',req.project),states:s.list('autoscale_state',req.project)}));
 app.post('/api/autoscaling',(req,res)=>{write(req,true);const v=autoscaleSchema.parse(req.body),d=get('deployment',req,v.deployment_id);governance.enforce({...d.spec,replicas:v.max_replicas},req.project);runtime.assertUnlocked(d.id);const old=s.list('autoscale',req.project).find(p=>p.deployment_id===d.id);if(old)z.number().int().positive().parse(req.body.version);const policy=old?s.update('autoscale',old.id,req.project,v,req.body.version):s.put('autoscale',req.project,d.name,v);audit(req,'autoscale.configure',policy.id,v);res.json(policy);});
}
