import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.mjs';

async function harness(t){
 const context=createApp({dataDir:mkdtempSync(join(resolve('artifacts/tests'),'settings-'))});
 const server=context.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;let cookie='';
 t.after(async()=>{await context.local.stopAll();await context.runtime.stop();await context.observer.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await context.gateway.dispatcher.close();context.store.close();});
 const api=async(path,body,expected=200,headers={},method=body?'POST':'GET')=>{const r=await fetch(base+path,{method,headers:{cookie,'Content-Type':'application/json','X-Ministation-Client':'console',...headers},body:(method==='GET'||method==='DELETE')&&body===undefined?undefined:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const d=await r.json().catch(()=>({}));assert.equal(r.status,expected,JSON.stringify(d));return d;};
 await api('/api/auth/setup',{username:'set-admin',password:'settings-test-password'},201);
 return {api,base,cookie:()=>cookie};
}

test('项目：编辑（改名/配额，命名空间只读）与版本冲突',async t=>{
 const {api}=await harness(t);
 const p=await api('/api/projects',{name:'项目A',namespace:'proj-a',cpu_quota:8,memory_quota:32,gpu_quota:2,token_budget:5000000},201);
 const edit=await api('/api/projects/'+p.id,{name:'项目A改',namespace:p.namespace,cpu_quota:4,memory_quota:16,gpu_quota:1,token_budget:3000000,version:p.version},200,{},'PUT');
 assert.equal(edit.name,'项目A改');assert.equal(edit.cpu_quota,4);assert.equal(edit.namespace,'proj-a');assert.deepEqual(edit.warnings,[]);
 // 命名空间不可改
 const ns=await api('/api/projects/'+p.id,{name:'项目A改',namespace:'proj-b',cpu_quota:4,memory_quota:16,gpu_quota:1,token_budget:3000000,version:edit.version},422,{},'PUT');
 assert.equal(ns.error.code,'NAMESPACE_IMMUTABLE');
 // 版本冲突
 const conflict=await api('/api/projects/'+p.id,{name:'项目A改',namespace:p.namespace,cpu_quota:4,memory_quota:16,gpu_quota:1,token_budget:3000000,version:1},409,{},'PUT');
 assert.equal(conflict.error.code,'VERSION_CONFLICT');
 // 重名
 const p2=await api('/api/projects',{name:'项目B',namespace:'proj-b',cpu_quota:8,memory_quota:32,gpu_quota:2,token_budget:5000000},201);
 const dup=await api('/api/projects/'+p2.id,{name:'项目A改',namespace:p2.namespace,cpu_quota:8,memory_quota:32,gpu_quota:2,token_budget:5000000,version:p2.version},409,{},'PUT');
 assert.equal(dup.error.code,'NAME_EXISTS');
});

test('项目：删除需先清空成员与业务对象',async t=>{
 const {api}=await harness(t);
 const a=await api('/api/projects',{name:'空项目',namespace:'empty-a',cpu_quota:4,memory_quota:8,gpu_quota:0,token_budget:1000000},201);
 assert.equal((await api('/api/projects/'+a.id,undefined,200,{},'DELETE')).ok,true);
 // 有成员 → 拒绝
 const b=await api('/api/projects',{name:'有成员',namespace:'has-user',cpu_quota:4,memory_quota:8,gpu_quota:0,token_budget:1000000},201);
 await api('/api/users',{username:'member1',password:'member-pass-000000',role:'developer',project_id:b.id},201);
 const bu=await api('/api/projects/'+b.id,undefined,409,{},'DELETE');
 assert.equal(bu.error.code,'PROJECT_HAS_MEMBERS');
 // 有业务对象 → 拒绝（对象必须落在该项目下，用 X-Project-Id 指定目标项目）
 const c=await api('/api/projects',{name:'有对象',namespace:'has-object',cpu_quota:4,memory_quota:8,gpu_quota:0,token_budget:1000000},201);
 await api('/api/models',{name:'外部模型',model_name:'ext/model',model_version:'1',task:'chat',source:'external'},201,{'X-Project-Id':c.id});
 const cu=await api('/api/projects/'+c.id,undefined,409,{},'DELETE');
 assert.equal(cu.error.code,'PROJECT_NOT_EMPTY');
});

test('成员：编辑角色/改项目/重置密码/删除，自我保护',async t=>{
 const {api,base,cookie}=await harness(t);
 const dev=await api('/api/users',{username:'dev1',password:'dev-pass-000001',role:'developer',project_id:(await api('/api/projects'))[0].id},201);
 const upd=await api('/api/users/'+dev.id,{role:'viewer'},200,{},'PUT');
 assert.equal(upd.role,'viewer');
 // 改回到某项目
 const np=await api('/api/projects',{name:'第二项目',namespace:'second-x',cpu_quota:2,memory_quota:4,gpu_quota:0,token_budget:500000},201);
 const moved=await api('/api/users/'+dev.id,{project_id:np.id},200,{},'PUT');
 assert.equal(moved.project_id,np.id);
 // 重置密码
 const pwd=await api('/api/users/'+dev.id,{password:'dev-pass-000002'},200,{},'PUT');
 assert.equal(pwd.password_changed,true);assert.equal(pwd.session_invalidated,true);
 // 管理员不能降级自己
 const me=(await api('/api/me')).id;
 const selfLock=await api('/api/users/'+me,{role:'viewer'},403,{},'PUT');
 assert.equal(selfLock.error.code,'SELF_LOCKOUT');
 // 删除成员；不能删除自己
 assert.equal((await api('/api/users/'+dev.id,undefined,200,{},'DELETE')).ok,true);
 const selfDel=await api('/api/users/'+me,undefined,403,{},'DELETE');
 assert.equal(selfDel.error.code,'SELF_DELETE');
 // 成员（非管理员）不能再建项目/改项目
 await api('/api/users',{username:'dev2',password:'dev-pass-000003',role:'developer',project_id:np.id},201);
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Ministation-Client':'console'},body:JSON.stringify({username:'dev2',password:'dev-pass-000003'})});
 const devCookie=login.headers.get('set-cookie').split(';')[0];
 const devProj=await api('/api/projects',{name:'开发者想建',namespace:'dev-wants',cpu_quota:1,memory_quota:1,gpu_quota:0,token_budget:10},403,{cookie:devCookie,'X-Project-Id':np.id});
 assert.equal(devProj.error.code,'ROLE_FORBIDDEN');
});

test('/api/settings 返回成员列表',async t=>{
 const {api}=await harness(t);
 const s=await api('/api/settings');
 assert.ok(Array.isArray(s.members));assert.equal(s.members[0].role,'admin');
});
