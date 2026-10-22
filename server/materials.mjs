import {existsSync,mkdirSync,statSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {fail,publicObject} from './domain.mjs';
import {now} from './store.mjs';
import {scanModelRoot} from './model-scan.mjs';
import {detectHost} from './local.mjs';

// 模型资产：本机多目录模型扫描 + 描述批注 + ModelScope（魔搭）模型清单、
// 服务器资源适配筛选与直连下载（下载目录可配置，缺省为启动目录下的 Models/）。

const GIB=2**30;
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const MS_BASE='https://modelscope.cn/api/v1/models/';
const MS_ID=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/;
export const DEFAULT_DL_DIR=join(ROOT,'Models');
export const MATERIALS_ROUTES=1;
const MS_VENV=join(ROOT,'.venv-ms');
const MS_BIN=join(MS_VENV,'bin','modelscope');

// 预置的常用开源模型清单（ModelScope 模型 ID）。支持用户在页面输入任意 namespace/name 追加。
export const MS_CATALOG=[
 'Qwen/Qwen2.5-0.5B-Instruct','Qwen/Qwen2.5-1.5B-Instruct','Qwen/Qwen2.5-3B-Instruct','Qwen/Qwen2.5-7B-Instruct','Qwen/Qwen2.5-14B-Instruct','Qwen/Qwen2.5-32B-Instruct','Qwen/Qwen2.5-72B-Instruct',
 'Qwen/Qwen3-1.7B','Qwen/Qwen3-4B','Qwen/Qwen3-8B','Qwen/Qwen3-14B','Qwen/Qwen3-30B-A3B','Qwen/Qwen3-32B','Qwen/Qwen3-235B-A22B',
 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B','deepseek-ai/DeepSeek-R1-Distill-Qwen-14B','deepseek-ai/DeepSeek-R1-Distill-Qwen-32B','deepseek-ai/DeepSeek-V3','deepseek-ai/DeepSeek-R1',
 'ZhipuAI/GLM-4-9B-0414','ZhipuAI/glm-4-9b-chat',
 'LLM-Research/Meta-Llama-3.1-8B-Instruct','LLM-Research/Meta-Llama-3.1-70B-Instruct','AI-ModelScope/Mistral-7B-Instruct-v0.2','baichuan-inc/Baichuan2-7B-Chat'
];

// ---- 资源适配评估（本机扫描与 ModelScope 共用）----
export function fitModel(weightsGib,host){
 const gpu=host?.gpu;
 if(!weightsGib||weightsGib<=0)return {supported:null,reason:'未获取到权重尺寸，无法评估'};
 const gpuTotal=gpu?.available&&gpu.count>0?gpu.count*( (gpu.memory_mib||0)/1024):0;
 if(gpuTotal>0){
  const cap=gpuTotal*0.72; // 预留 KV cache / 激活 / CUDA 上下文开销
  if(weightsGib<=cap)return {supported:true,reason:`权重 ${weightsGib.toFixed(1)} GiB ≤ ${gpuTotal.toFixed(0)} GiB 可用（TP=${gpu.count}）`};
  return {supported:false,reason:`权重 ${weightsGib.toFixed(1)} GiB 超出 ${gpuTotal.toFixed(0)} GiB 显存，本机无法运行`};
 }
 const cpuCap=(host?.memory_gib||0)*0.5;
 if(weightsGib<=cpuCap)return {supported:true,reason:'无可用 GPU，按 CPU 推理（速度较慢）'};
 return {supported:false,reason:`权重 ${weightsGib.toFixed(1)} GiB 超出内存 ${cpuCap.toFixed(0)} GiB，无法本机运行`};
}

// ---- ModelScope 详情归一化 + 清单适配 ----
export function normalizeMsDetail(d){
 const id=`${d.Path}/${d.Name}`;
 const safetensor=d.ModelInfos?.safetensor||{};
 const weightsGib=Number(safetensor.model_size||0)/GIB;
 return {id,url:`https://modelscope.cn/models/${id}`,name:d.Name,chinese:d.ChineseName||'',description:d.Description||'',
  architecture:(d.Architectures||[])[0]||'',model_type:(d.ModelType||[])[0]||'',tasks:(d.Tasks||[]).map(t=>t.Name),
  tags:d.Tags||[],license:d.License||'',stars:d.Stars||0,downloads:d.Downloads||0,
  weights_gib:weightsGib,repo_gib:(Number(d.StorageSize||0)/GIB)||null,files:(safetensor.files||[]).length,
  vllm_friendly:!!(d.BackendSupport?.backend_info?.vllm)};
}

const cache=new Map();
async function msFetch(id,timeoutMs=9000){
 if(cache.get(id)?.t>Date.now()-600000)return cache.get(id).v;
 const c=await Promise.race([
  fetch(MS_BASE+id,{headers:{'User-Agent':'MiniStation/0.1','Accept':'application/json'}}).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}),
  new Promise((_,rej)=>setTimeout(()=>rej(new Error('请求超时')),timeoutMs))]);
 cache.set(id,{t:Date.now(),v:c});
 return c;
}
async function msDetail(id){
 if(!MS_ID.test(id))fail(422,'INVALID_MODEL_ID','模型 ID 应为 “命名空间/模型名”，如 Qwen/Qwen2.5-7B-Instruct');
 const j=await msFetch(id);if(!j?.Data)throw new Error('模型不存在或无法读取');
 return normalizeMsDetail(j.Data);
}

function defaultDir(s,project){const rec=(Array.isArray(s.list('setting',project))?s.list('setting',project):[]).find(x=>x.name==='modelscope-dl');return rec?.dir&&rec.dir.startsWith('/')?rec.dir:DEFAULT_DL_DIR;}

// ---- 安装路由 ----
export function installMaterials(app,{s,get,write,audit}){
 // 本机扫描根目录管理
 app.get('/api/materials/roots',(req,res)=>{
  const env=Array.from(new Set((process.env.MINISTATION_MODEL_SCAN_ROOTS||'').split(',').map(x=>x.trim()).filter(Boolean)));
  const manual=s.list('modelroot',req.project)||[];
  const seen=new Set();
  const roots=[...env.map(p=>({p,source:'env'})),...manual.map(r=>({p:r.path,id:r.id,source:'manual'}))].filter(x=>seen.has(x.p)?false:(seen.add(x.p),true));
  res.json(roots.map(r=>{let exists=false,is_dir=false;try{const st=statSync(r.p);exists=true;is_dir=st.isDirectory();}catch{}return {id:r.id||null,path:r.p,source:r.source,exists,is_dir};}));
 });
 app.post('/api/materials/roots',(req,res)=>{write(req);const {path}=z.object({path:z.string().min(1).max(2000)}).parse(req.body);if(!path.startsWith('/'))fail(422,'PATH_ABSOLUTE','目录必须是绝对路径');let st;try{st=statSync(path);}catch{fail(422,'PATH_NOT_FOUND','目录不存在或无法访问');}if(!st.isDirectory())fail(422,'NOT_DIRECTORY','请填写模型目录（其下可含一至多个模型的子目录，或直接就是模型目录）');const v=s.put('modelroot',req.project,path,{path});audit(req,'modelroot.add',path);res.status(201).json(publicObject(v));});
 app.delete('/api/materials/roots/:id',(req,res)=>{write(req);const r=get('modelroot',req);s.remove('modelroot',r.id,req.project);audit(req,'modelroot.remove',r.path);res.json({ok:true});});
 // 扫描 + 描述批注
 const effectiveRoots=(req)=>[...new Set([...(Array.isArray(s.list('modelroot',req.project))?s.list('modelroot',req.project).map(r=>r.path):[]),...(process.env.MINISTATION_MODEL_SCAN_ROOTS||'').split(',').map(x=>x.trim()).filter(Boolean)])];
 app.get('/api/materials/models',async(req,res)=>{
  const host=await detectHost().catch(()=>({}));
  const notes=(s.list('modelnote',req.project)||[]).reduce((a,n)=>(a[n.path]=n.description,a),{});
  const roots=effectiveRoots(req);const out=[];const seen=new Set();
  for(const r of roots){let scanned;try{scanned=scanModelRoot(r).models;}catch{continue;}for(const m of scanned){if(seen.has(m.path))continue;seen.add(m.path);const fit=fitModel(m.size_gib,host);out.push({...m,description:notes[m.path]||autoDescription(m),fit,root:r});}}
  res.json({host:safeHost(host),models:out.sort((a,b)=>b.size_gib-a.size_gib)});
 });
 app.put('/api/materials/model-note',(req,res)=>{write(req);const {path,description}=z.object({path:z.string().min(1).max(2000),description:z.string().max(2000)}).parse(req.body);if(existsSync(path)){let rec;try{rec=s.put('modelnote',req.project,path,{path,description,updated_at:now()});}catch{const ex=(s.list('modelnote',req.project)||[]).find(n=>n.path===path);rec=s.update('modelnote',ex.id,req.project,{path,description,updated_at:now()});}audit(req,'modelnote.set',path);res.json({ok:true,description});}else fail(404,'PATH_NOT_FOUND','模型路径不存在');});
 app.post('/api/materials/import',(req,res)=>{write(req);const {path,description}=z.object({path:z.string().min(1).max(2000),description:z.string().max(2000).optional()}).parse(req.body);if(!existsSync(path))fail(404,'PATH_NOT_FOUND','模型路径不存在');const base=path.endsWith('.gguf')?path.split('/').pop().replace(/\.gguf$/i,''):path.split('/').filter(Boolean).pop();let name=base||'模型',i=1;while(s.get('model',name,req.project))name=`${base||'模型'}-${i++}`;const v=s.put('model',req.project,name,{model_name:path,model_version:'local',task:'chat',source:'external',description:description||autoDescription({name:name,path}),created_at:now()});audit(req,'model.import',v.id);res.status(201).json(publicObject(v));});
 // ModelScope 清单 / 下载
 app.get('/api/materials/modelscope/catalog',async(req,res)=>{
  const host=await detectHost().catch(()=>({}));const extra=req.query.model?String(req.query.model).trim():'';
  const ids=[...MS_CATALOG,...(extra?[extra]:[])];const models=[];const failed=[];
  const queue=[...ids];const workers=Array.from({length:Math.min(4,queue.length)||1},async()=>{while(queue.length){const id=queue.shift();try{const m=await msDetail(id);models.push({...m,fit:fitModel(m.weights_gib,host)});}catch(e){failed.push({id,error:e.message});}}});
  await Promise.all(workers);
  res.json({host:safeHost(host),models,failed});
 });
 app.get('/api/materials/modelscope/inspect',async(req,res)=>{const id=String(req.query.model||'');const m=await msDetail(id);const host=await detectHost().catch(()=>({}));res.json({...m,fit:fitModel(m.weights_gib,host)});});
 app.get('/api/materials/modelscope/settings',(req,res)=>res.json({dir:defaultDir(s,req.project)}));
 app.post('/api/materials/modelscope/settings',(req,res)=>{write(req);const {dir}=z.object({dir:z.string().min(1).max(2000)}).parse(req.body);if(!dir.startsWith('/'))fail(422,'PATH_ABSOLUTE','下载目录必须是绝对路径');try{mkdirSync(dir,{recursive:true});}catch{fail(422,'PATH_UNWRITABLE','无法创建下载目录');}let rec;try{rec=s.put('setting',req.project,'modelscope-dl',{dir,updated_at:now()});}catch{const ex=(s.list('setting',req.project)||[]).find(x=>x.name==='modelscope-dl');rec=s.update('setting',ex.id,req.project,{dir,updated_at:now()});}audit(req,'modelscope.settings',dir);res.json({dir});});
 app.post('/api/materials/modelscope/download',(req,res)=>{
  write(req);let running=false,child=null;
  const {model}=z.object({model:z.string().min(1).max(200).regex(MS_ID,'模型 ID 格式应为 “命名空间/模型名”')}).parse(req.body);
  const dir=defaultDir(s,req.project);
  if(running)fail(409,'MS_BUSY','已有下载任务进行中，请等待完成');running=true;
  audit(req,'modelscope.download',model,{dir});
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders?.();
  const send=(event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);let closed=false;
  const onClose=()=>{closed=true;child?.kill('SIGKILL');};res.on('close',onClose);
  (async()=>{
   try{
    if(!existsSync(MS_BIN)){
     send('stage',{stage:'msenv',status:'start',label:'安装 ModelScope 下载工具',phase:'install'});
     const vpy=existsSync(join(ROOT,'.venv-vllm','bin','python'))?join(ROOT,'.venv-vllm','bin','python'):'python3';
     await runSpawn(vpy,['-m','venv',MS_VENV],t=>send('line',{stage:'msenv',text:t}));
     await runSpawn(join(MS_VENV,'bin','pip'),['-q','install','--disable-pip-version-check','-i','https://mirrors.aliyun.com/pypi/simple/','modelscope'],t=>send('line',{stage:'msenv',text:t}));
    }
    send('stage',{stage:'download',status:'start',label:`下载 ${model}`,phase:'deploy'});
    mkdirSync(dir,{recursive:true});
    child=spawn(MS_BIN,['download','--model',model,'--local_dir',dir],{env:{...process.env,CUDA_VISIBLE_DEVICES:''}});
    child.stdout?.on('data',b=>!closed&&send('line',{stage:'download',text:b.toString()}));
    child.stderr?.on('data',b=>!closed&&send('line',{stage:'download',text:b.toString()}));
    await new Promise((r,j)=>{child.on('error',j);child.on('close',code=>code===0?r():j(new Error('下载进程退出码 '+code)));});
    send('stage',{stage:'download',status:'ok',label:`完成：已保存到 ${dir}/${model.split('/').pop()}`});
    send('done',{ok:true,dir});
   }catch(e){send('error',{message:e.message||'下载失败'});}
   finally{running=false;if(!closed)res.end();}
  })();
 });
}

function autoDescription(m){const bits=[];if(m.arch)bits.push(m.arch);if(m.model_type)bits.push(m.model_type);if(m.kind==='hf')bits.push('HF 目录');if(m.kind==='gguf')bits.push('GGUF 文件');const size=typeof m.size_gib==='number'?`${m.size_gib.toFixed(1)} GiB`:'';return [bits.filter(Boolean).join(' · '),size].filter(Boolean).join(' — ')||'本机扫描到的模型';}

function safeHost(h){return {gpu:h.gpu?{available:!!h.gpu.available,count:h.gpu.count||0,model:h.gpu.model||'',memory_mib:h.gpu.memory_mib||0}:null,cpu_cores:h.cpu_cores||0,memory_gib:h.memory_gib||0,disk_free_gib:h.disk_free_gib||null};}

function runSpawn(cmd,args,emit){
 return new Promise((resolve,reject)=>{
  const c=spawn(cmd,args,{stdio:['ignore','pipe','pipe']});emit(`$ ${[cmd,...args].join(' ')}`);
  const push=b=>{const s=(b||'').toString();if(s)for(const l of s.split('\n'))if(l.length)emit(l);};
  c.stdout.on('data',push);c.stderr.on('data',push);c.on('error',reject);
  c.on('close',code=>code===0?resolve():reject(new Error(`命令退出码 ${code}`)));
 });
}
