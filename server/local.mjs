import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {closeSync,existsSync,mkdirSync,openSync,readFileSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import os from 'node:os';
import {z} from 'zod';
import {fail,name as nameSchema,assertURL,publicObject} from './domain.mjs';
import {id,now} from './store.mjs';
import {listModelRoots,scanModelRoot,modelMaxCtx} from './model-scan.mjs';
import {resolveVllmCommand} from './vllm-bin.mjs';

// 本机（单机、无 Kubernetes）大模型部署：MiniStation 在控制面宿主机上直接启动并管理
// 一个 OpenAI 兼容推理引擎进程（llama.cpp / vLLM / 自定义命令），服务经统一网关接入发布。

export const GIB=2**30;
export const localSchema=z.object({
 name:nameSchema,
 engine:z.enum(['llamacpp','vllm','custom']).default('llamacpp'),
 model:z.string().min(1).max(2048),
 served_model:z.string().regex(/^[a-zA-Z0-9_.:/-]{1,150}$/).default('my-model'),
 protocol:z.enum(['chat','embedding','decision']).default('chat'),
 port:z.number().int().min(1024).max(65535).default(8080),
 threads:z.number().int().min(1).max(4096).optional(),
 gpus:z.number().int().min(0).max(16).default(0),
 max_model_len:z.number().int().min(256).max(1000000).optional(),
 command:z.array(z.string().min(1).max(2000)).max(30).optional(),
 args:z.array(z.string().max(2000)).max(100).optional(),
});

// ---- 宿主能力检测（CPU/内存/GPU，GPU 尽力而为）----
export async function detectGpu(){const r=spawnSync('nvidia-smi',['--query-gpu=name,memory.total','--format=csv,noheader'],{encoding:'utf8',timeout:8000,stdio:['ignore','pipe','ignore']});if(r.status!==0||!r.stdout)return null;const rows=r.stdout.trim().split(/\r?\n/).map(s=>s.trim()).filter(Boolean);if(!rows.length)return null;const first=rows[0].split(',');const memoryG=Number((first[1]||'').match(/\d+/)?.[0]||0);return {available:true,count:rows.length,model:(first[0]||'未知').trim(),memory_mib:memoryG};}

export async function detectHost({gpuProbe=detectGpu,meminfoFile='/proc/meminfo'}={}){
 let memoryTotal=os.totalmem();
 try{if(existsSync(meminfoFile)){const line=readFileSync(meminfoFile,'utf8').split('\n').find(l=>l.startsWith('MemTotal:'));if(line)memoryTotal=Number(line.match(/\d+/)?.[0]||0)*1024;}}
 catch{/* 回退到 os.totalmem */} 
 const cores=os.availableParallelism?.()||os.cpus().length;
 let gpu=null,diskFreeGib=null;
 try{gpu=await gpuProbe();}catch{/* 无驱动或无 GPU 时保持 null */}
 try{const st=os.statfs?.(process.cwd())||0;if(st?.bavail)diskFreeGib=Math.floor(st.bavail*st.bsize/GIB);}catch{}
 return {cpu_cores:cores,memory_gib:Math.floor(memoryTotal/GIB*10)/10,gpu,disk_free_gib:diskFreeGib,arch:os.arch(),hostname:os.hostname(),platform:os.platform()};
}

export async function localEnvironment(local){
 const host=await local.detectHost();
 const cores=Math.max(2,Math.min(256,host.cpu_cores||4));
 const gpus=host.gpu?.count||0;
 const recommended={cpu:Math.max(1,Math.floor(cores*0.5)),memory_gib:Math.max(4,Math.floor(host.memory_gib*0.25)),gpus:gpus>0?1:0,tensor_parallel:gpus>0?1:0,shared_memory_gib:0.5};
 return {state:'local',reason:`本机 ${host.cpu_cores} 核 / ${host.memory_gib} GiB${gpus?` / GPU ${gpus}×${host.gpu.model}`:''}。推荐直接在本机启动引擎；GPU 需先安装驱动，否则使用 CPU。`,recommendation:{resources:recommended,example_node:'本机',reasons:['使用本机宿主机的 CPU 与内存，不使用 Kubernetes。','GPU 数量与驱动可检测时按可用 GPU 推荐，否则默认为 CPU。']},nodes:[{name:'本机',ready:true,cordoned:false,blocked_by_taints:false,hardware:{architecture:host.arch,gpu_model:host.gpu?.model||null,gpu_memory_mib:host.gpu?.memory_mib||null,source:'本机宿主检测'},remaining:{cpu:host.cpu_cores,memory_gib:host.memory_gib,gpus}}],observed_at:new Date().toISOString(),host,limitations:['引擎二进制与模型需预先在本机就绪；本机部署不提供容器隔离。','仅监听本机回环地址，统一网关负责对外安全与授权。','本机部署属于单实例单进程，不具备 Kubernetes 的副本与自愈能力。'],pd:{recommended:false,reason:'本机部署暂不提供 PD 分离。'}};
}

// ---- 引擎命令构造 ----
function normalizeBin(bin){return typeof bin==='string'?bin.trim().split(/\s+/).filter(Boolean):['llama-server'];}

export function buildCommand(spec,config){
 if(spec.engine==='custom')return {command:spec.command||[],args:spec.args||[]};
 if(spec.engine==='llamacpp'){
  const args=['-m',spec.model,'--host','127.0.0.1','--port',String(spec.port),'--alias',spec.served_model];
  if(spec.threads)args.push('-t',String(spec.threads));
  if(spec.max_model_len)args.push('--ctx-size',String(spec.max_model_len));
  if(spec.gpus)args.push('-ngl','999'); // 全量层卸载到 GPU（llama.cpp 内部自动分配多卡）
  return {command:normalizeBin(config.localEngineBin?.llamacpp),args};
 }
 // vLLM 解释器：显式配置优先，否则自动识别项目 `.venv-vllm`，最后回退系统 python3
 const command=resolveVllmCommand(config.localEngineBin?.vllm).command;
 const args=['--model',spec.model,'--host','127.0.0.1','--port',String(spec.port),'--served-model-name',spec.served_model,'--trust-remote-code'];
 // ^--trust-remote-code：本机模型常带自定义代码（auto_map，如 DeepSeek-MoE），
 //   不传会报 "contains custom code ... Please pass trust_remote_code=True"；启用后 vLLM 内部仍优先用其原生实现解析已支持的架构。
 if(spec.gpus)args.push('--tensor-parallel-size',String(spec.gpus));else args.push('--device','cpu');
 if(spec.max_model_len)args.push('--max-model-len',String(spec.max_model_len));
 return {command,args};
}

function portAvailable(port){return new Promise(resolve=>{const srv=createServer();srv.once('error',()=>resolve(false));srv.listen(port,'127.0.0.1',()=>srv.close(()=>resolve(true)));});}
async function isHealthy(port,path='/health',timeout=1500){try{const r=await fetch(`http://127.0.0.1:${port}${path}`,{signal:AbortSignal.timeout(timeout)});return r.status===200;}catch{return false;}}
function alive(pid){if(!pid||pid<=0)return false;try{process.kill(pid,0);return true;}catch{return false;}}

export function createLocalDeployments({store,config}){
 const dir=join(store.dir,'local');
 mkdirSync(dir,{recursive:true});
 const children=new Map(); // pid -> child
 const intentional=new Set(); // id 当次显式停止的部署，避免误写退出原因
 const logPath=oid=>join(dir,oid+'.log');
 const pidPath=oid=>join(dir,oid+'.pid');
 function record(project,oid){const v=store.get('local',oid,project);if(!v)fail(404,'NOT_FOUND','本机部署不存在或没有访问权限');return v;}
 function live(rec){const running=alive(rec.pid);if(!running)return {status:'Stopped',pid:null,healthy:false,reason:rec.reason||'进程未运行'};return {status:rec.status,pid:rec.pid,healthy:null,reason:rec.reason||null};}
 async function detailed(rec){const base=live(rec);if(base.status==='Stopped')return {...base,log:logTail(rec.id,60)};const port=rec.spec?.port||rec.port;const healthy=await isHealthy(port,rec.health_path||'/health');let reason=base.reason;if(rec.status==='Starting'){if(healthy){store.update('local',rec.id,rec.project_id,{status:'Running',reason:null});reason=null;}else reason='引擎已启动，等待健康检查通过（首次加载模型可能需要较长时间）';}else if(!healthy){reason='进程存在但健康检查失败，请查看日志';}return {...base,healthy,reason,log:logTail(rec.id,60)};}
 function logTail(oid,n=60){try{const text=readFileSync(logPath(oid),'utf8');const lines=text.split(/\r?\n/).filter(Boolean);return {lines:lines.slice(-n),size:text.length};}catch{return {lines:[],size:0};}}
  // 从引擎日志尾部摘取“最可能”的真实错误行，把状态从“进程退出 代码 1”升级为可读原因
  function extractError(lines){const arr=lines||[];const noise=s=>/DeprecationWarning/.test(s)||/https?:\/\//.test(s)||/^\s*\(?(INFO|WARNING|DEBUG)\b/.test(s)||/^-\s|^(For|If this is|See)\b|^Traceback \(most recent call last\)$/.test(s);const strong=s=>/(oom\b|out of memory|not enough memory|insufficient|cannot allocate|no space left|address already in use|permission denied)/i.test(s);const weak=s=>/(error|traceback|exception|fatal|cuda|not found|value error|no module)/i.test(s);let hit='';for(let i=arr.length-1;i>=0&&i>arr.length-500;i--){const s=String(arr[i]).trim();if(!s||s.length>2000||noise(s))continue;if(strong(s))return s.slice(0,260);if(weak(s)&&s.length<300&&!hit)hit=s;}return hit.slice(0,260);}
 async function launch(rec){const spec=rec.spec;
  // 启动前校验：请求的 GPU 数不得超过本机当前可见的 GPU 数（避免“World size > GPUs”这类启动即退）
  if(spec.engine==='vllm'&&spec.gpus>0){let avail=0;try{const h=await detectHost();avail=h.gpu?.count||0;}catch{}if(avail>0&&spec.gpus>avail)throw new Error(`本机可用 GPU ${avail} 块，少于配置的 ${spec.gpus} 块（tensor_parallel_size）；已拒绝启动，请减少 GPU 数量或先确认其余 GPU 对控制面可见`);}const {command,args}=buildCommand(spec,config);const env={...process.env,...(spec.threads?{OMP_NUM_THREADS:String(spec.threads)}:{})};if(spec.engine==='llamacpp'&&existsSync(command[0])){env.LD_LIBRARY_PATH=[dirname(resolve(command[0])),env.LD_LIBRARY_PATH].filter(Boolean).join(':');}const fd=openSync(logPath(rec.id),'a');const child=spawn(command[0],[...command.slice(1),...args],{env,stdio:['ignore',fd,fd],detached:false});children.set(child.pid,child);writeFileSync(pidPath(rec.id),String(child.pid));store.update('local',rec.id,rec.project_id,{pid:child.pid,status:'Starting',reason:null,started_at:now(),command:[...command,...args]});child.on('exit',(code,signal)=>{try{children.delete(child.pid);const cur=store.get('local',rec.id,rec.project_id);if(cur&&cur.status!=='Stopped'&&!intentional.has(rec.id)){let tail=[];try{tail=readFileSync(logPath(rec.id),'utf8').split(/\r?\n/).filter(Boolean);}catch{}const err=extractError(tail);store.update('local',rec.id,rec.project_id,{status:'Stopped',reason:`进程退出 ${signal?`信号 ${signal}`:`代码 ${code}`}${err?`：${err}`:''}`});}intentional.delete(rec.id);}catch{}try{closeSync(fd);}catch{}});}
 return {
  detectHost,
  dir,
  list(project){return store.list('local',project).map(rec=>({...rec,status:live(rec).status,reason:live(rec).reason,pid:rec.pid}));},
  get(project,oid){const rec=record(project,oid);return {...rec,status:live(rec).status,reason:live(rec).reason};},
  async refresh(project,oid){const rec=record(project,oid);const d=await detailed(rec);return {...rec,...d};},
  async create(project,input){
   const v=localSchema.parse(input);
   if(v.engine!=='custom'&&!existsSync(v.model))fail(422,'MODEL_NOT_FOUND',`模型路径不存在：${v.model}`);
   if(v.engine==='llamacpp'){
    let gguf=false;try{gguf=statSync(v.model).isFile()&&v.model.toLowerCase().endsWith('.gguf');}catch{}
    if(!gguf)fail(422,'ENGINE_MODEL_MISMATCH','llama.cpp 引擎需要 .gguf 文件；看起来这是 HuggingFace 模型目录（config.json/safetensors），请改用 vLLM 引擎。');
   }
   if(v.engine==='vllm'){
    let hf=false;try{hf=statSync(v.model).isDirectory()&&existsSync(join(v.model,'config.json'))&&statSync(join(v.model,'config.json')).isFile();}catch{}
    if(!hf)fail(422,'ENGINE_MODEL_MISMATCH','vLLM 引擎需要 HuggingFace 模型目录（含 config.json）；如果这是 GGUF 文件，请改用 llama.cpp 引擎。');
    if(hf&&v.max_model_len){const max=modelMaxCtx(v.model);if(max&&v.max_model_len>max)fail(422,'MAX_CONTEXT_EXCEEDED',`模型 config.json 声明的最大上下文为 ${max}（max_position_embeddings / model_max_length）。请把“最大上下文”改为 ≤${max}，或留空使用 vLLM 推导的默认值。`);}
   }
   // GPU 数预校验：vLLM 请求的卡数不得超过本机当前可见 GPU（避免“World size 超过可用 GPU”启动即退）
   if(v.engine==='vllm'&&v.gpus>0){let avail=0;try{const h=await detectHost();avail=h.gpu?.count||0;}catch{}if(avail>0&&v.gpus>avail)fail(422,'GPU_COUNT_EXCEEDED',`本机当前仅检测到 ${avail} 块可用 GPU，无法按 ${v.gpus} 卡（tensor_parallel_size）启动。请减少 GPU 数量，或先确认其余 GPU 对控制面可见（如 CUDA_VISIBLE_DEVICES / 被其他进程独占）。`);}
   if(!(await portAvailable(v.port)))fail(422,'PORT_IN_USE',`端口 ${v.port} 已被占用`);
   const spec={...v};
   const rec=store.put('local',project,v.name,{spec,status:'Starting',pid:null,health_path:'/health',base_url:`http://127.0.0.1:${v.port}/v1`,created_at:now(),started_at:null,reason:null},id());
   void launch(rec).catch(e=>{if(store.get('local',rec.id,project))store.update('local',rec.id,project,{status:'Stopped',reason:e.message});});
   return {...rec,status:'Starting'};
  },
  async stop(project,oid){const rec=record(project,oid);intentional.add(rec.id);const pid=rec.pid;store.update('local',rec.id,project,{status:'Stopped',reason:'已手动停止'});if(pid&&alive(pid)){try{process.kill(pid,'SIGTERM');}catch{}await new Promise(r=>setTimeout(r,1500));if(alive(pid)){try{process.kill(pid,'SIGKILL');}catch{}}}try{unlinkSync(pidPath(rec.id));}catch{}return this.get(project,oid);},
  async start(project,oid){const rec=record(project,oid);if(alive(rec.pid)&&rec.status==='Running')return this.get(project,oid);intentional.delete(rec.id);try{await launch(rec);}catch(e){store.update('local',rec.id,project,{status:'Stopped',reason:e.message});}return this.get(project,oid);},
  async remove(project,oid){const rec=record(project,oid);if(store.list('backend',project).some(b=>b.local_id===rec.id))fail(409,'LOCAL_IN_USE','已有接入服务引用该本机部署，请先删除或改绑');await this.stop(project,oid);store.remove('local',oid,project);return {ok:true};},
  async stopAll(){for(const p of store.list('project','system'))for(const rec of store.list('local',p.id))if(alive(rec.pid)){try{process.kill(rec.pid,'SIGTERM');}catch{}}children.clear();},
  logTail,
  isHealthy,
 };
}

// 根据本机能力与所选模型，给出可落地的启动参数建议（线程 / 上下文 / GPU 数量 / TP / 上限）。
export function recommendParams({model,engine,gpus,host,scanModelSize=0,arch='',model_type='',maxCtx=null}){
 engine=engine==='vllm'?'vllm':'llamacpp';
 const cpu=host?.cpu_cores>0?host.cpu_cores:8,ram=(Number(host?.memory_gib)||64);
 const gpuCount=(host?.gpu&&host.gpu.available&&host.gpu.count>0)?host.gpu.count:0;
 const out={model,engine,gpus:engine==='llamacpp'?(gpus>0?gpus:0):undefined,notes:[]};
 if(engine==='llamacpp'){
  out.threads=Math.min(cpu,64);
  out.parallel=Math.max(1,Math.min(8,Math.floor(cpu/8)));
  out.max_model_len=ram>=200?32768:(ram>=64?16384:8192);
  out.notes.push(`建议 ${out.threads} 线程 × ${out.parallel} 并行，上下文 ${out.max_model_len}（按 ${ram} GiB 内存与 ${cpu} 核）`);
  if(gpuCount&&gpus>0&&scanModelSize<=gpuCount*(host.gpu.memory_mib/1024))out.notes.push(`检测到 ${gpuCount} 块可用 GPU，可把 GPU 数量设为 ${gpus} 并加 --n-gpu-layers`);
 }
 else{
  const memPerG=host?.gpu&&host.gpu.available&&host.gpu.memory_mib?(host.gpu.memory_mib/1024):0;
  const need=scanModelSize>0?Math.max(1,Math.ceil(scanModelSize*1.15/memPerG)):(gpuCount||1);
  out.gpus=gpuCount?Math.min(gpuCount,need):0;
  out.max_model_len=ram>=200?8192:4096;
  // 模型 config 显式声明过最大上下文时（max_position_embeddings / model_max_length），建议值不得越过它，
  // 否则 vLLM 会在启动时报 "max_model_len ... greater than the derived max_model_len"。
  if(maxCtx&&out.max_model_len>maxCtx){out.max_model_len=maxCtx;out.notes.push(`模型 config.json 声明的最大上下文为 ${maxCtx}，已按此上限建议`);}
  if(gpuCount)out.notes.push(out.gpus<gpuCount?`模型约 ${scanModelSize.toFixed(1)} GiB 超单卡显存，建议 TP=${out.gpus} 并行（或 --enforce-eager）`:`${gpuCount} 块 GPU 可 TP=${out.gpus} 并行`);
  else out.notes.push('未检测到可用 GPU，将使用 --device cpu（CPU 推理，速度较慢）');
  if(model_type==='deepseek_v4')out.notes.push('DeepSeek-V4 为 fp8 MoE，请装好驱动后再部署以获得实机速度');
 }
 return out;
}

// ---- 诊断包打包（ZIP store 模式，零外部依赖）----
const CRC32_TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0;}return t;})();
export function crc32(buf){let c=0xFFFFFFFF;for(let i=0;i<buf.length;i++)c=CRC32_TABLE[(c^buf[i])&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
function dosDateTime(d){return {time:((d.getHours()<<11)|(d.getMinutes()<<5)|(d.getSeconds()>>1))&0xFFFF,date:(((d.getFullYear()-1980)<<9)|((d.getMonth()+1)<<5)|d.getDate())&0xFFFF};}
export function zipStore(files){const parts=[];const central=[];let offset=0;for(const f of files){const data=Buffer.isBuffer(f.data)?f.data:Buffer.from(String(f.data));const crc=crc32(data)>>>0;const {time,date}=dosDateTime(f.mtime||new Date());const name=Buffer.from(f.name);const lh=Buffer.alloc(30);lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(20,4);lh.writeUInt16LE(0,6);lh.writeUInt16LE(0,8);lh.writeUInt16LE(0,10);lh.writeUInt16LE(time,12);lh.writeUInt16LE(date,14);lh.writeUInt32LE(crc,16);lh.writeUInt32LE(data.length,20);lh.writeUInt32LE(data.length,24);lh.writeUInt16LE(name.length,26);lh.writeUInt16LE(0,28);parts.push(lh,name,data);central.push({name,crc,size:data.length,offset});offset+=30+name.length+data.length;}
const cdStart=offset;const cd=[];for(const c of central){const name=Buffer.from(c.name);const ch=Buffer.alloc(46);ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);ch.writeUInt16LE(0,8);ch.writeUInt16LE(0,10);ch.writeUInt16LE(0,12);ch.writeUInt16LE(0,14);ch.writeUInt32LE(c.crc,16);ch.writeUInt32LE(c.size,20);ch.writeUInt32LE(c.size,24);ch.writeUInt16LE(name.length,28);ch.writeUInt16LE(0,30);ch.writeUInt16LE(0,32);ch.writeUInt16LE(0,34);ch.writeUInt16LE(0,36);ch.writeUInt32LE(0,38);ch.writeUInt32LE(c.offset,42);cd.push(ch,name);}
const cdSize=cd.reduce((n,x)=>n+x.length,0);const eocd=Buffer.alloc(22);eocd.writeUInt32LE(0x06054b50,0);eocd.writeUInt16LE(0,4);eocd.writeUInt16LE(0,6);eocd.writeUInt16LE(central.length,8);eocd.writeUInt16LE(central.length,10);eocd.writeUInt32LE(cdSize,12);eocd.writeUInt32LE(cdStart,16);eocd.writeUInt16LE(0,20);return Buffer.concat([...parts,...cd,eocd]);}

export function installLocal(app,{s,config,local,get,write,audit}){
 app.get('/api/local/host',async(_,res)=>res.json(await local.detectHost()));
 app.get('/api/local/recommend',async(req,res)=>{
  const host=await local.detectHost();
  const model=req.query.model?String(req.query.model):'';const engine=String(req.query.engine||'llamacpp');const gpus=Number(req.query.gpus||0);
  let sizeGB=0,arch='',model_type='',maxCtx=null;
  if(model){const wanted=resolve(model);const found=(listModelRoots(config).find(m=>m.path===wanted))||scanModelRoot(dirname(wanted)).models.find(m=>m.path===wanted)||null;sizeGB=found?.size_gib||0;arch=found?.arch||'';model_type=found?.model_type||'';maxCtx=found?.max_ctx||modelMaxCtx(wanted);}
  res.json(recommendParams({model,engine,gpus,host,scanModelSize:sizeGB,arch,model_type,maxCtx}));
 });
 app.get('/api/local',(req,res)=>res.json(local.list(req.project).map(r=>{const {pid,command,started_at,...rest}=r;return {...rest};})));
 app.post('/api/local',async(req,res)=>{write(req);const rec=await local.create(req.project,req.body);audit(req,'local.create',rec.id,{name:rec.name,engine:rec.spec.engine,port:rec.spec.port});res.status(201).json({...rec,command:undefined,pid:undefined});});
 app.get('/api/local/:id',async(req,res)=>res.json(await local.refresh(req.project,req.params.id)));
 app.post('/api/local/:id/restart',async(req,res)=>{write(req);await local.stop(req.project,req.params.id);await local.start(req.project,req.params.id);audit(req,'local.restart',req.params.id);res.json(await local.refresh(req.project,req.params.id));});
 app.post('/api/local/:id/stop',async(req,res)=>{write(req);audit(req,'local.stop',req.params.id);res.json(await local.stop(req.project,req.params.id));});
 app.post('/api/local/:id/start',async(req,res)=>{write(req);audit(req,'local.start',req.params.id);res.json(await local.start(req.project,req.params.id));});
 app.delete('/api/local/:id',async(req,res)=>{write(req);audit(req,'local.delete',req.params.id);res.json(await local.remove(req.project,req.params.id));});
 app.get('/api/local/:id/onboarding',(req,res)=>{
  const rec=local.get(req.project,req.params.id),p=s.get('project',req.project,'system');
  const spec=rec.spec;const upstream_model=spec.served_model;
  const base_url=`http://127.0.0.1:${spec.port}/v1`;let address_issue='';
  try{assertURL(base_url,config.upstreamHosts);}catch(e){address_issue=e.message;}
  res.json({source_id:rec.id,ready:rec.status==='Running',spec,suggestion:{name:rec.name,local_id:rec.id,base_url,logical_model:upstream_model,upstream_model,protocol:spec.protocol},existing:s.list('backend',req.project).filter(b=>b.local_id===rec.id).map(publicObject),routes:s.list('route',req.project).filter(r=>r.target_kind==='backend'&&s.list('backend',req.project).some(b=>b.id===r.target_id&&b.local_id===rec.id)),address_issue,allowed_hosts:config.upstreamHosts});
 });
  // 诊断包：完整引擎日志 + 部署记录 + 主机/GPU/内存/磁盘 + 模型路径探测，打包 zip 下载
  app.get('/api/local/:id/diagnostics',async(req,res)=>{
   const rec=local.get(req.project,req.params.id);
   const grab=(cmd,args)=>spawnSync(cmd,args,{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']}).stdout||'';
   const basename=`diagnose-${rec.id.slice(0,8)}`;
   const files=[];
   let engineLog='（无日志文件：该部署尚未产生引擎输出）';
   try{engineLog=readFileSync(join(local.dir,rec.id+'.log'),'utf8');if(engineLog.length>5*1024*1024)engineLog='… 日志截断（超过 5MB，仅保留尾部）…\n'+engineLog.slice(-5*1024*1024);}catch{}
   files.push({name:`${basename}/engine.log`,data:engineLog});
   files.push({name:`${basename}/deployment.json`,data:JSON.stringify(rec,null,2)});
   let host=null;try{host=await local.detectHost();}catch{}
   files.push({name:`${basename}/host-env.txt`,data:[
    'MiniStation 本机部署诊断包',
    `生成时间：${now()}`,
    `部署：${rec.name}（${rec.id}）`,
    `状态：${rec.status}${rec.reason?` · ${rec.reason}`:''}`,
    `引擎：${rec.spec?.engine} · 端口：${rec.spec?.port} · GPU 数：${rec.spec?.gpus}`,
    `模型：${rec.spec?.model}`,
    '---- 启动命令 ----',
    JSON.stringify(rec.command||[...(rec.spec?.command||[]),...(rec.spec?.args||[])],null,2),
    '---- 主机能力（detectHost）----',
    JSON.stringify(host,null,2),
    '---- nvidia-smi ----',grab('nvidia-smi',[]).trim(),
    '---- free -m ----',grab('free',['-m']).trim(),
    '---- df -h ----',grab('df',['-h']).trim(),
   ].join('\n')});
   const m=rec.spec?.model||'';const mi={path:m,exists:existsSync(m)};if(mi.exists){try{const st=statSync(m);mi.is_directory=st.isDirectory();if(st.isDirectory())mi.has_config_json=existsSync(join(m,'config.json'));else mi.size_gib=+(st.size/2**30).toFixed(2);}catch{}}
   files.push({name:`${basename}/model-info.json`,data:JSON.stringify(mi,null,2)});
   const zip=zipStore(files);
   const ascii=String(rec.name).replace(/[^\x20-\x7e]/g,'_').slice(0,60);
   res.setHeader('Content-Type','application/zip');
   res.setHeader('Content-Disposition',`attachment; filename="ministation-diagnose-${ascii||'deploy'}-${rec.id.slice(0,8)}.zip"; filename*=UTF-8''${encodeURIComponent(`ministation-diagnose-${rec.name}.zip`)}`);
   res.end(zip);
  });
}
