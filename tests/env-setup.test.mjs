import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.mjs';
import {detectEnv,SETUP_STAGES} from '../server/env-setup.mjs';

async function harness(t){
 const context=createApp({dataDir:mkdtempSync(join(resolve('artifacts/tests'),'env-'))});
 const server=context.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;let cookie='';
 t.after(async()=>{await context.local.stopAll();await context.runtime.stop();await context.observer.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await context.gateway.dispatcher.close();context.store.close();});
 const api=async(path,body,expected=200,headers={})=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,'Content-Type':'application/json','X-Ministation-Client':'console',...headers},body:body?JSON.stringify(body):undefined});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;};
 await api('/api/auth/setup',{username:'env-admin',password:'env-test-password'},201);
 return {api,base,cookie:()=>cookie};
}

// 消费 SSE：返回 [{event,data}]
async function collectStream(base,cookie,stages){
 const response=await fetch(base+'/api/env-run',{method:'POST',headers:{cookie,'Content-Type':'application/json','X-Ministation-Client':'console'},body:JSON.stringify({stages})});
 assert.equal(response.status,200);
 const reader=response.body.getReader(),dec=new TextDecoder();let buf='',events=[];
 while(true){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});
  let idx;while((idx=buf.indexOf('\n\n'))!==-1){const block=buf.slice(0,idx);buf=buf.slice(idx+2);const evt={};
   for(const l of block.split('\n')){if(l.startsWith('event:'))evt.event=l.slice(6).trim();else if(l.startsWith('data:')){try{evt.data=JSON.parse(l.slice(5));}catch{}}}
   events.push(evt);}}
 return events;
}

test('环境初始化：detectEnv 与 /api/env-plan 结构',async t=>{
 const e=detectEnv();
 assert.equal(typeof e.gpu_count,'number');assert.equal(typeof e.is_root,'boolean');
 assert.ok(Array.isArray(e.gpu));assert.ok('cuda_home' in e&&'vllm_venv' in e&&'python_headers' in e&&'disk_free_gib' in e);
 const {api}=await harness(t);
 const plan=await api('/api/env-plan');
 assert.ok(plan.env.os.length>0);assert.equal(plan.stages.length,SETUP_STAGES.length);
 for(const s of plan.stages){
  assert.ok(s.id&&s.label&&s.phase);assert.ok(['install','deploy','config','verify','download'].includes(s.phase));
  assert.equal(typeof s.skip,'boolean');
 }
});

test('环境初始化：/api/env-run 以 SSE 推流并到达终态',async t=>{
 const {base,cookie:getCookie}=await harness(t);
 const ck=getCookie();
 const ids=SETUP_STAGES.map(s=>s.id);
 const events=await collectStream(base,ck,ids);
 // 每个选中的阶段都必须有 stage 事件（开始/ok/fail/skip）
 const started=new Set(events.filter(x=>x.event==='stage'&&x.data?.status==='start').map(x=>x.data.stage));
 for(const id of ids)assert.ok(started.has(id),'缺少阶段 '+id);
 const terminal=events[events.length-1];
 assert.ok(['done','error'].includes(terminal.event),'末尾应为 done 或 error，实际 '+terminal.event);
 // verify 阶段必须给出产出行
 assert.ok(events.some(x=>x.event==='line'&&x.data?.stage==='verify'));
 // 非法阶段应被拒（服务端只执行预定义阶段）
 const header={'cookie':ck,'Content-Type':'application/json','X-Ministation-Client':'console'};
 const bad=await fetch(base+'/api/env-run',{method:'POST',headers:header,body:JSON.stringify({stages:['rm -rf /']})});
 assert.equal(bad.status,422);
 // 未选择任何有效阶段 → 422
 const empty=await fetch(base+'/api/env-run',{method:'POST',headers:header,body:JSON.stringify({stages:[]})});
 assert.equal(empty.status,422);
});
