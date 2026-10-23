import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {readLogTail,localLogFindings} from '../server/local-logs.mjs';
import {collectPodLogs} from '../server/pod-logs.mjs';
import {Kubernetes} from '../server/kubernetes.mjs';

test('bounded log reads preserve byte counts and expose missing/truncated logs',()=>{
 mkdirSync('artifacts/tests',{recursive:true});const dir=mkdtempSync(resolve('artifacts/tests/log-')),path=join(dir,'engine.log');
 writeFileSync(path,'old data\n'.repeat(100000)+'最后一行\n');
 const log=readLogTail(path,{maxBytes:1024,lines:4});assert.ok(log.size>800000);assert.ok(log.bytes_read<=1024);assert.equal(log.truncated,true);assert.equal(log.lines.at(-1),'最后一行');
 assert.equal(readLogTail(join(dir,'missing')).error,'ENOENT');
 assert.deepEqual(localLogFindings(['INFO CUDA initialized','0 errors detected']),[]);
 assert.equal(localLogFindings(['torch.OutOfMemoryError: CUDA out of memory'])[0].code,'GPU_OOM');
});

test('cluster logs collect all containers and previous failures with partial-error evidence',async()=>{
 const calls=[];const kube={async logs(ns,pod,previous,container){calls.push({ns,pod,previous,container});if(container==='init')throw Object.assign(new Error('container not started'),{code:'KUBERNETES_ERROR'});return previous?'RuntimeError: failed to load weights':'INFO CUDA initialized';}};
 const pods=[{metadata:{name:'p1'},spec:{initContainers:[{name:'init'}],containers:[{name:'engine'},{name:'sidecar'}]},status:{containerStatuses:[{name:'engine',restartCount:1}]}},{metadata:{name:'p2'},spec:{containers:[{name:'engine'}]}}];
 const result=await collectPodLogs(kube,'models',pods);
 assert.equal(result.logs.length,5);assert.equal(result.logs.filter(l=>!l.available).length,1);
 assert.equal(result.logs.find(l=>l.previous).findings[0].code,'ENGINE_ERROR');
 assert.ok(calls.some(c=>c.pod==='p2'));assert.match(result.text,/previous/);assert.match(result.text,/container not started/);
 const limited=await collectPodLogs(kube,'models',pods,{maxSources:2});assert.equal(limited.truncated,true);assert.equal(limited.total_sources,5);
});

test('Kubernetes log requests select container, timestamp and bound response size',async()=>{
 const kube=new Kubernetes({});let path;kube.request=async p=>{path=p;return 'logs';};
 await kube.logs('space','pod',true,'engine');const url=new URL(path,'https://example.invalid');
 assert.equal(url.searchParams.get('container'),'engine');assert.equal(url.searchParams.get('previous'),'true');assert.equal(url.searchParams.get('timestamps'),'true');assert.equal(url.searchParams.get('limitBytes'),'262144');
});

test('cluster log endpoint rejects an unknown pod instead of returning a different pod',async t=>{
 const {default:express}=await import('express');const {installLifecycle}=await import('../server/lifecycle.mjs');
 const app=express();const kube={request:async()=>({items:[{metadata:{name:'owned'},spec:{containers:[{name:'engine'}]}}]}),logs:async()=> 'engine output'};
 installLifecycle(app,{s:{get:()=>({namespace:'models'})},kube,get:()=>({id:'d',resource_name:'d'}),write(){},audit(){}});
 app.use((error,req,res,next)=>res.status(error.status||500).json({code:error.code}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
 const base='http://127.0.0.1:'+server.address().port+'/api/deployments/d/logs';
 const response=await fetch(base+'?pod=foreign');assert.equal(response.status,404);assert.equal((await response.json()).code,'POD_NOT_FOUND');
 const unknown=await fetch(base+'?pod=owned&container=foreign');assert.equal(unknown.status,404);await unknown.text();
 const all=await fetch(base);assert.equal(all.status,200);assert.match((await all.json()).text,/engine output/);
});
