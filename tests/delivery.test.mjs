import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {createApp} from '../server/app.mjs';
import {RequestQueue} from '../server/queue.mjs';
import {createWebhooks} from '../server/webhooks.mjs';
async function server(t,s){s.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));t.after(()=>{s.closeAllConnections();s.close();});return 'http://127.0.0.1:'+s.address().port;}
async function harness(t){mkdirSync('artifacts/tests',{recursive:true});const h=createApp({dataDir:mkdtempSync('artifacts/tests/delivery-'),webhookHosts:['127.0.0.1'],upstreamHosts:['127.0.0.1']});const base=await server(t,http.createServer(h.app));let cookie='';const api=async(path,body,status=200,headers={})=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-ministation-client':'console',...headers},body:body?JSON.stringify(body):undefined});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;};const me=await api('/api/auth/setup',{username:'delivery-admin',password:'delivery-test-password'},201);t.after(async()=>{await h.webhooks.stop();await h.gateway.dispatcher.close();h.store.close();});return {...h,base,api,me};}
test('Webhook signs real HTTP delivery, retries with stable ID, redacts secrets and preserves outbox',async t=>{
 const h=await harness(t),received=[];let response=503;
 const url=await server(t,http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;received.push({headers:req.headers,raw});res.writeHead(response);res.end();}));
 await h.api('/api/webhooks',{name:'bad',url:'http://not-allowed.example/hook',signing_secret:'test-signing-secret'},422);
 const c=await h.api('/api/webhooks',{name:'local hook',url:url+'/hook',signing_secret:'test-signing-secret',enabled:true},201);assert.equal(c.secret,undefined);assert.equal(c.url_secret,undefined);assert.equal(c.url,undefined);
 const event={id:'event-1',type:'alert.firing'};h.webhooks.enqueue(h.me.project_id,event);h.webhooks.enqueue(h.me.project_id,event);assert.equal(h.store.list('webhook_delivery',h.me.project_id).length,1);
 await h.webhooks.process();let d=h.store.list('webhook_delivery',h.me.project_id)[0];assert.equal(d.status,'Pending');assert.equal(d.attempts,1);
 response=204;h.store.update('webhook_delivery',d.id,h.me.project_id,{next_at:0});await h.webhooks.process();d=h.store.get('webhook_delivery',d.id,h.me.project_id);assert.equal(d.status,'Delivered');assert.equal(received.length,2);assert.equal(received[0].headers['x-ministation-event-id'],received[1].headers['x-ministation-event-id']);
 const r=received[0];assert.equal(r.headers['x-ministation-signature'],'sha256='+createHmac('sha256','test-signing-secret').update(r.headers['x-ministation-timestamp']+'.'+r.raw).digest('hex'));
 const stored=h.store.get('webhook',c.id,h.me.project_id);assert.ok(!JSON.stringify(stored).includes('test-signing-secret'));assert.equal(h.store.unseal(stored.url_secret),url+'/hook');
 await h.api('/api/webhooks/'+c.id+'/test',{},202);await h.api('/api/webhooks/'+c.id+'/toggle',{enabled:false,version:c.version});await h.webhooks.process();assert.equal(received.length,2);assert.ok(h.store.list('webhook_delivery',h.me.project_id).some(d=>d.status==='Cancelled'));
 const other=await h.api('/api/projects',{name:'Other delivery',namespace:'delivery-other',cpu_quota:1,memory_quota:1,gpu_quota:0},201);assert.equal((await h.api('/api/webhooks',null,200,{'X-Project-Id':other.id})).channels.length,0);
 await h.api('/api/users',{username:'delivery-viewer',password:'delivery-viewer-password',role:'viewer',project_id:h.me.project_id},201);await h.api('/api/auth/login',{username:'delivery-viewer',password:'delivery-viewer-password'});await h.api('/api/webhooks',null,403);await h.api('/api/request-queue',{enabled:true,max_active:1,max_waiting:1,wait_seconds:1},403);
});
test('Alert incident sends one firing and one recovery even through unknown samples',async t=>{
 const h=await harness(t),p=h.me.project_id;await h.api('/api/webhooks',{name:'alerts',url:'http://127.0.0.1/hook',signing_secret:'test-signing-secret',enabled:true},201);
 const d=h.store.put('deployment',p,'test deployment',{spec:{}});h.store.put('alert_rule',p,'cpu',{enabled:true,deployment_id:d.id,metric:'cpu_percent',threshold:50,consecutive:1});const telemetry=h.store.put('telemetry',p,'cpu data',{cpu_percent:80,sampled_at:new Date().toISOString()},'telemetry:'+d.id);
 h.runtime.evaluateAlerts(p);h.runtime.evaluateAlerts(p);assert.equal(h.store.list('webhook_delivery',p).length,1);
 h.store.update('telemetry',telemetry.id,p,{sampled_at:'2000-01-01'});h.runtime.evaluateAlerts(p);h.store.update('telemetry',telemetry.id,p,{cpu_percent:10,sampled_at:new Date().toISOString()});h.runtime.evaluateAlerts(p);assert.deepEqual(h.store.list('webhook_delivery',p).map(d=>d.event.type).sort(),['alert.firing','alert.resolved']);
});
test('Webhook resumes persisted jobs, stops permanent errors and caps retry attempts',async t=>{
 const h=await harness(t);let code=503,count=0;const url=await server(t,http.createServer((req,res)=>{count++;res.writeHead(code);res.end();}));
 await h.api('/api/webhooks',{name:'retry hook',url,signing_secret:'test-signing-secret',enabled:true},201);h.webhooks.enqueue(h.me.project_id,{id:'retry-id',type:'test'});
 const worker=createWebhooks(h.store,h.config);for(let i=0;i<5;i++){const job=h.store.list('webhook_delivery',h.me.project_id)[0];h.store.update('webhook_delivery',job.id,h.me.project_id,{next_at:0});await worker.process();}
 let job=h.store.list('webhook_delivery',h.me.project_id)[0];assert.equal(job.status,'Failed');assert.equal(job.attempts,5);await worker.process();assert.equal(count,5);
 code=400;worker.enqueue(h.me.project_id,{id:'bad-request',type:'test'});await worker.process();job=h.store.list('webhook_delivery',h.me.project_id).find(d=>d.event.id==='bad-request');assert.equal(job.status,'Failed');assert.equal(job.attempts,1);await worker.stop();
});
test('Queue enforces FIFO, project isolation, overflow, timeout and cancellation',async t=>{
 const h=await harness(t),q=h.queue,p=h.me.project_id;await h.api('/api/request-queue',{enabled:true,max_active:1,max_waiting:2,wait_seconds:1});const first=await q.acquire(p,new AbortController().signal),order=[];
 const a=q.acquire(p,new AbortController().signal).then(release=>{order.push('a');return release;}),ctrl=new AbortController(),b=q.acquire(p,ctrl.signal).catch(e=>e);
 await assert.rejects(q.acquire(p,new AbortController().signal),e=>e.code==='QUEUE_FULL');const other=await q.acquire('other',new AbortController().signal);other();ctrl.abort();assert.equal((await b).code,'REQUEST_CANCELLED');first();const release=await a;assert.deepEqual(order,['a']);
 const timeout=q.acquire(p,new AbortController().signal);await assert.rejects(timeout,e=>e.code==='QUEUE_TIMEOUT');release();assert.equal(q.snapshot(p).active,0);assert.equal(q.snapshot(p).waiting,0);
});
test('Queued gateway request holds no budget and rechecks revoked key before dispatch',async t=>{
 const h=await harness(t),p=h.me.project_id;const b=h.store.put('backend',p,'backend',{status:'EndpointValidated',protocol:'chat',base_url:'http://127.0.0.1:1/v1',upstream_model:'m',timeout_seconds:1});h.store.put('route',p,'m',{enabled:true,target_kind:'backend',target_id:b.id});
 const key=await h.api('/api/keys',{name:'queued',models:['m'],expires:new Date(Date.now()+3600000).toISOString()},201);await h.api('/api/request-queue',{enabled:true,max_active:1,max_waiting:2,wait_seconds:3});const release=await h.queue.acquire(p,new AbortController().signal);
 const pending=fetch(h.base+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+key.secret},body:JSON.stringify({model:'m',messages:[{role:'user',content:'Hi'}],max_tokens:1})});
 for(let i=0;i<100&&h.queue.snapshot(p).waiting===0;i++)await new Promise(r=>setTimeout(r,5));assert.equal(h.queue.snapshot(p).waiting,1);assert.equal(h.store.db.prepare('SELECT count(*) n FROM reservations').get().n,0);
 await h.api('/api/request-queue',{enabled:false,max_active:1,max_waiting:2,wait_seconds:3,version:1},409);await h.api('/api/keys/'+key.id+'/revoke',{});release();const result=await pending;assert.equal(result.status,401);await result.text();assert.equal(h.store.db.prepare('SELECT count(*) n FROM reservations').get().n,0);
});
