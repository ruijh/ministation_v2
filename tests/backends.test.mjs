import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createApp} from '../server/app.mjs';

test('backend deletion allows unused services and blocks catalog references',async t=>{
 const {app,store,gateway}=createApp({dataDir:mkdtempSync(join('artifacts/tests','backends-')),upstreamHosts:['127.0.0.1']});
 const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await gateway.dispatcher.close();store.close();});
 const base='http://127.0.0.1:'+server.address().port;
 async function api(path,body,expected=200,headers={}){const r=await fetch(base+path,{method:body?'POST':(path.startsWith('/api/backends/')?'DELETE':'GET'),headers:{'content-type':'application/json','x-ministation-client':'console',...headers},body:body?JSON.stringify(body):undefined});const value=await r.json();assert.equal(r.status,expected,JSON.stringify(value));return value;}
 const me=await api('/api/auth/setup',{username:'admin',password:'integration-password'},201);
 const headers={cookie:''};
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json','x-ministation-client':'console'},body:JSON.stringify({username:'admin',password:'integration-password'})});headers.cookie=login.headers.get('set-cookie').split(';')[0];
 const unused=await api('/api/backends',{name:'unused',logical_model:'unused',upstream_model:'unused',base_url:'http://127.0.0.1:1/v1'},201,headers);
 await api('/api/backends/'+unused.id,null,200,headers);
 const backend=await api('/api/backends',{name:'used',logical_model:'used',upstream_model:'used',base_url:'http://127.0.0.1:1/v1'},201,headers);
 store.update('backend',backend.id,me.project_id,{status:'EndpointValidated'});
 await api('/api/routes',{name:'used',target_kind:'backend',target_id:backend.id},201,headers);
 await api('/api/backends/'+backend.id,null,409,headers);
 const route=(await api('/api/routes',null,200,headers))[0];
 await api('/api/routes/'+route.id+'/toggle',{enabled:false,version:route.version},200,headers);
 await api('/api/backends/'+backend.id,null,200,headers);
 assert.equal((await api('/api/routes',null,200,headers)).length,0);
});
