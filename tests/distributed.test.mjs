import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {createApp} from '../server/app.mjs';
import {distributedSchema,distributedManifests} from '../server/distributed.mjs';
const image='registry.example/sglang@sha256:'+'a'.repeat(64);
const input=()=>({name:'distributed test',image,nodes:['gpu-a','gpu-b'],gpus_per_node:1,cpu:1,memory_gib:2,model_pvc:'models',model_path:'/models/model',served_model:'test-model'});
async function harness(t){mkdirSync('artifacts/tests',{recursive:true});const ctx=createApp({dataDir:mkdtempSync('artifacts/tests/distributed-'),upstreamHosts:['127.0.0.1']});const {kube,store:s}=ctx;const resources=new Map();let seq=0,failAt=0,applyCount=0,shared=true,remaining=8;
 kube.enabled=true;kube.assertQuota=async()=>{};kube.dryRun=async d=>d;
 kube.apply=async d=>{if(++applyCount===failAt)throw Error('synthetic create failure');const actual={...structuredClone(d),metadata:{...d.metadata,uid:'uid-'+(++seq),generation:1},status:d.kind==='Deployment'?{observedGeneration:1,availableReplicas:1}:undefined};resources.set(kube.path(d)+'/'+d.metadata.name,actual);return actual;};
 kube.nodes=async()=>({items:['gpu-a','gpu-b'].map(n=>({metadata:{name:n,labels:{'kubernetes.io/hostname':n}},spec:{},status:{conditions:[{type:'Ready',status:'True'}],allocatable:{cpu:'32',memory:'128Gi','nvidia.com/gpu':String(remaining)}}}))});
 kube.request=async(path,method='GET',body)=>{if(path==='/api/v1/pods')return {items:[]};if(path.endsWith('/persistentvolumeclaims/models'))return {spec:{accessModes:[shared?'ReadWriteMany':'ReadWriteOnce']},status:{phase:'Bound'}};const actual=resources.get(path);if(!actual)throw Object.assign(Error('missing'),{status:404});if(method==='DELETE'){assert.equal(body.preconditions.uid,actual.metadata.uid);assert.equal(body.propagationPolicy,'Foreground');resources.delete(path);return {};}return actual;};
 const server=ctx.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));let cookie='';const base='http://127.0.0.1:'+server.address().port;
 const api=async(path,body,expected=200,headers={})=>{const r=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{cookie,'X-Ministation-Client':'console','Content-Type':'application/json',...headers},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const d=await r.json();assert.equal(r.status,expected,JSON.stringify(d));return d;};
 const user=await api('/auth/setup',{username:'distributed-admin',password:'distributed-test-password'},201);s.update('project',user.project_id,'system',{cpu_quota:32,memory_quota:128,gpu_quota:8});
 t.after(async()=>{await ctx.distributed.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await ctx.gateway.dispatcher.close();s.close();});
 return {...ctx,api,user,resources,setFailure:n=>{failAt=n;applyCount=0;},setShared:v=>{shared=v;},setCapacity:n=>{remaining=n;}};
}
test('SGLang manifests describe one cross-node TP group, distinct ranks and safe bootstrap',()=>{
 const spec=distributedSchema.parse(input()),docs=distributedManifests(spec,'project','msd-test');assert.equal(docs.length,4);assert.equal(docs[0].spec.publishNotReadyAddresses,true);assert.equal(docs[1].spec.selector['ministation.io/rank'],'0');
 for(let rank=0;rank<2;rank++){const d=docs[rank+2],pod=d.spec.template.spec,c=pod.containers[0];assert.equal(d.spec.replicas,1);assert.equal(d.spec.strategy.type,'Recreate');assert.equal(pod.nodeSelector['kubernetes.io/hostname'],spec.nodes[rank]);assert.equal(c.args[c.args.indexOf('--tp-size')+1],'2');assert.equal(c.args[c.args.indexOf('--node-rank')+1],String(rank));assert.equal(c.resources.requests['nvidia.com/gpu'],1);assert.equal(pod.automountServiceAccountToken,false);assert.equal(c.volumeMounts[0].readOnly,true);assert.equal(pod.volumes[1].emptyDir.medium,'Memory');assert.ok(rank?c.readinessProbe.exec:c.readinessProbe.httpGet);}
 assert.throws(()=>distributedSchema.parse({...input(),nodes:['gpu-a','gpu-a']}));assert.throws(()=>distributedSchema.parse({...input(),model_path:'/models/../secret'}));assert.throws(()=>distributedSchema.parse({...input(),args:['--trust-remote-code']}));
});
test('distributed preflight rejects insufficient resources and non-shared PVC; policies apply',async t=>{
 const h=await harness(t);h.setCapacity(0);await h.api('/distributed/preview',input(),422);h.setCapacity(8);h.setShared(false);await h.api('/distributed/preview',input(),422);h.setShared(true);
 await h.api('/policy',{allowed_registries:['approved.example']});await h.api('/distributed/preview',input(),422);await h.api('/policy',{version:h.store.list('policy',h.user.project_id)[0].version,allowed_registries:['registry.example']});const preview=await h.api('/distributed/preview',input());assert.equal(preview.total.gpus,2);assert.equal(h.resources.size,0);
});
test('group lifecycle reserves total quota, observes every member and protects ownership and published references',async t=>{
 const h=await harness(t);let g=await h.api('/distributed',input(),201);assert.equal(g.status,'Starting');assert.equal(g.resources.length,4);
 h.store.update('project',h.user.project_id,'system',{gpu_quota:2});await h.api('/distributed',{...input(),name:'second'},422);
 const ordinary=await h.api('/deployments/validate',{name:'ordinary',kind:'image',image,cpu:1,memory_gib:1,gpus:1,replicas:1});assert.equal(ordinary.valid,false);
 g=await h.api('/distributed/'+g.id+'/refresh',{});assert.equal(g.status,'Ready');const d=[...h.resources.values()].find(d=>d.kind==='Deployment');d.status.availableReplicas=0;g=await h.api('/distributed/'+g.id+'/refresh',{});assert.equal(g.status,'Starting');d.status.availableReplicas=1;await h.api('/distributed/'+g.id+'/refresh',{});
 const b=await h.api('/backends',{name:'group backend',distributed_id:g.id,logical_model:'group',upstream_model:'test-model',base_url:'http://127.0.0.1:8888',protocol:'chat'},201);h.store.update('backend',b.id,h.user.project_id,{status:'EndpointValidated'});const route=h.store.put('route',h.user.project_id,'group',{enabled:true,target_kind:'backend',target_id:b.id});await h.api('/distributed/'+g.id+'/delete',{},409);h.store.update('route',route.id,h.user.project_id,{enabled:false});const release=h.traffic.enter({...route,project_id:h.user.project_id},'held-request');await h.api('/distributed/'+g.id+'/delete',{},409);release();
 const oldUid=d.metadata.uid;d.metadata.uid='foreign-resource';await h.api('/distributed/'+g.id+'/delete',{},409);assert.ok([...h.resources.values()].includes(d));d.metadata.uid=oldUid;g=await h.api('/distributed/'+g.id+'/delete',{});assert.equal(g.status,'Deleted');assert.equal(h.resources.size,0);assert.equal(h.store.get('backend',b.id,h.user.project_id).status,'Unverified');
});
test('partial creation is retained, safely cleanable, and scoped by project and role',async t=>{
 const h=await harness(t);h.setFailure(4);const g=await h.api('/distributed',input(),201);assert.equal(g.status,'NeedsAttention');assert.equal(g.resources.length,3);assert.equal((await h.api('/distributed/'+g.id+'/delete',{})).status,'Deleted');
 const other=await h.api('/projects',{name:'other',namespace:'other',cpu_quota:10,memory_quota:10,gpu_quota:2},201);await h.api('/distributed/'+g.id+'/refresh',{},404,{'X-Project-Id':other.id});
 await h.api('/users',{username:'distributed-viewer',password:'viewer-test-password',role:'viewer',project_id:h.user.project_id},201);await h.api('/auth/login',{username:'distributed-viewer',password:'viewer-test-password'});await h.api('/distributed');await h.api('/distributed/preview',input(),403);await h.api('/distributed/'+g.id+'/delete',{},403);
});

test('a failed preflight record without resources can never become Ready',async t=>{
 const h=await harness(t);h.setShared(false);const g=await h.api('/distributed',input(),201);assert.equal(g.status,'NeedsAttention');assert.equal(g.manifests.length,0);const checked=await h.api('/distributed/'+g.id+'/refresh',{});assert.equal(checked.status,'NeedsAttention');assert.throws(()=>h.traffic.enter({project_id:h.user.project_id,target_kind:'backend',target_id:h.store.put('backend',h.user.project_id,'blocked',{distributed_id:g.id}).id},'request'),/未就绪/);assert.equal((await h.api('/distributed/'+g.id+'/delete',{})).status,'Deleted');
});
