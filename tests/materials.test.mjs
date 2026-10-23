import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.mjs';
import {fitModel,normalizeMsDetail,MS_CATALOG,DEFAULT_DL_DIR} from '../server/materials.mjs';

mkdirSync('artifacts/tests',{recursive:true});
async function harness(t){
 const context=createApp({dataDir:mkdtempSync(join(resolve('artifacts/tests'),'mat-'))});
 const server=context.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;let cookie='';
 t.after(async()=>{await context.local.stopAll();await context.runtime.stop();await context.observer.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await context.gateway.dispatcher.close();context.store.close();});
 const api=async(path,body,expected=200,headers={},method=body?'POST':'GET')=>{const r=await fetch(base+path,{method,headers:{cookie,'Content-Type':'application/json','X-Ministation-Client':'console',...headers},body:(method==='GET'||method==='DELETE')&&body===undefined?undefined:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const d=await r.json().catch(()=>({}));assert.equal(r.status,expected,JSON.stringify(d));return d;};
 await api('/api/auth/setup',{username:'mat-admin',password:'materials-test-password'},201);
 return {api,base,cookie:()=>cookie};
}

test('fitModel：按 GPU/内存评估本机是否可运行',async t=>{
 const gpu2x48={gpu:{available:true,count:2,model:'L20',memory_mib:49152},memory_gib:377,disk_free_gib:1000};
 assert.equal(fitModel(33,gpu2x48).supported,true);       // 2×48G 可跑 33G（现网 Qwen3.6-35B 即 TP2 运行）
 assert.equal(fitModel(200,gpu2x48).supported,false);     // 超大 → 不支持
 const noGpu={gpu:null,memory_gib:128,disk_free_gib:1000};
 assert.equal(fitModel(200,noGpu).supported,false);       // 超出 CPU 内存 → 不支持
 const cpuOk=fitModel(8,noGpu);assert.equal(cpuOk.supported,true);
 const unknown=fitModel(0,gpu2x48);assert.equal(unknown.supported,null);
});

test('normalizeMsDetail：ModelScope 详情归一化',async t=>{
 const d=normalizeMsDetail({Path:'Qwen',Name:'Qwen2.5-7B-Instruct',ChineseName:'千问',Description:'desc',Architectures:['Qwen2ForCausalLM'],ModelType:['qwen2'],Tags:['chat'],License:'apache-2.0',Stars:5,Downloads:10,ModelInfos:{safetensor:{model_size:7615616512,files:[{size:1},{size:2}]}},StorageSize:15200000000,BackendSupport:{backend_info:{vllm:{}}}});
 assert.equal(d.id,'Qwen/Qwen2.5-7B-Instruct');assert.equal(d.architecture,'Qwen2ForCausalLM');assert.equal(d.weights_gib,7615616512/2**30);assert.equal(d.vllm_friendly,true);assert.equal(d.tasks.length,0);
});

test('本机扫描：根目录管理 + 扫描 + 描述批注 + 导入',async t=>{
 const {api}=await harness(t);
 const root=mkdtempSync(join(resolve('artifacts/tests'),'models-'));const model=join(root,'fake-model');mkdirSync(model,{recursive:true});
 writeFileSync(join(model,'config.json'),JSON.stringify({architectures:['FakeForCausalLM'],model_type:'fake',max_position_embeddings:4096}));
 writeFileSync(join(model,'model.safetensors'),JSON.stringify({x:1}));
 // 根目录管理：相对路径拒绝 / 不存在拒绝 / 添加 / 去重
 const rel=await api('/api/materials/roots',{path:'Models'},422);assert.equal(rel.error.code,'PATH_ABSOLUTE');
 const missing=await api('/api/materials/roots',{path:'/no/such/dir/x'},422);assert.equal(missing.error.code,'PATH_NOT_FOUND');
 await api('/api/materials/roots',{path:root},201);
 await api('/api/materials/roots',{path:root},409); // 幂等去重
 let roots=await api('/api/materials/roots');assert.ok(roots.some(r=>r.path===root&&r.source==='manual'&&r.exists));
 // 扫描：能看到 fake-model 及其 fit/描述
 let scan=await api('/api/materials/models');const m0=scan.models.find(m=>m.path===model);assert.ok(m0);assert.equal(m0.kind,'hf');assert.equal(m0.max_ctx,4096);assert.ok(m0.fit);
 // 自定义描述（PUT）
 await api('/api/materials/model-note',{path:model,description:'这是测试模型'},200,{},'PUT');
 scan=await api('/api/materials/models');assert.equal(scan.models.find(m=>m.path===model).description,'这是测试模型');
 // 导入为模型资产
 const imp=await api('/api/materials/import',{path:model},201);assert.equal(imp.model_name,model);
 assert.equal(imp.name,'fake-model');
 const again=await api('/api/materials/import',{path:model},201);
 assert.equal(again.name,'fake-model-1');
 assert.equal((await api('/api/materials/import',{path:model},201)).name,'fake-model-2');
 const list=await api('/api/models');assert.ok(list.some(m=>m.id===imp.id));
 // 本机部署模型列表也应包含该目录下的模型（DB 根目录参与扫描）
 const local=await api('/api/local/models');assert.ok(local.models.some(m=>m.path===model));
 // 删除根目录
 const rid=roots.find(r=>r.path===root).id;await api('/api/materials/roots/'+rid,undefined,200,{},'DELETE');
});

test('ModelScope 下载设置：缺省目录与自定义目录',async t=>{
 const {api}=await harness(t);
 const s=await api('/api/materials/modelscope/settings');
 assert.equal(s.dir,DEFAULT_DL_DIR);assert.ok(s.dir.endsWith('Models'));
 const dir=mkdtempSync(join(resolve('artifacts/tests'),'ms-dl-'));
 await api('/api/materials/modelscope/settings',{dir},200);
 assert.equal((await api('/api/materials/modelscope/settings')).dir,dir);
});

test('ModelScope 清单缓存：默认读缓存，仅刷新清单访问网络',async t=>{
 const {api,base}=await harness(t);const originalFetch=globalThis.fetch;let calls=0;
 const payload={Data:{Path:'Qwen',Name:'Qwen2.5-7B-Instruct',ModelInfos:{safetensor:{model_size:1,files:[]}},StorageSize:1}};
 globalThis.fetch=async(url,init)=>String(url).startsWith(base)?originalFetch(url,init):(()=>{calls++;return {ok:true,json:async()=>payload};})();
 try{
  const first=await api('/api/materials/modelscope/catalog');
  assert.equal(first.cached,false);assert.equal(first.models.length,MS_CATALOG.length);assert.equal(calls,MS_CATALOG.length);
  const second=await api('/api/materials/modelscope/catalog');
  assert.equal(second.cached,true);assert.equal(second.models.length,MS_CATALOG.length);assert.equal(second.updated_at,first.updated_at);assert.equal(calls,MS_CATALOG.length);
  const refreshed=await api('/api/materials/modelscope/catalog?refresh=1');
  assert.equal(refreshed.cached,false);assert.equal(refreshed.models.length,MS_CATALOG.length);assert.equal(calls,MS_CATALOG.length*2);
 }finally{globalThis.fetch=originalFetch;}
});
