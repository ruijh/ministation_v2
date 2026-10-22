import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// vLLM 引擎解释器解析（本机部署专用）
// ---------------------------------------------------------------
// 背景：MiniStation 本机部署的 vLLM 引擎默认命令是系统 `python3 -m vllm.entrypoints.openai.api_server`，
// 而一键安装脚本（scripts/setup-vllm.sh）把 vLLM 装进项目根目录的 `.venv-vllm` 虚拟环境。
// 若直接以系统 python3 启动，会报 `ModuleNotFoundError: No module named 'vllm'`。
// 这里统一解析规则（命令构造 buildCommand 与引擎探测 probeEngines 共用同一判定）：
//   1) 显式配置优先：config.localEngineBin.vllm 或环境变量 MINISTATION_LOCAL_VLLM_BIN；
//   2) 其次自动识别项目内 `.venv-vllm/bin/python`（cwd 与 server 上级目录，能找到 import vllm 即采用）；
//   3) 最后回退系统 `python3 -m vllm.entrypoints.openai.api_server`。

const PROJECT_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');

/** "python -m x" 风格字符串 → 命令数组；空/非字符串返回 null */
export function normalizeBin(bin){return typeof bin==='string'&&bin.trim()?bin.trim().split(/\s+/).filter(Boolean):null;}

/** 候选虚拟环境解释器（去重，注意顺序即优先级） */
export function venvPythons(){
 const out=[];
 for(const base of [process.cwd(),PROJECT_ROOT]){
  const py=join(base,'.venv-vllm','bin','python');
  if(!out.includes(py))out.push(py);
 }
 if(process.env.VIRTUAL_ENV){
  const py=join(process.env.VIRTUAL_ENV,'bin','python');
  if(!out.includes(py))out.push(py);
 }
 return out;
}

function probe(py){
 try{
  const r=spawnSync(py,['-c','import vllm;print(vllm.__version__)'],{encoding:'utf8',timeout:15000,stdio:['ignore','pipe','ignore']});
  if(r.status===0)return {ok:true,version:(r.stdout||'').trim()};
 }catch{/* 解释器不可用 */ }
 return {ok:false};
}

/**
 * 解析 vLLM 引擎启动命令与探测结果（始终返回一个可用的 command 兜底）。
 * @param {string} [cfgVllm] config.localEngineBin.vllm（可为空）
 * @returns {{command:string[],source:'config'|'venv'|'system',available:boolean,path:string,version?:string}}
 */
export function resolveVllmCommand(cfgVllm=''){
 const cfg=(cfgVllm||'').trim();
 const explicit=normalizeBin(cfg||process.env.MINISTATION_LOCAL_VLLM_BIN||'');
 if(explicit)return {command:explicit,source:'config',available:true,path:cfg};
 for(const py of venvPythons()){
  if(!existsSync(py))continue;
  const p=probe(py);
  if(p.ok)return {command:[py,'-m','vllm.entrypoints.openai.api_server'],source:'venv',available:true,path:`${py} -m vllm.entrypoints.openai.api_server`,version:p.version};
 }
 const sys=probe('python3');
 return {command:['python3','-m','vllm.entrypoints.openai.api_server'],source:'system',available:sys.ok,path:'python3 -m vllm.entrypoints.openai.api_server',...(sys.ok?{version:sys.version}:{})};
}

/** 供 /api/local/engines 使用：只暴露探测结果 */
export function probeVllm(cfgVllm=''){
 const r=resolveVllmCommand(cfgVllm);
 const out={available:r.available,path:r.path};
 if(r.source==='venv')out.auto_venv=true;
 if(r.version)out.version=r.version;
 return out;
}
