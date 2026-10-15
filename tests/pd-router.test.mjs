import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createPDRouter} from '../server/pd-router.mjs';

async function listen(t,server){server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});return 'http://127.0.0.1:'+server.address().port;}
const kv={remote_engine_id:'engine-p',remote_block_ids:[1,2],remote_host:'10.0.0.2',remote_port:5600,do_remote_prefill:true,do_remote_decode:false};
const body={model:'model',messages:[{role:'user',content:'你好'}],max_tokens:20};
async function fixture(t,options={}){
 const calls=[];
 const upstream=await listen(t,http.createServer(async(req,res)=>{
  if(req.url==='/health'){res.writeHead(options.unhealthy?503:200);return res.end('{}');}
  let raw='';for await(const c of req)raw+=c;const data=JSON.parse(raw);calls.push({data,id:req.headers['x-request-id']});
  const prefill=data.kv_transfer_params?.do_remote_decode;
  if(prefill&&options.prefillFailure){res.writeHead(503);return res.end('{}');}
  if(options.slow){setTimeout(()=>res.end('{}'),100);return;}
  if(prefill)return res.end(JSON.stringify({kv_transfer_params:options.missing?null:kv,usage:{prompt_tokens:500,completion_tokens:1}}));
  if(options.decodeFailure){res.writeHead(429);return res.end('{}');}
  if(data.stream){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'你好'}}],kv_transfer_params:kv})+'\r\n\r\n');res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7}})+'\n\n');res.end('data: [DONE]\n\n');}
  else res.end(JSON.stringify({choices:[{message:{content:'你好'}}],usage:{prompt_tokens:5,completion_tokens:2,total_tokens:7},kv_transfer_params:kv}));
 }));
 const router=await listen(t,createPDRouter({prefill:[upstream],decode:[upstream],model:'model',timeout_ms:options.timeout||1000,max_inflight:1}));
 return {calls,router,post:data=>fetch(router+'/v1/chat/completions',{method:'POST',body:JSON.stringify(data),headers:{'content-type':'application/json'}})};
}
test('PD HTTP performs KV handoff, correlates requests and returns Decode usage exactly once',async t=>{
 const h=await fixture(t);const r=await h.post({...body,min_tokens:3,max_completion_tokens:20});assert.equal(r.status,200);const result=await r.json();assert.equal(result.usage.total_tokens,7);assert.equal(result.kv_transfer_params,undefined);assert.equal(h.calls.length,2);assert.equal(h.calls[0].data.messages[0].content,'你好');assert.equal(h.calls[0].data.max_completion_tokens,1);assert.equal(h.calls[0].data.min_tokens,undefined);assert.equal(h.calls[1].data.min_tokens,3);assert.deepEqual(h.calls[1].data.kv_transfer_params,kv);assert.equal(h.calls[0].id,h.calls[1].id);assert.equal(h.calls[1].data.max_tokens,20);
 assert.equal((await fetch(h.router+'/health')).status,200);
});
test('PD SSE preserves content and final usage while hiding transfer metadata',async t=>{
 const h=await fixture(t),r=await h.post({...body,stream:true,stream_options:{include_usage:true}}),text=await r.text();assert.equal(r.status,200);assert.match(text,/你好/);assert.match(text,/"total_tokens":7/);assert.match(text,/\[DONE\]/);assert.doesNotMatch(text,/remote_host|kv_transfer/);assert.equal(h.calls[0].data.stream,false);assert.equal(h.calls[0].data.stream_options,undefined);assert.equal(h.calls[1].data.stream_options.include_usage,true);
});
test('PD rejects missing handoff and Prefill failures without calling Decode',async t=>{
 for(const options of [{missing:true},{prefillFailure:true}]){const h=await fixture(t,options),r=await h.post(body);assert.equal(r.status,options.missing?502:503);await r.text();assert.equal(h.calls.length,1);}
 const h=await fixture(t,{decodeFailure:true});assert.equal((await h.post(body)).status,429);assert.equal(h.calls.length,2);
});
test('PD bounds requests and rejects client-controlled KV routing',async t=>{
 const h=await fixture(t);for(const bad of [{...body,kv_transfer_params:kv},{...body,model:'other'},{...body,n:2},{...body,messages:[{role:'user',content:[]}]}]){const r=await h.post(bad);assert.equal(r.status,400);await r.text();}assert.equal(h.calls.length,0);
 const slow=await fixture(t,{slow:true,timeout:30});assert.equal((await slow.post(body)).status,504);
 const unhealthy=await fixture(t,{unhealthy:true});assert.equal((await fetch(unhealthy.router+'/health')).status,502);
});
test('PD disconnect aborts upstream and releases concurrency without retry',async t=>{
 let started,closed;const began=new Promise(r=>started=r),cancelled=new Promise(r=>closed=r);
 const upstream=await listen(t,http.createServer(async(req,res)=>{for await(const _ of req){}res.on('close',closed);started();}));
 const router=await listen(t,createPDRouter({prefill:[upstream],decode:[upstream],model:'model',timeout_ms:3000,max_inflight:1}));
 const controller=new AbortController();const request=fetch(router+'/v1/chat/completions',{method:'POST',body:JSON.stringify(body),signal:controller.signal}).catch(e=>e);
 await began;const blocked=await fetch(router+'/v1/chat/completions',{method:'POST',body:JSON.stringify(body)});assert.equal(blocked.status,429);await blocked.text();controller.abort();await request;await cancelled;
 const rejected=await fetch(router+'/v1/chat/completions',{method:'POST',body:JSON.stringify({...body,model:'wrong'})});assert.equal(rejected.status,400);await rejected.text();
});
