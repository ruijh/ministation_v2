import {readdirSync,readFileSync,existsSync,statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fail} from './domain.mjs';
import {probeVllm} from './vllm-bin.mjs';

const GIB=2**30;
const MB=1024**2;

function dirSize(path){let total=0;try{for(const e of readdirSync(path,{withFileTypes:true})){const p=join(path,e.name);try{const st=statSync(p);if(st.isDirectory())total+=dirSize(p);else if(st.isFile())total+=st.size;}catch{continue;}}}catch{}return total;}

// 扫描一个根目录：直接子项中的 HF 模型目录（config.json + 权重索引）与 .gguf 文件
export function modelMaxCtx(path){
 // 模型 config.json 显式声明的最大上下文（max_position_embeddings 或 model_max_length）。
 // 返回 null 表示未声明（如 Qwen3.5 等新架构留给 vLLM 自行推导），此时不应做 4096 之类的臆断上限。
 try{
  if(!existsSync(join(path,'config.json')))return null;
  const c=JSON.parse(readFileSync(join(path,'config.json'),'utf8'));
  const m=Number(c.max_position_embeddings)||Number(c.model_max_length)||0;
  return m>0?m:null;
 }catch{return null;}
}

export function scanModelRoot(root){
 root=resolve(root);if(!existsSync(root))return {root,models:[]};
 const models=[];
 const entries=readdirSync(root,{withFileTypes:true});
 for(const e of entries){
  const p=join(root,e.name);
  if(e.name.endsWith('.gguf')&&e.isFile()){try{const st=statSync(p);models.push({path:p,name:e.name,kind:'gguf',engine_hint:'llamacpp',size_gib:+(st.size/GIB).toFixed(2)});}catch{}continue;}
  if(!e.isDirectory())continue;
  const config=join(p,'config.json');
  const hasWeights=existsSync(join(p,'model.safetensors.index.json'))||existsSync(join(p,'model.safetensors'))||existsSync(join(p,'pytorch_model.bin'))||existsSync(join(p,'model.bin'));
  if(!existsSync(config)||!hasWeights)continue;
  let arch='',modelType='';
  try{const c=JSON.parse(readFileSync(config,'utf8'));arch=(c.architectures||[])[0]||'';modelType=c.model_type||'';}catch{}
  models.push({path:p,name:e.name,kind:'hf',arch,model_type:modelType,max_ctx:modelMaxCtx(p),engine_hint:modelType==='deepseek_v4'?'vllm':'hf',size_gib:+(dirSize(p)/GIB).toFixed(2)});
 }
 return {root,models:models.sort((a,b)=>b.size_gib-a.size_gib)};
}

export function listModelRoots(config,extra=[]){
 const explicit=config.modelScanRoots&&config.modelScanRoots.length?config.modelScanRoots:null;
 const base=(explicit||(config.modelRoot?[config.modelRoot]:['/home','/data','/models','/opt/models'])).filter(Boolean);
 const roots=[...new Set([...base.map(s=>String(s).trim()).filter(Boolean),...extra.map(s=>String(s).trim()).filter(Boolean)])];
 const out=[];
 for(const r of roots){try{out.push(scanModelRoot(r));}catch{continue;}}
 return out.flatMap(x=>x.models);
}

function hasInPath(bin){try{return spawnSync('sh',['-c',`command -v ${JSON.stringify(bin)}`],{encoding:'utf8',timeout:3000}).status===0;}catch{return false;}}
function hfFileExists(p){try{return existsSync(p);}catch{return false;}}
export function probeEngines(binCfg={}){
 const llamacppBin=(binCfg.llamacpp||'llama-server').trim();
 const llamacpp=hfFileExists(llamacppBin)||hasInPath(llamacppBin)?{available:true,path:llamacppBin}:{available:false,path:llamacppBin};
 // vLLM 探测与命令构造共用同一套解析（显式配置 / .venv-vllm 自动识别 / 系统 python3）
 return {llamacpp,vllm:probeVllm(binCfg.vllm)};
}

export function installModelScan(app,{config,s}){
 app.get('/api/local/models',(req,res)=>{
  const extra=Array.isArray(s?.list?.('modelroot',req.project))?s.list('modelroot',req.project).map(r=>r.path):[];
  const dir=req.query.dir?String(req.query.dir):null;
  if(dir){const resolved=resolve(dir);const allowed=!!listModelRoots(config,extra).find(m=>m.path===resolved)||(config.modelRoot&&resolve(config.modelRoot)===resolved);if(!allowed)fail(403,'PATH_FORBIDDEN','仅允许扫描已配置的模型根目录');return res.json(scanModelRoot(dir));}
  res.json({models:listModelRoots(config,extra)});
 });
 app.get('/api/local/engines',(req,res)=>res.json(probeEngines(config.localEngineBin||{})));
}
