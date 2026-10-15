import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {createApp} from '../server/app.mjs';
import {deploymentSchema,deploymentManifest} from '../server/domain.mjs';
import {quantity,podRequests} from '../server/governance.mjs';
import {scalingDecision} from '../server/runtime.mjs';

async function harness(t,overrides={}){
 mkdirSync('artifacts/tests',{recursive:true});const context=createApp({dataDir:mkdtempSync('artifacts/tests/advanced-'),upstreamHosts:['127.0.0.1'],...overrides});
 const server=context.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;let cookie='';
 t.after(async()=>{await context.runtime.stop();await context.observer.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await context.gateway.dispatcher.close();context.store.close();});
 const api=async(path,body,expected=200,headers={})=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,'Content-Type':'application/json','X-Ministation-Client':'console',...headers},body:body?JSON.stringify(body):undefined});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;};
 const user=await api('/api/auth/setup',{username:'admin',password:'advanced-password'},201);return {...context,api,user,base};
}
const image='local/cpu@sha256:'+'b'.repeat(64);
const spec=()=>deploymentSchema.parse({name:'CPU',kind:'ai',image,cpu:1,memory_gib:1,replicas:1});

test('resource pools, policy defaults, native enforcement, isolation and capacity quantities',async t=>{
 const {api,store:s,user,kube,governance}=await harness(t);
 const pool=await api('/api/pools',{name:'CPU pool',selector:{pool:'cpu'}},201);
 const policy=await api('/api/policy',{allowed_registries:['docker.io'],allowed_pool_ids:[pool.id],require_pool:true,max_replicas:2,max_cpu:2,max_memory_gib:4,max_gpus:0,required_labels:{team:'infra'},defaults:{cpu:.5,memory_gib:1,pool_id:pool.id}});
 const d=await api('/api/deployments',{name:'Defaulted',kind:'ai',image,replicas:1,labels:{team:'infra'}},201);assert.equal(d.spec.cpu,.5);assert.equal(d.spec.node_selector.pool,'cpu');
 await api('/api/deployments',{...d.spec,name:'Over limit',replicas:3},422);
 await api('/api/deployments',{...d.spec,name:'Wrong registry',image:'evil.example/cpu@sha256:'+'b'.repeat(64)},422);
 await api('/api/deployments',{...d.spec,name:'Wrong selector',node_selector:{pool:'gpu'}},422);
 const other=await api('/api/projects',{name:'Other',namespace:'other',cpu_quota:4,memory_quota:8,gpu_quota:0},201);
 await api('/api/deployments',{...d.spec,name:'Cross project'},422,{'X-Project-Id':other.id});
 await api('/api/pools/'+pool.id+'/delete',{},409);
 const manifest=deploymentManifest(d.spec,'ministation-workloads','native')[0];assert.throws(()=>governance.native([manifest],user.project_id),/策略/);manifest.spec.template.metadata.annotations={'ministation.io/pool-id':pool.id};assert.equal(governance.native([manifest],user.project_id).length,1);
 const multi=structuredClone(manifest);multi.spec.template.spec.containers[0].resources.limits.cpu='1.5';multi.spec.template.spec.containers.push({...structuredClone(multi.spec.template.spec.containers[0]),name:'second'});assert.throws(()=>governance.native([multi],user.project_id),/策略/);
 Object.defineProperty(kube,'enabled',{value:true});kube.nodes=async()=>({items:[{metadata:{name:'node-a',labels:{pool:'cpu'}},spec:{},status:{allocatable:{cpu:'2',memory:'4Gi','nvidia.com/gpu':'1'},conditions:[{type:'Ready',status:'True'}]}}]});
 kube.request=async()=>({items:[{metadata:{name:'other-team'},spec:{nodeName:'node-a',containers:[{resources:{requests:{cpu:'500m',memory:'512Mi'}}}]},status:{phase:'Running'}}]});
 const capacity=await api('/api/capacity');assert.equal(capacity.nodes[0].remaining.cpu,1.5);assert.equal(capacity.nodes[0].remaining.memory_gib,3.5);assert.deepEqual(capacity.pools[0].nodes,['node-a']);
 kube.request=async()=>{throw Error('Forbidden');};assert.equal((await api('/api/capacity')).nodes[0].remaining,null);
 await api('/api/policy',{...policy,max_replicas:1});await api('/api/policy',{...policy,max_replicas:2},409);
 await api('/api/users',{username:'viewer',password:'viewer-password',role:'viewer',project_id:user.project_id},201);await api('/api/auth/login',{username:'viewer',password:'viewer-password'});await api('/api/policy');await api('/api/pools',{},403);await api('/api/monitoring/sample',{},403);await api('/api/autoscaling',{},403);
 assert.equal(quantity('100000000n'),.1);assert.equal(podRequests({spec:{containers:[{resources:{requests:{cpu:'1'}}}],initContainers:[{resources:{requests:{cpu:'2'}}}],overhead:{cpu:'100m'}}}).cpu,2.1);
});

test('canary rollback, explicit-response failover and SSE drain preserve accounting and streams',async t=>{
 let finishStream;const upstream=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const body=JSON.parse(text);if(body.model==='bad'){res.writeHead(503,{'Content-Type':'application/json'});res.end('{}');return;}if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n');finishStream=()=>res.end('data: {"choices":[{"index":0,"finish_reason":"stop","delta":{}}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n');return;}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:body.model}}],usage:{prompt_tokens:2,completion_tokens:1}}));});upstream.listen(0,'127.0.0.1');await new Promise(r=>upstream.once('listening',r));t.after(()=>{upstream.closeAllConnections();upstream.close();});
 const {api,store:s,user,traffic,base}=await harness(t);const back=async name=>{const b=await api('/api/backends',{name,logical_model:name,upstream_model:name,base_url:'http://127.0.0.1:'+upstream.address().port+'/v1'},201);return s.update('backend',b.id,user.project_id,{status:'EndpointValidated'});};
 const stable=await back('good'),candidate=await back('bad');let route=await api('/api/routes',{name:'model',target_kind:'backend',target_id:stable.id},201);const key=await api('/api/keys',{name:'key',models:['model'],expires:new Date(Date.now()+3600000).toISOString()},201);const auth={Authorization:'Bearer '+key.secret},payload={model:'model',messages:[{role:'user',content:'hi'}]};
 route=await api('/api/routes/'+route.id+'/rollout',{version:route.version,candidate_id:candidate.id,candidate_percent:100,rollback_enabled:true,min_samples:1,max_error_rate:.1});await api('/v1/chat/completions',payload,502,auth);traffic.evaluate(user.project_id);route=s.get('route',route.id,user.project_id);assert.equal(route.candidate_percent,0);assert.equal(route.rollout_status,'RolledBack');assert.equal((await api('/v1/chat/completions',payload,200,auth)).choices[0].message.content,'good');
 route=await api('/api/routes/'+route.id+'/rollout',{version:route.version,candidate_id:candidate.id,candidate_percent:100,fallback_ids:[stable.id],failover_enabled:true});assert.equal((await api('/v1/chat/completions',payload,200,auth)).choices[0].message.content,'good');const usage=(await api('/api/usage')).filter(u=>u.status==='settled');assert.equal(usage.length,2);assert.ok(usage.every(u=>u.target_id===stable.id));
 route=await api('/api/routes/'+route.id+'/rollout',{version:route.version,candidate_id:null,candidate_percent:0});
 const stream=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({...payload,stream:true})});assert.equal(traffic.countRoute(route.id),1);
 const drain=api('/api/routes/'+route.id+'/drain',{version:route.version,timeout_seconds:5});
 while(!s.get('route',route.id,user.project_id).draining)await new Promise(r=>setTimeout(r,5));await api('/v1/chat/completions',payload,503,auth);assert.equal(traffic.countRoute(route.id),1);finishStream();assert.match(await stream.text(),/\[DONE\]/);assert.equal((await drain).enabled,false);assert.equal(traffic.countRoute(route.id),0);
});

test('telemetry absence, alert lifecycle and guarded autoscale with cooldown and quota',async t=>{
 const {api,store:s,user,kube,runtime,observer,traffic}=await harness(t);let d=await api('/api/deployments',spec(),201);d=s.update('deployment',d.id,user.project_id,{status:'InfrastructureReady',resource_name:'cpu',conditions:{InfrastructureReady:true,ModelReady:true,EndpointReady:false}});
 Object.defineProperty(kube,'enabled',{value:true});let actual=deploymentManifest(d.spec,'ministation-workloads','cpu')[0];actual.metadata={...actual.metadata,resourceVersion:'1',generation:1};actual.status={observedGeneration:1,readyReplicas:1};let missing=false,scaleWrites=0;
 const pod={metadata:{name:'cpu-pod',labels:{'app.kubernetes.io/name':'cpu'}},spec:{nodeName:'n'},status:{phase:'Running'}};
 kube.deployment=async()=>actual;kube.request=async(path,method,body)=>{if(path.endsWith('/scale')){scaleWrites++;actual.spec.replicas=body.spec.replicas;return actual;}if(path.includes('metrics.k8s.io')){if(missing)throw Error('Missing metrics server');return {items:[{metadata:{name:'cpu-pod'},timestamp:new Date().toISOString(),containers:[{usage:{cpu:'900m',memory:'256Mi'}}]}]};}if(path.includes('/pods'))return {items:[pod]};return {};};
 await observer.observe(d);await runtime.sample(user.project_id);let monitoring=await api('/api/monitoring');assert.equal(monitoring.telemetry[0].cpu_percent,90);assert.equal(monitoring.telemetry[0].memory_gib,.25);
 const rule=await api('/api/alerts',{name:'CPU alert',deployment_id:d.id,metric:'cpu_percent',threshold:80,consecutive:2},201);runtime.evaluateAlerts(user.project_id);runtime.evaluateAlerts(user.project_id);assert.equal((await api('/api/monitoring')).alerts[0].status,'Firing');
 missing=true;await runtime.sample(user.project_id);runtime.evaluateAlerts(user.project_id);assert.equal((await api('/api/monitoring')).alerts[0].status,'Unknown');
 let policy=await api('/api/autoscaling',{deployment_id:d.id,metric:'cpu',target:50,min_replicas:1,max_replicas:4,cooldown_seconds:15,enabled:true});await runtime.scale(policy,user.project_id);assert.equal(scaleWrites,0);
 missing=false;await runtime.sample(user.project_id);await runtime.scale(policy,user.project_id);assert.equal(scaleWrites,1);d=s.get('deployment',d.id,user.project_id);assert.equal(d.spec.replicas,2);assert.equal(d.conditions.ModelReady,true);
 actual.status.readyReplicas=2;await observer.observe(d);await runtime.scale(policy,user.project_id);assert.equal(scaleWrites,1);
 const state=s.get('autoscale_state','autoscale:'+policy.id,user.project_id);s.update('autoscale_state',state.id,user.project_id,{last_scaled:new Date(0).toISOString()});s.update('telemetry','telemetry:'+d.id,user.project_id,{cpu_percent:1000,sampled_at:new Date().toISOString()});
 const p=s.get('project',user.project_id,'system');s.update('project',p.id,'system',{cpu_quota:2});await runtime.scale(policy,user.project_id);assert.equal(scaleWrites,1);assert.equal(s.get('autoscale_state',state.id,user.project_id).status,'Blocked');
 const base={target:50,min_replicas:1,max_replicas:4,down_samples:3};assert.equal(scalingDecision(base,3,null,3).replicas,3);assert.equal(scalingDecision(base,3,10,2).replicas,2);
 const b=s.put('backend',user.project_id,'tracked',{deployment_id:d.id}),route=s.put('route',user.project_id,'tracked',{target_kind:'backend',target_id:b.id,enabled:true});const release=traffic.enter(route,'existing');
 policy=await api('/api/autoscaling',{...policy,metric:'concurrency',target:100,down_samples:2});s.update('autoscale_state',state.id,user.project_id,{last_scaled:new Date(0).toISOString(),low_samples:1});traffic.waitEmpty=async()=>{assert.ok(traffic.blocked.has(d.id));assert.throws(()=>traffic.enter(route,'new'),/缩容/);throw Object.assign(Error('In-flight request'),{status:409,code:'DRAIN_TIMEOUT'});};await runtime.scale(policy,user.project_id);assert.equal(scaleWrites,1);assert.equal(traffic.countDeployment(d.id),1);assert.equal(traffic.blocked.has(d.id),false);release();
});

test('Prometheus CPU memory and GPU series remain available when Metrics Server is absent',async t=>{
 const prometheus=createServer((req,res)=>{const q=new URL(req.url,'http://local').searchParams.get('query');const value=q.includes('GPU')?'65':q.includes('memory')?String(512*1024**2):'0.25';res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'success',data:{result:[{metric:{pod:'cpu-pod'},value:[Date.now()/1000,value]}]}}));});prometheus.listen(0,'127.0.0.1');await new Promise(r=>prometheus.once('listening',r));t.after(()=>{prometheus.closeAllConnections();prometheus.close();});
 const {api,store:s,user,kube,runtime}=await harness(t,{prometheusUrl:'http://127.0.0.1:'+prometheus.address().port});let d=await api('/api/deployments',spec(),201);s.update('deployment',d.id,user.project_id,{resource_name:'cpu'});Object.defineProperty(kube,'enabled',{value:true});kube.request=async path=>{if(path.includes('metrics.k8s.io'))throw Error('Not installed');return {items:[{metadata:{name:'cpu-pod',labels:{'app.kubernetes.io/name':'cpu'}},status:{phase:'Running'}}]};};await runtime.sample(user.project_id);const m=(await api('/api/monitoring')).telemetry[0];assert.equal(m.name,'CPU');assert.equal(m.source,'Prometheus');assert.equal(m.cpu_percent,25);assert.equal(m.memory_gib,.5);assert.equal(m.gpu_percent,65);
});
