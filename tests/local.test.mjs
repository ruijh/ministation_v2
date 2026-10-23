import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {createServer,Server} from 'node:net';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.mjs';
import {createLocalDeployments,detectHost,localEnvironment,recommendParams,buildCommand} from '../server/local.mjs';
import {listModelRoots,scanModelRoot,probeEngines} from '../server/model-scan.mjs';
import {Store} from '../server/store.mjs';

mkdirSync('artifacts/tests',{recursive:true});

// 一个极小的 OpenAI 兼容引擎，用于端到端验证本机部署（不依赖 GPU / llama.cpp）
const stub = join(resolve('artifacts/tests'),'stub-engine.mjs');
writeFileSync(stub, `
import {createServer} from 'node:http';
const argv=process.argv.slice(2),pick=k=>{const i=argv.indexOf('--'+k);return i>=0?argv[i+1]:null;};
const port=Number(pick('port')||8090),model=pick('served-model-name')||'stub';
createServer(async(req,res)=>{const url=req.url.split('?')[0];res.setHeader('Content-Type','application/json');
 if(url==='/health')return res.end(JSON.stringify({status:'ok'}));
 if(url==='/v1/models')return res.end(JSON.stringify({object:'list',data:[{id:model}]}));
 if(url==='/v1/chat/completions'){let b='';for await(const c of req)b+=c;try{const body=JSON.parse(b||'{}');const content=(body.messages||[]).map(m=>m.content).join('|')||'ok';return res.end(JSON.stringify({choices:[{message:{role:'assistant',content}}],usage:{prompt_tokens:10,completion_tokens:5}}));}catch{return res.statusCode=400,res.end('{}');}}
 res.statusCode=404;res.end(JSON.stringify({error:'not found'}));}).listen(port,'127.0.0.1',()=>console.log('stub ready '+port));
`);

async function freePort(){return new Promise(resolve=>{const srv=createServer();srv.listen(0,'127.0.0.1',()=>{const p=srv.address().port;srv.close(()=>resolve(p));});});}

async function harness(t,overrides={}){
 const context=createApp({dataDir:mkdtempSync(join(resolve('artifacts/tests'),'local-')),...overrides});
 const server=context.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;let cookie='';
 t.after(async()=>{await context.local.stopAll();await context.runtime.stop();await context.observer.stop();server.closeAllConnections();await new Promise(r=>server.close(r));await context.gateway.dispatcher.close();context.store.close();});
 const api=async(path,body,expected=200,headers={})=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{cookie,'Content-Type':'application/json','X-Ministation-Client':'console',...headers},body:body?JSON.stringify(body):undefined});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;};
 const user=await api('/api/auth/setup',{username:'local-admin',password:'local-test-password'},201);
 return {...context,api,user,base,cookie:()=>cookie};
}

test('本机部署完整链路：部署→接入→发布→调用→用量',async t=>{
 const {api,store,user,base,cookie}=await harness(t);
 const port=await freePort();
 const created=await api('/api/local',{name:'本地 llama',engine:'custom',model:stub,served_model:'stub-model',port,command:['node',stub],args:['--port',String(port),'--served-model-name','stub-model']},201);
 assert.equal(created.status,'Starting');assert.ok(created.id);

 // 环境检测 target=local
 const env=await api('/api/deployment-guide/environment?target=local');assert.equal(env.state,'local');assert.ok(env.host.cpu_cores>0);assert.ok(env.recommendation.resources.cpu>=1);

 // 等待运行
 let rec;for(let i=0;i<40;i++){rec=await api('/api/local/'+created.id);if(rec.status==='Running')break;await new Promise(r=>setTimeout(r,250));}
 assert.equal(rec.status,'Running',rec.reason+(rec.log?.lines||[]).join('\n'));assert.ok(rec.healthy);assert.ok(rec.ready_at);assert.deepEqual(rec.findings,[]);assert.ok(rec.log.lines.some(l=>/ready/.test(l)));
 assert.equal(rec.base_url,`http://127.0.0.1:${port}/v1`);

 const onboarding=await api('/api/local/'+created.id+'/onboarding');assert.equal(onboarding.ready,true);assert.equal(onboarding.suggestion.base_url,`http://127.0.0.1:${port}/v1`);assert.equal(onboarding.suggestion.upstream_model,'stub-model');

 const backend=await api('/api/backends',{name:'本地接入',logical_model:'local-llm',upstream_model:'stub-model',protocol:'chat',local_id:created.id,base_url:`http://127.0.0.1:${port}/v1`},201);
 await api('/api/backends/'+backend.id+'/probe',{});
 const route=await api('/api/routes',{name:'local-llm',target_kind:'backend',target_id:backend.id},201);
 const key=await api('/api/keys',{name:'local',models:['local-llm'],expires:new Date(Date.now()+3600000).toISOString()},201);
 const out=await api('/v1/chat/completions',{model:'local-llm',messages:[{role:'user',content:'你好'}]},200,{Authorization:'Bearer '+key.secret});
 assert.equal(out.choices[0].message.content,'你好');
 const usage=(await api('/api/usage'))[0];assert.equal(usage.status,'settled');assert.equal(usage.input_tokens,10);assert.equal(usage.target_id,backend.id);

 // 停止后不能创建引用它的接入服务
 await api('/api/local/'+created.id+'/stop',{});
 const stopped=await api('/api/local/'+created.id);assert.equal(stopped.status,'Stopped');assert.ok(stopped.log.lines.some(l=>/ready/.test(l)));assert.ok(stopped.finished_at);assert.equal(stopped.reason,'已手动停止');
 await api('/api/backends',{name:'接入被拒',logical_model:'x',upstream_model:'x',local_id:created.id,base_url:stopped.base_url},409);
 await api('/api/local/'+created.id+'/start',{});
 for(let i=0;i<40;i++){rec=await api('/api/local/'+created.id);if(rec.status==='Running')break;await new Promise(r=>setTimeout(r,250));}
 assert.equal(rec.status,'Running');

 // 被接入服务引用时禁止删除；解绑后可删
 const del=await fetch(base+'/api/local/'+created.id,{method:'DELETE',headers:{cookie:cookie(),['X-Project-Id']:user.project_id,'X-Ministation-Client':'console'}});assert.equal(del.status,409);
 store.update('backend',backend.id,user.project_id,{local_id:null});
 const ok=await fetch(base+'/api/local/'+created.id,{method:'DELETE',headers:{cookie:cookie(),['X-Project-Id']:user.project_id,'X-Ministation-Client':'console'}});assert.equal(ok.status,200);
});

test('本机部署校验与宿主检测',async t=>{
 const {api}=await harness(t);
 await api('/api/local',{name:'缺模型',engine:'llamacpp',model:'/no/such/model.gguf',port:18090},422);
 // 端口占用
 const blocker=new Server();await new Promise(r=>blocker.listen(0,'127.0.0.1',r));const busy=blocker.address().port;
 await api('/api/local',{name:'端口占用',engine:'custom',model:stub,port:busy,command:['node',stub],args:['--port',String(busy)]},422);
 await new Promise(r=>blocker.close(r));
 // 引擎二进制不存在 → 启动失败但记录保留（错误写回 reason）
 const port=await freePort();
 const rec=await api('/api/local',{name:'坏引擎',engine:'custom',model:stub,port,command:['node','/no/such/engine.mjs'],args:[]},201);
 let failed;for(let i=0;i<20;i++){failed=await api('/api/local/'+rec.id);if(failed.status==='Stopped'&&failed.reason)break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(failed.reason);
 const list=await api('/api/local');assert.ok(list.some(r=>r.name==='坏引擎'));
});

test('detectHost 与 localEnvironment 的 GPU 分支',async t=>{
 const s=new Store(mkdtempSync(join(resolve('artifacts/tests'),'host-')));
 const config={};const local=createLocalDeployments({store:s,config});
 t.after(()=>s.close());
 const noGpu=await detectHost({gpuProbe:async()=>null});assert.equal(noGpu.gpu,null);assert.ok(noGpu.cpu_cores>0);
 const env=await localEnvironment(local);assert.equal(env.state,'local');
 const noGpuEnv=await localEnvironment({detectHost:async()=>({cpu_cores:8,memory_gib:64,gpu:null,arch:'x64'})});assert.equal(noGpuEnv.recommendation.resources.gpus,0);
 const withGpu=await detectHost({gpuProbe:async()=>({available:true,count:2,model:'L20',memory_mib:49152})});assert.equal(withGpu.gpu.count,2);
 const withGpuLocal=await localEnvironment({detectHost:async()=>({cpu_cores:16,memory_gib:128,gpu:{available:true,count:1,model:'L20'},arch:'x64'})});assert.equal(withGpuLocal.recommendation.resources.gpus,1);
});

test('本机模型扫描与引擎探测',async t=>{
 const modelsRoot=join(resolve('artifacts/tests'),'scan-'+Date.now());
 mkdirSync(join(modelsRoot,'Qwen3-Test'),{recursive:true});
 writeFileSync(join(modelsRoot,'Qwen3-Test','config.json'),JSON.stringify({architectures:['Qwen3ForCausalLM'],model_type:'qwen3'}));
 writeFileSync(join(modelsRoot,'Qwen3-Test','model.safetensors.index.json'),'{}');
 writeFileSync(join(modelsRoot,'tiny.gguf'),'gguf');
 const {api}=await harness(t,{modelScanRoots:[modelsRoot]});
 const {models}=await api('/api/local/models');
 const configured=await api('/api/local/models?dir='+encodeURIComponent(modelsRoot));assert.equal(configured.models.length,2);
 const hf=models.find(m=>m.path===join(modelsRoot,'Qwen3-Test'));
 assert.ok(hf&&hf.kind==='hf'&&hf.arch==='Qwen3ForCausalLM',JSON.stringify(models));
 assert.ok(models.some(m=>m.path.endsWith('tiny.gguf')&&m.kind==='gguf'),JSON.stringify(models));
 const eg=await api('/api/local/engines');
 assert.equal(typeof eg.llamacpp.available,'boolean');assert.equal(typeof eg.vllm.available,'boolean');
 const rec=await api('/api/local/recommend?model='+encodeURIComponent(join(modelsRoot,'tiny.gguf'))+'&engine=llamacpp');
 assert.ok(rec.threads>0&&Array.isArray(rec.notes));
 // 不在允许根目录内时禁止任意读取
 await api('/api/local/models?dir='+encodeURIComponent('/etc'),undefined,403);
});

test('本机部署推荐参数 recommendParams',async t=>{
 const ll=recommendParams({model:'/m.gguf',engine:'llamacpp',gpus:0,host:{cpu_cores:128,memory_gib:377,gpu:null}});
 assert.ok(ll.threads>=32&&ll.threads<=64);assert.equal(ll.max_model_len,32768);
 const g=recommendParams({model:'/d',engine:'vllm',gpus:2,host:{cpu_cores:128,memory_gib:377,gpu:{available:true,count:2,memory_mib:49152}},scanModelSize:67});
 assert.equal(g.gpus,2);assert.ok(g.notes.some(n=>n.includes('TP')));
 const nog=recommendParams({model:'/d',engine:'vllm',gpus:0,host:{cpu_cores:32,memory_gib:128,gpu:null},scanModelSize:67});
 assert.equal(nog.gpus,0);assert.ok(nog.notes.some(n=>n.includes('--device cpu')));
 // 模型 config 声明最大上下文时，vLLM 建议值不得越过它；未声明时不限制
 const capped=recommendParams({model:'/d',engine:'vllm',gpus:2,host:{cpu_cores:128,memory_gib:377,gpu:{available:true,count:2,memory_mib:49152}},scanModelSize:67,maxCtx:4096});
 assert.equal(capped.max_model_len,4096);assert.ok(capped.notes.some(n=>n.includes('最大上下文为 4096')));
 const uncapped=recommendParams({model:'/d',engine:'vllm',gpus:2,host:{cpu_cores:128,memory_gib:377,gpu:{available:true,count:2,memory_mib:49152}},scanModelSize:67,maxCtx:null});
 assert.equal(uncapped.max_model_len,8192);
});

test('模型最大上下文：modelMaxCtx 解析与创建校验',async t=>{
 const {modelMaxCtx}=await import('../server/model-scan.mjs');
 const d=join(resolve('artifacts/tests'),'ctx-'+Date.now());mkdirSync(d,{recursive:true});
 writeFileSync(join(d,'config.json'),JSON.stringify({max_position_embeddings:2048}));
 writeFileSync(join(d,'model.safetensors.index.json'),'{}');
 const d2=join(resolve('artifacts/tests'),'ctx-nocap-'+Date.now());mkdirSync(d2,{recursive:true});
 writeFileSync(join(d2,'config.json'),JSON.stringify({architectures:['Qwen3_5MoeForConditionalGeneration']}));
 writeFileSync(join(d2,'model.safetensors.index.json'),'{}');
 assert.equal(modelMaxCtx(d),2048);
 assert.equal(modelMaxCtx(d2),null);
 assert.equal(scanModelRoot(resolve(d,'..')).models.find(m=>m.path===d).max_ctx,2048);
 // 超过模型声明上限 → 创建被拒（不实际拉起引擎）
 const port=await freePort();
 const {api}=await harness(t);
 const rejected=await api('/api/local',{name:'超上下文',engine:'vllm',model:d,port,max_model_len:8192},422);
 assert.equal(rejected.error.code,'MAX_CONTEXT_EXCEEDED');
 // 未声明上限的模型（如 Qwen3.5）不受该条校验约束：应继续走到端口占用校验，而不是上下文校验
 const blocker=new Server();await new Promise(r=>blocker.listen(0,'127.0.0.1',r));const busy=blocker.address().port;
 const busyRej=await api('/api/local',{name:'无上限模型',engine:'vllm',model:d2,port:busy,max_model_len:8192,gpus:0},422);
 assert.equal(busyRej.error.code,'PORT_IN_USE');
 await new Promise(r=>blocker.close(r));
});

test('接入本机部署：upstream_model 自动采用引擎别名（served_model）',async t=>{
 // 用一个真实存活进程充当“Running”的本机引擎 pid（local.get 会按 pid 存活判定状态）
 const {spawn}=await import('node:child_process');
 const child=spawn('node',['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 t.after(()=>{try{child.kill();}catch{}});
 const {store,api,user}=await harness(t);
 const lid='local-link-alias';
 store.put('local',user.project_id,'本地引擎',{spec:{engine:'llamacpp',model:'/x.gguf',served_model:'engine-alias'},status:'Running',pid:child.pid,reason:null},lid);
 // 用户手填逻辑名也会被纠正为引擎别名，否则上游会 404
 const b=await api('/api/backends',{name:'自动上游',logical_model:'llm-logical',upstream_model:'请忽略我',base_url:'http://127.0.0.1:18999/v1',local_id:lid,protocol:'chat'},201);
 assert.equal(b.upstream_model,'engine-alias');
 const upd=await api('/api/backends/'+b.id+'/update',{name:'自动上游',logical_model:'llm-logical',upstream_model:'换个错误名',base_url:'http://127.0.0.1:18999/v1',local_id:lid,protocol:'chat',version:b.version});
 assert.equal(upd.upstream_model,'engine-alias');
});

test('buildCommand：vLLM 解释器覆写与 GPU/CPU 参数',async t=>{
 const vp='/srv/ministation/.venv-vllm/bin/python -m vllm.entrypoints.openai.api_server';
 const cfg={localEngineBin:{vllm:vp,llamacpp:'llama-server'}};
 const cpu=buildCommand({engine:'vllm',model:'/m',port:9010,served_model:'s',gpus:0},cfg);
 assert.equal(cpu.command[0],'/srv/ministation/.venv-vllm/bin/python');
 assert.ok(cpu.args.includes('--device')&&cpu.args.includes('cpu'));
 assert.ok(!cpu.args.includes('--tensor-parallel-size'));
 const gpu=buildCommand({engine:'vllm',model:'/m',port:9010,served_model:'s',gpus:2,max_model_len:8192},cfg);
 assert.ok(gpu.args.includes('--tensor-parallel-size')&&gpu.args.includes('2'));
 assert.ok(!gpu.args.includes('--device'));
 assert.ok(gpu.args.includes('--max-model-len'));
 const ll=buildCommand({engine:'llamacpp',model:'/a.gguf',port:9011,served_model:'s',threads:32,max_model_len:4096},{localEngineBin:{llamacpp:'/x/llama-server'}});
 assert.equal(ll.command[0],'/x/llama-server');
 assert.ok(ll.args.includes('-t')&&ll.args.includes('32')&&ll.args.includes('--ctx-size')&&ll.args.includes('4096'));
 assert.ok(!ll.args.includes('-ngl'));
 const llgpu=buildCommand({engine:'llamacpp',model:'/a.gguf',port:9011,served_model:'s',gpus:1},{localEngineBin:{llamacpp:'/x/llama-server'}});
 assert.ok(llgpu.args.includes('-ngl')&&llgpu.args.includes('999'));
});

test('buildCommand：vLLM 自动识别项目 .venv-vllm（无需显式配置）',async t=>{
 // 本机部署无需 MINISTATION_LOCAL_VLLM_BIN：应自动采用 .venv-vllm，而不是回退系统 python3 导致 ModuleNotFoundError
 const {resolveVllmCommand,probeVllm}=await import('../server/vllm-bin.mjs');
 const r=resolveVllmCommand('');
 const venvPy=join(resolve('.venv-vllm'),'bin','python');
 assert.ok(r.command.length>=3);
 if(r.source==='venv'){
  assert.equal(r.command[0],venvPy);
  assert.equal(r.command[1],'-m');
  assert.equal(r.available,true);
  assert.ok(r.version,'venv 解析应返回 vLLM 版本号');
  const probe=probeVllm('');
  assert.equal(probe.available,true);
  assert.ok(probe.path.startsWith(venvPy));
 } else {
  // 无 venv 环境也要优雅回退（不抛错、命令可执行形状正确）
  assert.equal(r.command[0],'python3');
  assert.equal(typeof r.available,'boolean');
  assert.equal(typeof probeVllm('').available,'boolean');
 }
 // buildCommand 与解析保持一致（显式配置优先的用例见上一个测试）
 const cmd=buildCommand({engine:'vllm',model:'/m',port:9012,served_model:'s',gpus:0},{});
 assert.equal(cmd.command[0],r.command[0]);
});

test('引擎/模型类型不匹配校验',async t=>{
 const hfdir=join(resolve('artifacts/tests'),'fake-hf-'+Date.now());
 mkdirSync(hfdir,{recursive:true});
 writeFileSync(join(hfdir,'config.json'),'{}');
 writeFileSync(join(hfdir,'model.safetensors.index.json'),'{}');
 const gguf=join(resolve('artifacts/tests'),'fake-'+Date.now()+'.gguf');writeFileSync(gguf,'gguf');
 const {api}=await harness(t);
 // llama.cpp 引擎 + HF 目录 → 422；vLLM 引擎 + GGUF 文件 → 422
 await api('/api/local',{name:'a1',engine:'llamacpp',model:hfdir,port:18120},422);
 await api('/api/local',{name:'a2',engine:'vllm',model:gguf,port:18121},422);
});

test('模型扫描根目录默认回退（空数组不应吞掉默认）',async t=>{
 const root=join(resolve('artifacts/tests'),'dflt-'+Date.now());mkdirSync(root,{recursive:true});
 writeFileSync(join(root,'dummy.gguf'),'x');
 // 未配置或配置了空数组扫描根时，应回退到 modelRoot/内置默认，而不是扫不到
 assert.ok(scanModelRoot(root).models.some(m=>m.path.endsWith('dummy.gguf')));
 assert.ok(listModelRoots({modelScanRoots:[],modelRoot:root}).some(m=>m.path.endsWith('dummy.gguf')));
 assert.ok(typeof probeEngines({llamacpp:'path-not-exists',vllm:''}).llamacpp.available==='boolean');
});

test('本机日志：可执行文件缺失不会崩溃，诊断包保留启动错误',async t=>{
 const {api,base,cookie}=await harness(t);
 const rec=await api('/api/local',{name:'missing-binary',engine:'custom',model:stub,port:await freePort(),command:[join(resolve('artifacts/tests'),'does-not-exist-engine')]},201);
 let failed;
 for(let i=0;i<40;i++){failed=await api('/api/local/'+rec.id);if(failed.finished_at)break;await new Promise(r=>setTimeout(r,25));}
 assert.equal(failed.status,'Stopped');assert.match(failed.reason,/ENOENT/);
 assert.ok(failed.finished_at);assert.equal(failed.pid,null);
 assert.ok(failed.log.lines.some(line=>line.includes('ENOENT')));
 assert.ok(failed.findings.some(f=>f.code==='SPAWN_FAILED'));
 const response=await fetch(base+'/api/local/'+rec.id+'/diagnostics',{headers:{cookie:cookie()}});
 assert.equal(response.status,200);const zip=Buffer.from(await response.arrayBuffer());
 const files=new Map();let offset=0;
 while(zip.readUInt32LE(offset)===0x04034b50){
  const length=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26),extra=zip.readUInt16LE(offset+28);
  const name=zip.subarray(offset+30,offset+30+nameLength).toString();
  const start=offset+30+nameLength+extra;files.set(name.split('/').pop(),zip.subarray(start,start+length).toString());offset=start+length;
 }
 assert.equal(zip.readUInt32LE(offset),0x02014b50);
 assert.match(files.get('engine.log'),/ENOENT/);assert.match(files.get('current-run.log'),/ENOENT/);
 const analysis=JSON.parse(files.get('analysis.json'));assert.ok(analysis.findings.some(f=>f.code==='SPAWN_FAILED'));
 assert.equal(analysis.run_id,failed.run_id);assert.equal(analysis.log.available,true);
 writeFileSync(join(resolve('artifacts/tests'),'diagnostics-validation.zip'),zip);
});

test('本机日志：失败后重启不会用旧错误诊断新一轮成功退出',async t=>{
 const {api,store,user}=await harness(t);
 const rec=await api('/api/local',{name:'restart-log',engine:'custom',model:stub,port:await freePort(),command:[process.execPath],args:['-e',"console.error('CUDA out of memory');process.exitCode=1"]},201);
 let failed;for(let i=0;i<40;i++){failed=await api('/api/local/'+rec.id);if(failed.finished_at)break;await new Promise(r=>setTimeout(r,25));}
 assert.equal(failed.exit_code,1);assert.ok(failed.findings.some(f=>f.code==='GPU_OOM'));
 store.update('local',rec.id,user.project_id,{spec:{...failed.spec,args:['-e',"console.log('INFO CUDA initialized successfully')"]}});
 await api('/api/local/'+rec.id+'/start',{});
 let clean;for(let i=0;i<40;i++){clean=await api('/api/local/'+rec.id);if(clean.finished_at&&clean.run_id!==failed.run_id)break;await new Promise(r=>setTimeout(r,25));}
 assert.equal(clean.exit_code,0);assert.notEqual(clean.run_id,failed.run_id);
 assert.deepEqual(clean.findings,[]);assert.ok(clean.log.lines.some(l=>l.includes('initialized successfully')));
 assert.ok(clean.log.lines.every(l=>!l.includes('out of memory')));
 assert.ok(clean.log_offset>failed.log_offset);
});
