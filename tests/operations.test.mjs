import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {createApp} from '../server/app.mjs';
import {deploymentSchema,deploymentManifest} from '../server/domain.mjs';
import {summarizeRequests,describeDeployment} from '../server/operations.mjs';

test('metrics distinguish billing uncertainty, failed calls, interrupted calls and missing TTFT',()=>{
 const s=summarizeRequests([{status:'pending',latency_ms:100},{status:'pending',error_code:'TIMEOUT',latency_ms:300},{status:'pending',error_code:'PROCESS_RESTARTED'},{status:'in_progress'},{status:'settled',latency_ms:200,ttft_ms:0}]);
 assert.equal(s.error_rate,1/3);assert.equal(s.in_flight,1);assert.equal(s.unknown,1);assert.equal(s.p95_ms,300);assert.equal(s.ttft_p95_ms,0);assert.equal(s.ttft_samples,1);
 assert.equal(summarizeRequests([]).error_rate,null);
});

test('observer, recovery, template isolation and metrics API',async t=>{
 mkdirSync('artifacts/tests',{recursive:true});const dir=mkdtempSync('artifacts/tests/operations-');
 const {app,store:s,kube,gateway,observer}=createApp({dataDir:dir});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await observer.stop();await new Promise(r=>server.close(r));await gateway.dispatcher.close();s.close();});
 let cookie='';const base='http://127.0.0.1:'+server.address().port;
 async function api(path,body,status=200,headers={}){const r=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'Content-Type':'application/json','X-Ministation-Client':'console',...headers},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;}
 const me=await api('/auth/setup',{username:'operator',password:'operations-password'},201);
 const spec=deploymentSchema.parse({name:'cpu-service',kind:'ai',image:'local/cpu@sha256:'+'a'.repeat(64),cpu:1,memory_gib:1,replicas:1});
 let d=await api('/deployments',spec,201);
 await api('/templates',{name:'premature',deployment_id:d.id},409);
 const manifest=deploymentManifest(spec,'ministation-workloads','ms-test')[0];
 let actual={...manifest,metadata:{...manifest.metadata,generation:1},status:{observedGeneration:1,readyReplicas:1}};
 let pods=[],service={},outage=false,hold;
 Object.defineProperty(kube,'enabled',{value:true});
 kube.deployment=async()=>{if(hold)await hold;if(outage)throw Object.assign(new Error('offline'),{status:502});return actual;};
 kube.request=async path=>path.includes('/pods?')?{items:pods}:service;
 d=s.update('deployment',d.id,me.project_id,{resource_name:'ms-test',status:'Scheduling'});
 const op=s.put('operation',me.project_id,'launch',{status:'Running',target_id:d.id});
 s.recover();assert.equal(s.get('operation',op.id,me.project_id).status,'Interrupted');
 assert.equal(s.get('deployment',d.id,me.project_id).status,'Reconciling');
 await observer.observe(s.get('deployment',d.id,me.project_id));
 d=s.get('deployment',d.id,me.project_id);assert.equal(d.status,'InfrastructureReady');
 const firstVersion=d.version;await observer.observe(d);assert.equal(s.get('deployment',d.id,me.project_id).version,firstVersion);
 let health=await api('/deployments/'+d.id+'/health');assert.equal(health.events.length,1);assert.equal(health.observation.healthy,true);
 const template=await api('/templates',{name:'CPU template',description:'Saved runtime',deployment_id:d.id},201);assert.equal(template.spec.image,spec.image);
 s.update('deployment',d.id,me.project_id,{spec:{...spec,cpu:2},revision:2});assert.equal((await api('/templates'))[0].spec.cpu,1);
 const copy=await api('/deployments',{...template.spec,name:'copy'},201);assert.equal(copy.status,'Draft');
 pods=[{status:{containerStatuses:[{state:{waiting:{reason:'ImagePullBackOff'}}}]}}];
 await observer.observe(s.get('deployment',d.id,me.project_id));health=await api('/deployments/'+d.id+'/health');assert.equal(health.observation.stage,'容器异常');assert.equal(health.events.length,2);
 outage=true;await observer.observe(s.get('deployment',d.id,me.project_id));health=await api('/deployments/'+d.id+'/health');assert.equal(health.observation.healthy,null);assert.equal(health.observation.stage,'观测不可用');outage=false;pods=[];
 let release;hold=new Promise(r=>release=r);const pending=observer.observe(s.get('deployment',d.id,me.project_id));s.update('deployment',d.id,me.project_id,{status:'Stopped'});release();await pending;hold=null;assert.equal(s.get('deployment',d.id,me.project_id).status,'Stopped');
 actual={...actual,spec:{...actual.spec,replicas:0}};await observer.observe(s.get('deployment',d.id,me.project_id));assert.equal((await api('/deployments/'+d.id+'/health')).observation.stage,'已停止');
 const other=await api('/projects',{name:'Other',namespace:'other',cpu_quota:4,memory_quota:8,gpu_quota:0},201);
 assert.deepEqual(await api('/templates',null,200,{'X-Project-Id':other.id}),[]);
 await api('/deployments/'+d.id+'/health',null,404,{'X-Project-Id':other.id});
 await api('/templates',{name:'stolen',deployment_id:d.id},404,{'X-Project-Id':other.id});
 const put=(rid,project,parent=null)=>gateway.record({rid,project,key:'key',model:'sample',status:'settled',parent,latency:100,ttft:50});put('top',me.project_id);put('child',me.project_id,'top');put('other',other.id);
 const metrics=await api('/metrics');assert.equal(metrics.summary.requests,1);assert.equal(metrics.summary.p95_ms,100);assert.equal(metrics.buckets.reduce((n,b)=>n+b.requests,0),1);await api('/metrics?hours=0',null,422);
 await api('/users',{username:'reader',password:'reader-password',project_id:me.project_id,role:'viewer'},201);await api('/auth/login',{username:'reader',password:'reader-password'});await api('/templates');await api('/metrics');await api('/templates',{name:'forbidden',deployment_id:d.id},403);
 await observer.stop();s.close();
 // Persistence is verified independently of the process that collected the event.
 const reopened=createApp({dataDir:dir});assert.ok(reopened.store.db.prepare('SELECT count(*) n FROM deployment_events').get().n>=3);await reopened.gateway.dispatcher.close();reopened.store.close();
 // Prevent the cleanup hook from closing the already-closed test database twice.
 s.close=()=>{};
});

test('diagnostics classify unschedulable pods, deadline failures and configuration drift',()=>{
 const spec=deploymentSchema.parse({name:'test',kind:'image',image:'image',cpu:1,memory_gib:1,replicas:1});
 const actual=deploymentManifest(spec,'test','test')[0];actual.metadata.generation=1;actual.status={observedGeneration:1,readyReplicas:0};
 assert.equal(describeDeployment(actual,[{status:{conditions:[{type:'PodScheduled',status:'False',message:'Insufficient cpu'}]}}],{},spec).stage,'等待调度');
 actual.status.conditions=[{type:'Progressing',status:'False',reason:'ProgressDeadlineExceeded'}];assert.equal(describeDeployment(actual,[],{},spec).stage,'启动超时');
 actual.spec.template.spec.containers[0].image='other';assert.equal(describeDeployment(actual,[],{},spec).stage,'配置偏差');
});
