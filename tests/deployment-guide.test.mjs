import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {createApp} from '../server/app.mjs';
import {buildEngineTemplate} from '../server/deployment-guide.mjs';
import {deploymentManifest} from '../server/domain.mjs';
import {deploymentFindings} from '../server/diagnostics.mjs';
import {fixture} from '../scripts/fixture.mjs';

const input={name:'guided',engine:'vllm',image:'registry.example/vllm@sha256:'+'a'.repeat(64),model_pvc:'models',model_path:'/models/model',served_model:'guided-model',cpu:1,memory_gib:4,gpus:2,tensor_parallel:2};
test('engine templates generate typed argv and bounded shared memory, reject incompatible settings',()=>{
 const v=buildEngineTemplate(input),g=buildEngineTemplate({...input,engine:'sglang'});
 assert.deepEqual(v.command,['vllm']);assert.equal(v.args[0],'serve');assert.equal(v.args.at(-2),'--tensor-parallel-size');assert.equal(g.args.at(-2),'--tp-size');
 assert.deepEqual(g.command,['python3','-m','sglang.launch_server']);
 for(const bad of [{engine:'unknown'},{gpus:0},{tensor_parallel:1},{model_path:'/models/../secret'},{model_path:'/tmp/model'},{image:'registry/tag:latest'},{shared_memory_gib:4}])assert.throws(()=>buildEngineTemplate({...input,...bad}));
 const pod=deploymentManifest(v,'test','guided')[0].spec.template.spec;
 assert.equal(pod.volumes.find(v=>v.name==='shm').emptyDir.sizeLimit,'1Gi');assert.equal(pod.containers[0].volumeMounts.find(v=>v.name==='models').readOnly,true);assert.equal(pod.containers[0].resources.limits['nvidia.com/gpu'],2);
});

test('guide preflight, deployment onboarding, probe/publish gates, project and role isolation',async t=>{
 mkdirSync('artifacts/tests',{recursive:true});const context=createApp({dataDir:mkdtempSync('artifacts/tests/guide-'),upstreamHosts:['127.0.0.1']}),{app,store:s,kube,gateway}=context;
 const server=app.listen(0,'127.0.0.1'),upstream=fixture().listen(0,'127.0.0.1');await Promise.all([new Promise(r=>server.once('listening',r)),new Promise(r=>upstream.once('listening',r))]);
 t.after(async()=>{await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));await gateway.dispatcher.close();s.close();});
 let cookie='';async function api(path,body,status=200,project){const r=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method:body?'POST':'GET',headers:{cookie,'Content-Type':'application/json','X-Ministation-Client':'console',...(project?{'X-Project-Id':project}:{})},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const v=await r.json();assert.equal(r.status,status,JSON.stringify(v));return v;}
 const me=await api('/auth/setup',{username:'guide-admin',password:'guide-test-password'},201);
 assert.equal((await api('/deployment-guide/templates')).length,2);
 let preview=await api('/deployment-guide/preview',input);assert.equal(preview.valid,false);assert.equal(preview.checks.find(c=>c.name==='GPU配额').ok,false);
 await api('/deployment-guide/preview',{...input,tensor_parallel:1},422);
 s.update('project',me.project_id,'system',{gpu_quota:4});kube.enabled=true;
 let bound=true,available=2,dryRuns=0,apiFailure=false;
 const node={metadata:{name:'gpu',labels:{}},spec:{},status:{allocatable:{cpu:'8',memory:'16Gi','nvidia.com/gpu':'2'},conditions:[{type:'Ready',status:'True'}]}};
 kube.nodes=async()=>({items:[{...node,status:{...node.status,allocatable:{...node.status.allocatable,'nvidia.com/gpu':String(available)}}}]});
 kube.request=async path=>{if(path.includes('persistentvolumeclaims')){if(apiFailure)throw Object.assign(new Error('denied'),{status:403});return {status:{phase:bound?'Bound':'Pending'}};}if(path.includes('resourcequotas'))return {items:[{spec:{hard:{'requests.cpu':'8','requests.memory':'16Gi'}}}]};return {items:[]};};
 kube.dryRun=async()=>{dryRuns++;};
 preview=await api('/deployment-guide/preview',input);assert.equal(preview.valid,true);assert.equal(dryRuns,2);assert.equal(s.list('deployment',me.project_id).length,0);
 bound=false;assert.equal((await api('/deployment-guide/preview',input)).checks.find(c=>c.name==='模型卷').ok,false);bound=true;
 available=0;assert.equal((await api('/deployment-guide/preview',input)).checks.find(c=>c.name==='节点剩余容量').ok,false);available=2;
 apiFailure=true;assert.equal((await api('/deployment-guide/preview',input)).valid,false);apiFailure=false;
 let d=await api('/deployments',preview.spec,201);let plan=await api('/deployments/'+d.id+'/onboarding');assert.equal(plan.ready,false);
 d=s.update('deployment',d.id,me.project_id,{status:'InfrastructureReady',resource_name:'ms-test',conditions:{InfrastructureReady:true}});
 const request=kube.request;kube.request=async path=>path.includes('/pods?')?{items:[{metadata:{name:'own-pod',uid:'own-uid'},spec:{},status:{conditions:[{type:'PodScheduled',status:'False',reason:'Unschedulable',message:'node labels do not match'}]}}]}:path.endsWith('/events')?{items:[{involvedObject:{uid:'own-uid'},reason:'Unhealthy',message:'probe failed'},{involvedObject:{uid:'foreign-uid'},reason:'FailedMount',message:'foreign failure'}]}:request(path);
 const diagnostics=await api('/deployments/'+d.id+'/diagnostics');assert.ok(diagnostics.findings.some(f=>f.code==='SCHEDULING'));assert.ok(diagnostics.findings.some(f=>f.code==='PROBE_FAILED'));assert.equal(diagnostics.events.length,1);assert.ok(!JSON.stringify(diagnostics).includes('foreign failure'));kube.request=request;
 plan=await api('/deployments/'+d.id+'/onboarding');assert.equal(plan.ready,true);assert.equal(plan.suggestion.upstream_model,input.served_model);assert.match(plan.suggestion.base_url,/ms-test.ministation-workloads.svc:8000\/v1/);assert.match(plan.address_issue,/未在/);
 await api('/backends',plan.suggestion,422);
 const backend=await api('/backends',{...plan.suggestion,base_url:`http://127.0.0.1:${upstream.address().port}/v1`},201);
 const publish={name:'guided-public',target_kind:'backend',target_id:backend.id};await api('/routes',publish,422);
 s.update('deployment',d.id,me.project_id,{conditions:{InfrastructureReady:false}});await api('/backends/'+backend.id+'/probe',{},409);
 s.update('deployment',d.id,me.project_id,{conditions:{InfrastructureReady:true}});await api('/backends/'+backend.id+'/probe',{});await api('/routes',publish,201);
 plan=await api('/deployments/'+d.id+'/onboarding');assert.equal(plan.existing.length,1);assert.equal(plan.routes.length,1);assert.equal(plan.existing[0].secret,undefined);
 const group=s.put('distributed',me.project_id,'group',{status:'Ready',spec:{served_model:'group-model'},endpoint:'http://group.default.svc:8000/v1'});
 const gp=await api('/distributed/'+group.id+'/onboarding');assert.equal(gp.ready,true);assert.equal(gp.suggestion.distributed_id,group.id);assert.equal(gp.suggestion.upstream_model,'group-model');
 const other=await api('/projects',{name:'other',namespace:'other',cpu_quota:4,memory_quota:8,gpu_quota:0},201);
 await api('/deployments/'+d.id+'/onboarding',null,404,other.id);await api('/distributed/'+group.id+'/onboarding',null,404,other.id);
 await api('/users',{username:'guide-viewer',password:'viewer-test-password',role:'viewer',project_id:me.project_id},201);
 await api('/auth/login',{username:'guide-viewer',password:'viewer-test-password'});await api('/deployment-guide/preview',input,403);await api('/backends',plan.suggestion,403);
});

test('diagnostics explain init crashes, OOM history, volumes, scheduler and probe evidence',()=>{
 const pods=[{metadata:{name:'model'},status:{initContainerStatuses:[{name:'init',state:{waiting:{reason:'ImagePullBackOff'}}}],containerStatuses:[{name:'inference',state:{waiting:{reason:'CrashLoopBackOff'}},lastState:{terminated:{reason:'OOMKilled'}}}],conditions:[{type:'PodScheduled',status:'False',message:'Insufficient nvidia.com/gpu'}]}}];
 const events=[{reason:'FailedMount',message:'volume missing'},{reason:'Unhealthy',message:'HTTP probe failed'},{reason:'FailedScheduling',message:'pod has unbound immediate PersistentVolumeClaims'}];
 const findings=deploymentFindings(pods,events);for(const code of ['IMAGE_PULL','CRASH_LOOP','OOM_KILLED','SCHEDULING','MODEL_VOLUME','PROBE_FAILED'])assert.ok(findings.some(f=>f.code===code),code);
 assert.match(findings.find(f=>f.code==='OOM_KILLED').action,/不是 GPU/);assert.deepEqual(deploymentFindings([{status:{phase:'Running'}}],[]),[]);assert.equal(deploymentFindings([],[])[0].code,'NO_PODS');
});
