import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.mjs';
import {renderTpl,collectVars,yamlDump,yamlParse,BUILTIN_TEMPLATES} from '../server/templates.mjs';

mkdirSync('artifacts/tests',{recursive:true});
async function harness(t){
 const context=createApp({dataDir:mkdtempSync(join(resolve('artifacts/tests'),'tpl-'))});
 const server=context.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;let cookie='';
 t.after(async()=>{await context.local.stopAll();await context.runtime.stop();await context.observer.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await context.gateway.dispatcher.close();context.store.close();});
 const api=async(path,body,expected=200,headers={},method=body?'POST':'GET')=>{const r=await fetch(base+path,{method,headers:{cookie,'Content-Type':'application/json','X-Ministation-Client':'console',...headers},body:(method==='GET'||method==='DELETE')||body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const text=await r.text();if(!expected)return {status:r.status,text};let d;try{d=JSON.parse(text);}catch{d=text;}assert.equal(r.status,expected,typeof d==='string'?d:(JSON.stringify(d)));return d;};
 await api('/api/auth/setup',{username:'tpl-admin',password:'template-test-password'},201);
 return {api,context};
}

test('YAML 导出/导入往返一致（含变量与嵌套 spec）',async t=>{
 const sample={apiVersion:'ministation.io/v1',kind:'DeploymentTemplate',template:{name:'vllm-推理',description:'测试说明: 带冒号',scope:'cluster',kind:'llm',pinned:false,usage_count:0,
  variables:[{key:'image',label:'镜像',required:true},{key:'gpus',label:'GPU 数',required:false,default:'1'}],
  spec:{kind:'llm',image:'{{image}}@sha256:abc123',cpu:8,memory_gib:32,gpus:0,replicas:1,port:8000,health_path:'/health',command:[],args:['--model','{{hf_model}}','--gpu','2'],node_selector:{},labels:{enabled:'true',pool:'a-b'},model_pvc:'data-pvc',model_mount:'/models'}}};
 const dump=yamlDump(sample);const back=yamlParse(dump);
 assert.deepEqual(back,sample);const again=yamlDump(back);assert.equal(again,dump);
 // 简单对象也兼容
 assert.deepEqual(yamlParse(yamlDump({a:1,b:'x',c:true,d:null,e:[1,'two',false],f:{g:[{h:'i'},{j:'k'}]}})),{a:1,b:'x',c:true,d:null,e:[1,'two',false],f:{g:[{h:'i'},{j:'k'}]}});
});

test('renderTpl：参数替换、缺参、未声明占位符',async t=>{
 const declared=[{key:'image',label:'镜像',required:true},{key:'gpus',label:'GPU',required:false,default:'2'}];
 const spec={image:'{{image}}',args:['--tp','{{gpus}}'],meta:{n:5}};
 assert.throws(()=>renderTpl(spec,declared,{}),/镜像/);
 const out=renderTpl(spec,declared,{image:'repo/x:v1'});assert.equal(out.image,'repo/x:v1');assert.equal(out.args[1],'2');
 assert.throws(()=>renderTpl({image:'{{image}}',bad:'{{nope}}'},declared,{image:'x'}),/nope/);
 assert.deepEqual(collectVars(spec),['image','gpus']);
});

test('模板：导入 → 列表 → 渲染 → 编辑置顶 → 使用计数 → 导出 → 删除',async t=>{
 const {api}=await harness(t);
 const imported=await api('/api/templates/import',{yaml:yamlDump({apiVersion:'ministation.io/v1',template:{name:'导入模板',description:'从 YAML 导入',scope:'cluster',kind:'llm',variables:[{key:'image',label:'镜像',required:true}],spec:{kind:'llm',image:'{{image}}',cpu:2,memory_gib:4,gpus:0,replicas:1,port:8000,health_path:'/health',command:[],args:[],node_selector:{},labels:{}}}})},201);
 assert.equal(imported.name,'导入模板');
 // 同名导入自动加后缀
 const dup=await api('/api/templates/import',{yaml:yamlDump({template:{name:'导入模板',spec:{a:1}}})},201);assert.equal(dup.name,'导入模板-1');
 let list=await api('/api/templates');assert.equal(list.length,2);assert.ok(list.some(x=>x.pinned===false&&x.usage===0));
 // 渲染
 const tpl=list.find(x=>x.name==='导入模板');
 const rendered=await api('/api/templates/'+tpl.id+'/render',{values:{image:'repo/x@sha256:abc'}});assert.equal(rendered.spec.image,'repo/x@sha256:abc');
 // 缺参渲染报错
 const miss=await api('/api/templates/'+tpl.id+'/render',{values:{}},422);assert.ok(miss.error);
 // 编辑（置顶 + 改名）
 const edited=await api('/api/templates/'+tpl.id,{name:'导入模板v2',pinned:true,description:'升级'},200,{},'PUT');
 assert.equal(edited.pinned,true);assert.equal(edited.name,'导入模板v2');
 list=await api('/api/templates');assert.equal(list[0].name,'导入模板v2');
 // 使用计数
 const used=await api('/api/templates/'+tpl.id+'/use',{});assert.equal(used.usage_count,1);
 // 导出 YAML 可再次导入
 const yaml=await api('/api/templates/'+tpl.id+'/export',undefined,200,{},'GET');assert.ok(yaml.includes('imported_from'));
 // 删除
 await api('/api/templates/'+tpl.id,undefined,200,{},'DELETE');
 list=await api('/api/templates');assert.equal(list.some(x=>x.id===tpl.id),false);
});

test('内置模板目录：shape 完整、可渲染、缺必填报错',async t=>{
 assert.ok(BUILTIN_TEMPLATES.length>=7);
 const cat=BUILTIN_TEMPLATES.find(x=>x.name.includes('vLLM 大模型推理'));
 assert.equal(cat.scope,'cluster');
 assert.throws(()=>renderTpl(cat.spec,cat.variables,{image:'img'}),/模型仓库/);
 const out=renderTpl(cat.spec,cat.variables,{image:'img',hf_model:'Qwen/Qwen3',model_pvc:'p1'});assert.ok(out.image==='img'&&out.args.includes('Qwen/Qwen3'));
 const local=BUILTIN_TEMPLATES.find(x=>x.scope==='local'&&x.name.includes('vLLM'));
 const lo=renderTpl(local.spec,local.variables,{model_path:'/data/qwen',model_name:'my-model',port:'8082',gpus:'0',max_model_len:'8192'});
 assert.equal(lo.model,'/data/qwen');assert.equal(lo.port,'8082');
 // 静态访问：内置目录不进入项目模板列表
 const {api}=await harness(t);const c=await api('/api/templates/catalog');assert.ok(c.templates.length>=7);
});
