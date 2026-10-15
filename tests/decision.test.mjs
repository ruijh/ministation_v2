import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createApp} from '../server/app.mjs';
import {decisionProbe,normalizeDecision,parseDecision} from '../server/decision.mjs';

test('decision gateway preserves typed results, authorization, protocol boundaries and actual input accounting',async t=>{
 let calls=0;
 const upstream=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const b=JSON.parse(raw);calls++;if(req.url==='/chat/completions'){assert.equal(b.decisions,undefined);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:b.model+':'+b.messages[0].content}}],usage:{prompt_tokens:12,completion_tokens:4}}));return;}assert.equal(req.url,'/api/decide');res.setHeader('Content-Type','application/json');const results=b.criteria.map(c=>({id:c.id,winner:c.options[0].id,ranked:c.options.map((o,i)=>({id:o.id,prob:i?0.2:0.8})),...(b.model==='unknown'?{}:{input_tokens:37})}));if(b.model==='bad')results[0].ranked[0].prob=2;res.end(JSON.stringify({results}));});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));mkdirSync('artifacts/tests',{recursive:true});
 const {app,store,gateway}=createApp({dataDir:mkdtempSync(join(resolve('artifacts/tests'),'decision-')),upstreamHosts:['127.0.0.1']});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await new Promise(r=>upstream.close(r));await gateway.dispatcher.close();store.close();});
 let cookie='';const base='http://127.0.0.1:'+server.address().port;
 async function api(path,body,status=200,headers={}){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,'Content-Type':'application/json','X-Ministation-Client':'console',...headers},...(body?{body:JSON.stringify(body)}:{})});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;}
 const user=await api('/api/auth/setup',{username:'decision-admin',password:'decision-test-password'},201);
 const backend=await api('/api/backends',{name:'CPU',logical_model:'cpu',upstream_model:'qwen',protocol:'decision',base_url:'http://127.0.0.1:'+upstream.address().port,input_rate:2},201);
 await api('/api/routes',{name:'cpu',target_kind:'backend',target_id:backend.id},422);
 await api('/api/backends/'+backend.id+'/probe',{});await api('/api/routes',{name:'cpu',target_kind:'backend',target_id:backend.id},201);
 assert.equal((await api('/api/routes'))[0].protocol,'decision');
 const key=await api('/api/keys',{name:'cpu',models:['cpu'],expires:new Date(Date.now()+3600000).toISOString()},201),headers={Authorization:'Bearer '+key.secret},body={model:'cpu',...decisionProbe};
 await api('/v1/decisions',body,401);const output=await api('/v1/decisions',body,200,headers);assert.equal(output.results[0].winner,'billing');assert.equal(output.usage.prompt_tokens,37);assert.equal(output.usage.completion_tokens,0);
 const usage=await api('/api/usage');assert.equal(usage[0].status,'settled');assert.equal(usage[0].cost_micros,74);assert.equal((await api('/api/keys'))[0].reserved,0);
 const before=calls;
 await api('/v1/decisions',{...body,stream:true},422,headers);
 await api('/v1/decisions',{...body,criteria:[body.criteria[0],body.criteria[0]]},422,headers);
 await api('/v1/decisions',{...body,model:'other'},403,headers);
 await api('/v1/chat/completions',{model:'cpu',messages:[{role:'user',content:'hello'}]},422,headers);
 assert.equal(calls,before);
 store.update('backend',backend.id,user.project_id,{upstream_model:'unknown'});
 const missing=await api('/v1/decisions',body,200,headers);assert.equal(missing.usage,undefined);assert.ok((await api('/api/usage')).some(u=>u.status==='pending'&&u.input_tokens===null));
 store.update('backend',backend.id,user.project_id,{upstream_model:'bad'});await api('/v1/decisions',body,502,headers);

 store.update('backend',backend.id,user.project_id,{upstream_model:'qwen'});
 const chatIds=[];for(const name of ['selected','fallback']){const chat=await api('/api/backends',{name,logical_model:name,upstream_model:name,protocol:'chat',base_url:'http://127.0.0.1:'+upstream.address().port},201);await api('/api/backends/'+chat.id+'/probe',{});chatIds.push(chat.id);}
 const graph={id:'route',type:'decision',backend_id:backend.id,criteria:decisionProbe.criteria,min_probability:0.7,children:[{id:'chosen',type:'service',backend_id:chatIds[0],condition:{field:'decisions.route.winner',op:'eq',value:'billing'}},{id:'default',type:'service',backend_id:chatIds[1],default:true}]};
 const flow=await api('/api/flows',{name:'decision-flow',graph},201);await api('/api/routes',{name:'decision-flow',target_kind:'flow',target_id:flow.id},201);const flowKey=await api('/api/keys',{name:'flow',models:['decision-flow'],expires:new Date(Date.now()+3600000).toISOString()},201);const flowBody={model:'decision-flow',messages:[{role:'user',content:'refund original input'}],max_tokens:20},flowHeaders={Authorization:'Bearer '+flowKey.secret};
 let flowResult=await api('/v1/chat/completions',flowBody,200,flowHeaders);assert.equal(flowResult.choices[0].message.content,'selected:refund original input');assert.equal(flowResult.usage.prompt_tokens,49);
 store.update('flow',flow.id,user.project_id,{graph:{...graph,min_probability:0.95}});flowResult=await api('/v1/chat/completions',flowBody,200,flowHeaders);assert.match(flowResult.choices[0].message.content,/^fallback:/);
 store.update('backend',backend.id,user.project_id,{upstream_model:'bad'});flowResult=await api('/v1/chat/completions',flowBody,200,flowHeaders);assert.match(flowResult.choices[0].message.content,/^fallback:/);assert.equal(flowResult.usage,undefined);
 const otherProject=await api('/api/projects',{name:'Other',namespace:'other',cpu_quota:1,memory_quota:1,gpu_quota:0},201);await api('/api/flows',{name:'cross-project',graph},422,{'X-Project-Id':otherProject.id});
 await api('/api/keys/'+key.id+'/revoke',{});await api('/v1/decisions',body,401,headers);
});

test('decision response rejects missing questions, invalid probabilities and unknown options',()=>{
 const body={model:'cpu',...decisionProbe};assert.throws(()=>parseDecision({...body,state:{}}));
 for(const ranked of [[{id:'billing',prob:0.2},{id:'technical',prob:0.2}],[{id:'billing',prob:0.8},{id:'unknown',prob:0.2}],[{id:'billing',prob:NaN},{id:'technical',prob:0.2}]])assert.throws(()=>normalizeDecision({results:[{id:'route',winner:'billing',ranked}]},body));
 assert.throws(()=>normalizeDecision({results:[]},body));
});
