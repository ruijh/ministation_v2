import {Store,hash} from '../server/store.mjs';
import {randomBytes} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {createApp} from '../server/app.mjs';

const candidate=process.argv.includes('--candidate')?createApp({dataDir:'data'}):null;
const candidateServer=candidate?.app.listen(0,'127.0.0.1');
if(candidateServer)await new Promise(r=>candidateServer.once('listening',r));
const base=candidateServer?'http://127.0.0.1:'+candidateServer.address().port:'http://127.0.0.1:8787';
const textParts=process.argv.includes('--text-parts');

// Local operator acceptance: credentials remain encrypted in the running service.
// The maintenance session and scoped test key are removed/revoked in finally.
const s=new Store('data'), session=randomBytes(32).toString('hex');
const user=s.db.prepare("SELECT id,username,project_id FROM users WHERE role='admin' LIMIT 1").get();
assert.ok(user,'Initialize the administrator first');
const backend=s.list('backend',user.project_id).find(b=>b.upstream_model==='MiniMax-M3');
assert.ok(backend,'Save MiniMax-M3 in the console first');
const result={at:new Date().toISOString(),backend:backend.name,checks:[],passed:false,candidate:!!candidate,text_parts:textParts};
let key;
async function api(path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+session,'X-Ministation-Client':'console','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(180000)});const data=await r.json();if(!r.ok)throw Error(`${path}: ${r.status} ${data.error?.code}: ${data.error?.message}`);return data;}
try{
 s.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(session),user.id,Date.now()+600000);
 s.audit(user.project_id,user.username,'acceptance.start',backend.id,{method:'local-maintenance',suite:'minimax'});
 const probe=await api('/api/backends/'+backend.id+'/probe',{});assert.equal(probe.status,'EndpointValidated');result.checks.push({name:'connection',passed:true});
 let route=(await api('/api/routes')).find(r=>r.target_kind==='backend'&&r.target_id===backend.id&&r.enabled);
 if(!route)route=await api('/api/routes',{name:backend.logical_model,target_kind:'backend',target_id:backend.id});
 result.model=route.name;
 key=await api('/api/keys',{name:'MiniMax acceptance temporary',models:[route.name],expires:new Date(Date.now()+600000).toISOString(),rpm:10,tpm:100000,budget:100000});
 for(const stream of [false,true]){
  const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key.secret,'Content-Type':'application/json'},body:JSON.stringify({model:route.name,messages:[{role:'user',content:textParts?[{type:'text',text:'Reply with only OK.'}]:'Reply with only OK.'}],max_tokens:128,stream}),signal:AbortSignal.timeout(180000)});
  const request_id=response.headers.get('x-request-id');assert.equal(response.status,200);
  let content='',usage,done=true;
  if(stream){const text=await response.text();done=text.includes('data: [DONE]');for(const line of text.split('\n')){if(!line.startsWith('data:'))continue;const raw=line.slice(5).trim();if(raw==='[DONE]')continue;const event=JSON.parse(raw);assert.ok(!event.error,JSON.stringify(event.error));content+=event.choices?.[0]?.delta?.content||'';if(event.usage)usage=event.usage;}assert.ok(done,'SSE did not complete');}
  else{const data=await response.json();content=data.choices?.[0]?.message?.content||'';usage=data.usage;}
  assert.ok(content.trim(),'No visible model response');
  const row=(await api('/api/usage')).find(u=>u.id===request_id);assert.ok(row);assert.equal(row.status,'settled');assert.equal(row.input_tokens,usage.prompt_tokens);assert.equal(row.output_tokens,usage.completion_tokens);
  result.checks.push({name:stream?'stream':'non-stream',passed:true,request_id,response:content,usage,status:row.status,latency_ms:row.latency_ms,ttft_ms:row.ttft_ms,cost_micros:row.cost_micros});
 }
 result.passed=true;
}catch(e){result.error=e.message;process.exitCode=1;}
finally{
 if(key){try{await api('/api/keys/'+key.id+'/revoke',{});result.temporary_key_revoked=true;}catch{result.temporary_key_revoked=false;}}
 s.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(session));
 s.audit(user.project_id,user.username,'acceptance.finish',backend.id,{passed:result.passed});s.close();
 if(candidateServer){await new Promise(r=>candidateServer.close(r));await candidate.gateway.dispatcher.close();await candidate.kube.agent?.close();candidate.store.close();}
 mkdirSync('artifacts/minimax',{recursive:true});writeFileSync(textParts?'artifacts/minimax/text-parts-validation.json':'artifacts/minimax/validation.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
