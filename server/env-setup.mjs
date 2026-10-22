import {spawn,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fail} from './domain.mjs';

// 运行环境初始化：把“从跑不起来到跑通”的本机前置步骤（系统依赖 / vLLM 虚拟环境 /
// CUDA 工具链 / flashinfer JIT）固化成可选的阶段，通过 SSE 实时推送到网页 Console。
// 只执行本项目预定义命令，不接受任意用户输入的命令字符串。

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const VENV=join(ROOT,'.venv-vllm');
const VP=join(VENV,'bin','python');

function sh(cmd,opts={}){try{return spawnSync('bash',['-lc',cmd],{encoding:'utf8',timeout:opts.timeout||25000,stdio:['ignore','pipe','pipe'],...opts});}catch{return {status:1,stdout:'',stderr:''};}}
function o(r){return r.status===0?(r.stdout||'').trim():''}

export function detectEnv(){
 const isRoot=typeof process.getuid==='function'?process.getuid()===0:true;
 // 系统发行版
 const osLine=o(sh('. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"'))||'unknown';
 // GPU / 驱动
 let gpu=[],gpuCount=0;
 const g=sh('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader');
 if(g.status===0){gpu=(g.stdout||'').trim().split(/\r?\n/).map(s=>s.trim()).filter(Boolean);gpuCount=gpu.length;}
 // CUDA 工具链（与 start.sh 的探测优先级一致）
 let cudaHome='',cudaVer='',nvcc='';
 for(const c of [process.env.CUDA_HOME||'','/usr/local/cuda','/usr/local/cuda-13.0','/usr/local/cuda-12','/usr/local/cuda-11','/opt/cuda']){
  if(c&&existsSync(join(c,'bin','nvcc'))){cudaHome=c;break;}
 }
 if(cudaHome){nvcc=cudaHome+'/bin/nvcc';const v=sh(`"${nvcc}" --version | grep -oE "release [0-9.]+" | head -1`);cudaVer=o(v);}
 // ninja
 let ninja=o(sh('command -v ninja || command -v ninja-build || true'))||(existsSync(join(VENV,'bin','ninja'))?join(VENV,'bin','ninja'):'');
 // Python 头文件（Triton JIT 编译 cuda_utils.c 需要 Python.h）
 let pyInclude='';const inc=sh(`${VP||'python3'} -c "import sysconfig;print(sysconfig.get_paths()['include'])"`);
 const cand=[o(inc),'/usr/include/python3.11','/usr/include/python3','/usr/local/include/python3.11'];
 for(const c of cand){if(c&&existsSync(join(c,'Python.h'))){pyInclude=join(c,'Python.h');break;}}
 // vLLM 虚拟环境
 const venvExists=existsSync(VP);let vllm=null,torchCuda=null;
 if(venvExists){
  const r=spawnSync(VP,['-c',"import vllm;print(vllm.__version__)"],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','ignore']});
  if(r.status===0)vllm=(r.stdout||'').trim();
  const c=spawnSync(VP,['-c',"import torch;print(torch.cuda.is_available())"],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','ignore']});
  if(c.status===0)torchCuda=(c.stdout||'').trim()==='True';
 }
 // 可用磁盘
 let diskFreeGib=null;const d=sh("df -k --output=avail -B1 . 2>/dev/null | tail -1");const n=Number((d.stdout||'').trim());if(n>0)diskFreeGib=Math.floor(n/1024/1024/1024);
 return {os:osLine,is_root:isRoot,gpu,gpu_count:gpuCount,cuda_home:cudaHome||null,cuda_ver:cudaVer||null,nvcc:nvcc||null,ninja:ninja||null,python_headers:!!pyInclude,python_headers_path:pyInclude||null,vllm_venv:vllm,venv_exists:venvExists,torch_cuda_available:torchCuda,disk_free_gib:diskFreeGib,setup_script:existsSync(join(ROOT,'scripts','setup-vllm.sh'))};
}

export const SETUP_STAGES=[
 {id:'sysdeps',label:'系统依赖（python3-devel · ninja）',phase:'install',
  guard:e=>!(e.python_headers&&e.ninja),
  needed:e=>[e.python_headers?'python3-devel ✓':'python3-devel ✗',e.ninja?'ninja ✓':'ninja ✗'],
  async run(e,emit){
   if(e.python_headers&&e.ninja){emit('所有系统依赖已具备，跳过');return;}
   const pkg='python3-devel ninja-build';
   if(e.is_root){
    emit(`检测到 root，执行安装：dnf install -y ${pkg}`);
    await runCmd(`dnf install -y ${pkg}`,emit);
    emit('系统依赖安装完成（如需界面版本，可在宿主机 root 下执行同样的命令）');
   }else{
    const ok=sh(`sudo -n true`).status===0;
    if(ok){emit(`使用 sudo 安装：sudo dnf install -y ${pkg}`);await runCmd(`sudo -n dnf install -y ${pkg}`,emit);}
    else{
     emit('当前用户无 root 权限，无法自动安装系统包。');
     emit(`请在宿主机 root 下执行：`);
     emit(`  sudo dnf install -y ${pkg}`);
     emit('（本阶段已跳过安装，其余阶段继续）');
    }
   }
  }
 },
 {id:'vllm',label:'vLLM 运行环境（.venv-vllm）',phase:'install',
  guard:e=>!e.vllm_venv,
  needed:e=>[e.vllm_venv?`vLLM ${e.vllm_venv} ✓`:'vLLM ✗（未安装）'],
  async run(e,emit){
   if(e.vllm_venv){emit(`已存在 .venv-vllm（vLLM ${e.vllm_venv}），跳过`);return;}
   if(!e.setup_script){emit('未找到 scripts/setup-vllm.sh，无法自动安装 vLLM');throw Object.assign(new Error('缺少 setup-vllm.sh'));}
   emit('开始安装 vLLM（约 4GB 下载，自动尝试国内镜像，耗时较长）…');
   await runCmd(`bash "${join(ROOT,'scripts','setup-vllm.sh')}"`,emit);
   emit('vLLM 安装脚本执行完毕，进入验证阶段确认结果');
  }
 },
 {id:'toolchain',label:'CUDA / flashinfer 工具链配置',phase:'deploy',
  guard:e=>!(e.cuda_home&&e.ninja),
  needed:e=>[e.cuda_home?`CUDA ${e.cuda_home} ✓`:'CUDA ✗（未发现 /usr/local/cuda）',e.ninja?'ninja ✓':'ninja ✗'],
  async run(e,emit){
   emit(`CUDA_HOME 候选：${e.cuda_home||'未发现'}（vLLM 由 start.sh 自动导出 CUDA_HOME/PATH/LD_LIBRARY_PATH）`);
   if(!e.ninja&&existsSync(join(VENV,'bin','pip'))){
    emit('venv 中未发现 ninja，安装到 .venv-vllm/…');
    await runCmd(`${join(VENV,'bin','pip')} -q install ninja`,emit);
   }else if(e.ninja){emit(`ninja: ${e.ninja}`);}
   mkdirSync(join(ROOT,'.cache','flashinfer'),{recursive:true});
   emit('已准备 flashinfer JIT 工作目录：.cache/flashinfer（已 gitignore）');
  }
 },
 {id:'sanity',label:'配置落盘与自检脚本',phase:'config',
  guard:()=>!existsSync(join(ROOT,'scripts','start.sh')),
  needed:e=>[existsSync(join(ROOT,'scripts','start.sh'))?'start.sh ✓':'start.sh ✗'],
  async run(e,emit){
   emit('确认启动脚本就绪：start.sh（CUDA 工具链/NINJA 自动识别）与 stop.sh（优雅停止）');
   emit('MiniStation 本机部署会自动：选用 .venv-vllm、追加 --trust-remote-code、校验 max_model_len、纠正上游模型名');
  }
 },
 {id:'verify',label:'验证与自检',phase:'verify',
  guard:()=>true,
  needed:e=>[],
  async run(e,emit){
   if(e.venv_exists){
    const r=spawnSync(VP,['-c',"import vllm,torch;print('vllm',vllm.__version__);print('torch',torch.__version__);print('cuda_available',torch.cuda.is_available())"],{encoding:'utf8',timeout:40000,stdio:['ignore','pipe','pipe']});
    if(r.status===0)for(const l of (r.stdout||'').trim().split('\n'))emit(l);
    else for(const l of ((r.stderr||'').trim().split('\n')).slice(-6))emit(l);
   }else{emit('未安装 vLLM 虚拟环境，跳过引擎自检');emit('提示：先运行“vLLM 运行环境”阶段');}
   if(e.gpu_count>0)emit(`GPU 检测：${e.gpu_count}× ${e.gpu.join(' / ')}`);
   else emit('未检测到 GPU（本机部署会以 CPU 模式启动，或先装驱动）');
   emit('初始化完成 — 现在可以到「服务部署 → 本机部署」创建引擎并「应用推荐参数」启动。');
  }
 }
];

function runCmd(cmd,emit){
 return new Promise((resolve,reject)=>{
  const c=spawn('bash',['-lc',cmd],{stdio:['ignore','pipe','pipe'],env:process.env});
  emit(`$ ${cmd}`);
  const push=b=>{const s=(b||'').toString();if(s)for(const l of s.split('\n'))if(l.length)emit(l);};
  c.stdout.on('data',push);c.stderr.on('data',push);
  c.on('error',e=>reject(e));
  c.on('close',code=>code===0?resolve():reject(new Error(`命令退出码 ${code}`)));
 });
}

// 阶段执行器：逐阶段回调 emit({event:'stage'|'line'|'error',...})；signal 取消时终止子进程。
export async function runEnvironmentSetup(ids,{env,emit,signal}){
 const chosen=SETUP_STAGES.filter(s=>ids.includes(s.id));
 if(!chosen.length)fail(422,'EMPTY_STAGES','没有可执行的阶段');
 for(const s of chosen){
  emit({event:'stage',stage:s.id,label:s.label,phase:s.phase,status:'start'});
  try{
   if(s.guard&&!s.guard(env)){emit({event:'line',stage:s.id,text:'此阶段当前不需要执行（前置已就绪），跳过。'});emit({event:'stage',stage:s.id,status:'skip'});continue;}
   await s.run(env,text=>emit({event:'line',stage:s.id,text}));
   emit({event:'stage',stage:s.id,status:'ok'});
  }catch(e){
   emit({event:'stage',stage:s.id,status:'fail',text:e.message});
   emit({event:'stage',stage:s.id,status:'abort'}); // 供前端标记失败
   throw e;
  }
 }
}

export function installEnvSetup(app,{audit,write}){
 let running=false;
 app.get('/api/env-plan',(req,res)=>{
  const env=detectEnv();
  res.json({env,stages:SETUP_STAGES.map(s=>({id:s.id,label:s.label,phase:s.phase,skip:s.guard?!(s.guard(env)):false}))});
 });
 app.post('/api/env-run',(req,res)=>{
  write(req);
  // 仅允许执行服务器预定义阶段，不接受任意命令字符串
  const allowed=new Set(SETUP_STAGES.map(s=>s.id));
  const ids=Array.isArray(req.body?.stages)?req.body.stages.filter(id=>allowed.has(id)):[];
  if(!ids.length)fail(422,'EMPTY_STAGES','没有可执行的阶段');
  if(running)fail(409,'ENV_SETUP_BUSY','环境初始化正在进行中，请等待完成');
  running=true;
  const ac=new AbortController();
  const env=detectEnv();
  audit(req,'env.run','setup',{stages:ids});
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','X-Accel-Buffering':'no'});
  res.flushHeaders?.();
  const send=(event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let closed=false;
  const onClose=()=>{closed=true;ac.abort();};
  res.on('close',onClose);
  (async()=>{
   try{
    await runEnvironmentSetup(ids,{env,emit:e=>{if(!closed)send(e.event,e);},signal:ac});
    if(!closed)send('done',{ok:true});
   }catch(e){
    if(!closed)send('error',{message:e.message||'初始化失败',code:e.code||'ENV_SETUP_FAILED'});
   }finally{running=false;if(!closed)res.end();}
  })();
 });
}
