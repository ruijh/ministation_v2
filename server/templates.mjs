import {z} from 'zod';
import {fail} from './domain.mjs';
import {deploymentSchema} from './domain.mjs';
import {now} from './store.mjs';

// 部署模板 v2：
//  - 参数化：spec 内可含 {{变量}} 占位符，variables 声明元数据；“使用模板”时按值渲染。
//  - 管理：编辑（名称/说明/变量/置顶）、删除、使用次数。
//  - 共享：导出 YAML / 导入（跨项目），内置模板目录（本机与集群常用配方）。
//  - 兼容旧模板（无 variables / scope 字段）。

const KEY=/^[A-Za-z0-9_.-]+$/;
const variableSchema=z.array(z.object({key:z.string().trim().regex(KEY).min(1).max(40),label:z.string().max(80).optional().default(''),required:z.boolean().default(true),default:z.union([z.string(),z.number()]).optional()})).default([]);

export function collectVars(spec){const set=new Set();const walk=v=>{if(typeof v==='string'){let m;const re=/{{([A-Za-z0-9_.-]+)}}/g;while((m=re.exec(v)))set.add(m[1]);}else if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')Object.values(v).forEach(walk);};walk(spec);return [...set];}
export function renderTpl(spec,declared,values={}){
 const missing=[];const valueOf=key=>{const d=declared.find(x=>x.key===key);const v=values[key]!==undefined?values[key]:d?.default;if((d?.required??true)&&(v===undefined||v===''))missing.push(d?.label||key);return v==null?'':String(v);};
 const walk=v=>{if(typeof v==='string')return v.replace(/{{([A-Za-z0-9_.-]+)}}/g,(_,k)=>valueOf(k));if(Array.isArray(v))return v.map(walk);if(v&&typeof v==='object'){const o={};for(const[k,x]of Object.entries(v))o[k]=walk(x);return o;}return v;};
 const out=walk(spec);
 if(missing.length)fail(422,'MISSING_PARAMS','请填写模板参数：'+missing.filter((x,i,a)=>a.indexOf(x)===i).join('、'));
 const leftover=collectVars(out);if(leftover.length)fail(422,'UNKNOWN_PARAMS','模板包含未声明的参数：'+leftover.join('、'));
 return out;
}

// ── 极简 YAML（块风格子集），用于模板导出/导入，自包含、无第三方依赖 ──
export function yamlDump(value){
 const lines=[];
 const scalar=v=>{if(v==null)return 'null';if(v===true)return 'true';if(v===false)return 'false';if(typeof v==='number')return String(v);const s=String(v);const bad=/[:#\[\]{},&*!|>'"%@`\n]/.test(s)||s!==s.trim()||/^[\-\s]/.test(s)||/^(null|true|false|yes|no|on|off)$/i.test(s)||/^[0-9]/.test(s);return bad?JSON.stringify(s):s;};
 const walk=(v,ind)=>{const pad=' '.repeat(ind);
  if(Array.isArray(v)){if(!v.length){lines.push(pad+'[]');return;}for(const x of v){if(x&&typeof x==='object'){lines.push(pad+'-');walk(x,ind+2);}else lines.push(pad+'- '+scalar(x));}return;}
  if(v&&typeof v==='object'){const keys=Object.keys(v);if(!keys.length){lines.push(pad+'{}');return;}for(const k of keys){const x=v[k];if(Array.isArray(x)&&x.length===0){lines.push(pad+k+': []');}else if(Array.isArray(x)){lines.push(pad+k+':');walk(x,ind+2);}else if(x&&typeof x==='object'&&Object.keys(x).length===0){lines.push(pad+k+': {}');}else if(x&&typeof x==='object'){lines.push(pad+k+':');walk(x,ind+2);}else lines.push(pad+k+': '+scalar(x));}return;}
  lines.push(pad+scalar(v));};
 walk(value,0);return lines.join('\n')+'\n';
}
export function yamlParse(text){
 const toks=text.split(/\r?\n/).map(l=>({ind:l.match(/^ */)[0].length,raw:l})).filter(t=>t.raw.trim()&&!t.raw.trim().startsWith('#'),);
 let i=0;
 const scalar=s=>{s=s.trim();if(!s||s==='null'||s==='~')return null;if(s==='true'||s==='yes'||s==='on')return true;if(s==='false'||s==='no'||s==='off')return false;if(s==='[]')return [];if(s==='{}')return {};if(/^[-+]?\d+$/.test(s))return Number(s);if(/^[-+]?\d*\.\d+$/.test(s))return Number(s);if((s.startsWith('"')&&s.endsWith('"'))||(s.startsWith("'")&&s.endsWith("'")))return s.length>=2?s.slice(1,-1):s;return s;};
 function node(ind){
  const t=toks[i]||{ind,raw:''};
  if(t.raw.trim().startsWith('-')){
   const arr=[];
   while(i<toks.length&&toks[i].ind===ind&&toks[i].raw.trim().startsWith('-')){
    const line=toks[i].raw.trim();const rest=line==='-'?'':line.slice(1).trim();i++;
    if(rest==='')arr.push(node(ind+2));
    else{const m=rest.match(/^([^,:"]+):\s*(.*)$/);if(m){const item={};if(toks[i]&&toks[i].ind===ind+2)Object.assign(item,node(ind+2));item[m[1].trim()]=m[2]?scalar(m[2]):(item[m[1].trim()]??null);arr.push(item);}else arr.push(scalar(rest));}
   }
   return arr;
  }
  const obj={};
  while(i<toks.length&&toks[i].ind===ind&&!toks[i].raw.trim().startsWith('-')&&toks[i].raw.includes(':')){
   const m=toks[i].raw.match(/^([^,:"]+):\s*(.*)$/);if(!m)break;const key=m[1].trim();const val=m[2];i++;
   obj[key]=val?scalar(val):node(ind+2);
  }
  return obj;
 }
 const v=node(0);return v&&Object.keys(v).length?v:{};
}

// ── 内置模板目录（预置栈）──
const L=(name,description,variables,spec,extra={})=>({id:slug(name),name,description,scope:'local',kind:spec.engine||'local',variables,...extra,spec});
const C=(name,description,kind,variables,spec,extra={})=>({id:slug(name),name,description,scope:'cluster',kind,variables,...extra,spec});
function slug(s){return s.replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g,'-').replace(/^-|-$/g,'');}
function v(key,label,required=true,def){return {key,label,required,default:def};}
export const TEMPLATES_V2=1;
export const BUILTIN_TEMPLATES=[
 L('本机 · vLLM 推理（HF 模型）','在本机用 vLLM 直接推理 HuggingFace 模型目录；适合大模型，支持多卡张量并行。需先经“环境初始化”就绪 vLLM。',
  [v('model_path','模型目录绝对路径',true),v('model_name','对外模型名',false,'my-model'),v('gpus','GPU 数量',false,'0'),v('port','监听端口',false,'8080'),v('max_model_len','最大上下文（可选）',false,'')],
  {engine:'vllm',model:'{{model_path}}',served_model:'{{model_name}}',protocol:'chat',port:'{{port}}',gpus:'{{gpus}}',max_model_len:'{{max_model_len}}'}),
 L('本机 · llama.cpp（GGUF）','用 llama.cpp 在本机运行 GGUF 量化模型，CPU/GPU 均可，开箱即用。',
  [v('model_path','.gguf 文件绝对路径',true),v('model_name','对外模型名',false,'my-model'),v('port','监听端口',false,'8080'),v('threads','CPU 线程',false,'')],
  {engine:'llamacpp',model:'{{model_path}}',served_model:'{{model_name}}',protocol:'chat',port:'{{port}}',threads:'{{threads}}',gpus:'0'}),
 L('本机 · 自定义引擎','以自定义命令 + 参数在本机启动任意 OpenAI 兼容引擎。',
  [v('command','启动命令（空格分隔）',true),v('args','附加参数（空格分隔）',false,''),v('model_name','对外模型名',false,'my-model'),v('port','监听端口',false,'8080')],
  {engine:'custom',model:'',served_model:'{{model_name}}',protocol:'chat',port:'{{port}}',command:['{{command}}'],args:['{{args}}']}),
 C('集群 · vLLM 大模型推理','Kubernetes 容器部署 vLLM 推理引擎。镜像需 vLLM 版本；模型数据挂载自 PVC。',
  'llm',[v('image','推理镜像（含 sha256 摘要）',true),v('hf_model','模型仓库 ID 或路径',true),v('model_pvc','模型 PVC 名称（可选）',false,''),v('model_name','对外模型名',false,'my-model'),v('gpus','每副本 GPU 数',false,'1'),v('cpu','每副本 CPU（核）',false,'8'),v('memory_gib','每副本内存（GiB）',false,'32')],
  {kind:'llm',image:'{{image}}',cpu:8,memory_gib:32,gpus:0,replicas:1,port:8000,health_path:'/health',command:[],args:['--model','{{hf_model}}','--served-model-name','{{model_name}}','--tensor-parallel-size','{{gpus}}','--host','0.0.0.0','--port','8000'],model_pvc:'{{model_pvc}}',model_mount:'/models',node_selector:{},labels:{}},
  {variables_note:'image 必须为带 @sha256 摘要的固定镜像；hf_model/model_name 可留空改用手动参数。'}),
 C('集群 · llama.cpp 服务','llama-server 容器：从 PVC 挂载 GGUF 模型运行量化推理。','image',
  [v('image','llama-server 镜像（含 sha256 摘要）',true),v('gguf_path','PVC 内 .gguf 路径',true),v('model_pvc','模型 PVC 名称（可选）',false,''),v('port','服务端口',false,'8080'),v('gpus','每副本 GPU 数',false,'0')],
  {kind:'image',image:'{{image}}',cpu:4,memory_gib:8,gpus:0,replicas:1,port:8000,health_path:'/health',command:['llama-server'],args:['-m','/models/{{gguf_path}}','--host','0.0.0.0','--port','8000','--n-gpu-layers','-1'],model_pvc:'{{model_pvc}}',model_mount:'/models',node_selector:{},labels:{}}),
 C('集群 · 镜像部署（通用）','以固定镜像 + 类型化命令运行任意服务。','image',
  [v('image','容器镜像（含 sha256 摘要）',true),v('command','Command JSON',false,'[]'),v('args','Args JSON',false,'[]'),v('cpu','每副本 CPU（核）',false,'2'),v('memory_gib','每副本内存（GiB）',false,'4'),v('port','服务端口',false,'8000')],
  {kind:'image',image:'{{image}}',cpu:2,memory_gib:4,gpus:0,replicas:1,port:8000,health_path:'/health',command:['{{command}}'],args:['{{args}}'],node_selector:{},labels:{}}),
 C('集群 · AI 模型部署','分类、向量等自定义服务，含模型 PVC 挂载。','ai',
  [v('image','AI 服务镜像（含 sha256 摘要）',true),v('model_pvc','模型 PVC 名称（可选）',false,''),v('port','服务端口',false,'8000'),v('cpu','每副本 CPU（核）',false,'2'),v('memory_gib','每副本内存（GiB）',false,'4')],
  {kind:'ai',image:'{{image}}',cpu:2,memory_gib:4,gpus:0,replicas:1,port:8000,health_path:'/health',command:[],args:[],model_pvc:'{{model_pvc}}',model_mount:'/models',node_selector:{},labels:{}}),
];

// ── 路由安装 ──
function normalizeImport(obj){
 const src=(obj&&typeof obj==='object'&&obj.template&&typeof obj.template==='object')?obj.template:obj;
 const spec=src?.spec;if(!spec||typeof spec!=='object'||Array.isArray(spec))fail(422,'IMPORT_INVALID','导入内容缺少有效的 spec');
 const scopeString=src?.scope==='local'?'local':'cluster';
 const variables=variableSchema.parse(Array.isArray(src?.variables)?src.variables:[]);
 const name=String(src?.name||'').trim().slice(0,100);if(!name)fail(422,'IMPORT_INVALID','模板名称不能为空');
 return {name,description:String(src?.description||'').slice(0,1000),scope:scopeString,kind:String(src?.kind||'llm').slice(0,20),variables,spec};
}
export function installTemplates(app,{s,get,write,audit}){
 app.get('/api/templates',(req,res)=>{
  const usages={};for(const d of s.list('deployment',req.project))if(d.from_template)usages[d.from_template]=(usages[d.from_template]||0)+1;
  for(const r of s.list('local',req.project))if(r.from_template)usages[r.from_template]=(usages[r.from_template]||0)+1;
  const rows=(s.list('template',req.project)||[]).map(t=>({...t,pinned:!!t.pinned,variables:t.variables||[],scope:t.scope||'cluster',usage:usages[t.id]||0}));
  res.json(rows.sort((a,b)=>(b.pinned?1:0)-(a.pinned?1:0)||(b.updated_at||b.verified_at||'').localeCompare(a.updated_at||a.verified_at||'')));
 });
 app.post('/api/templates',(req,res)=>{
  write(req);const v=z.object({name:z.string().trim().min(1).max(100),description:z.string().max(1000).default(''),deployment_id:z.string(),variables:variableSchema}).parse(req.body);
  const source=get('deployment',req,v.deployment_id);
  if(!source.conditions.InfrastructureReady)fail(409,'TEMPLATE_NOT_READY','请从容器已就绪的部署保存模板');
  const spec=deploymentSchema.parse(source.spec);if(!/@sha256:[a-f0-9]{64}$/.test(spec.image))fail(422,'IMAGE_DIGEST_REQUIRED','模板需要固定镜像摘要');
  const variables=[...v.variables];for(const k of collectVars(spec))if(!variables.some(x=>x.key===k))variables.push({key:k,label:k,required:true});
  const template=s.put('template',req.project,v.name,{description:v.description,spec,variables,scope:'cluster',template_revision:1,source_deployment:source.id,source_revision:source.revision,verified_at:now(),pinned:false,usage_count:0});audit(req,'template.create',template.id);res.status(201).json(template);
 });
 app.get('/api/templates/catalog',(req,res)=>res.json({templates:BUILTIN_TEMPLATES.map(t=>({...t,variables:t.variables||[]}))}));
 app.put('/api/templates/:id',(req,res)=>{write(req);const t=get('template',req);
  const v=z.object({name:z.string().trim().min(1).max(100).optional(),description:z.string().max(1000).optional(),variables:variableSchema.optional(),pinned:z.boolean().optional()}).parse(req.body);
  const data={...t,name:undefined,description:v.description??t.description,variables:v.variables??(t.variables||[]),pinned:v.pinned??!!t.pinned};
  if(v.name&&v.name!==t.name){const nv=s.update('template',t.id,req.project,data);s.db.prepare('UPDATE objects SET name=? WHERE kind=? AND id=?').run(v.name,'template',t.id);audit(req,'template.edit',t.id);res.json({...nv,name:v.name,pinned:data.pinned});}else{audit(req,'template.edit',t.id);res.json({...s.update('template',t.id,req.project,data),name:t.name,pinned:data.pinned});}
 });
 app.delete('/api/templates/:id',(req,res)=>{write(req);const t=get('template',req);s.remove('template',t.id,req.project);audit(req,'template.delete',t.id);res.json({ok:true});});
 app.post('/api/templates/:id/use',(req,res)=>{write(req);const t=get('template',req);const n=(t.usage_count||0)+1;s.update('template',t.id,req.project,{...t,usage_count:n,updated_at:now()});audit(req,'template.use',t.id);res.json({usage_count:n});});
 app.post('/api/templates/:id/render',(req,res)=>{const t=get('template',req);const values=z.record(z.string(),z.union([z.string(),z.number()])).default({}).parse(req.body.values||{});res.json({variables:t.variables||[],spec:renderTpl(t.spec,t.variables||[],values)});});
 app.get('/api/templates/:id/export',(req,res)=>{const t=get('template',req);const {id,created_at,updated_at,source_deployment,source_revision,template_revision,verified_at,...rest}=t;const raw=String(rest.name||'template').replace(/[\\\";,\s]+/g,'-').replace(/-+/g,'-').slice(0,60);const ascii=raw.replace(/[^\x20-\x7E]/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'')||'template';res.setHeader('Content-Type','text/yaml; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="${ascii}.yaml"; filename*=UTF-8''${encodeURIComponent(raw)}.yaml`);res.send(yamlDump({apiVersion:'ministation.io/v1',kind:'DeploymentTemplate',template:rest}));});
 app.post('/api/templates/import',(req,res)=>{write(req);const v=z.object({yaml:z.string().optional(),template:z.any().optional()}).parse(req.body);let obj=null;if(v.yaml)obj=yamlParse(v.yaml);else if(v.template)obj=v.template;else fail(422,'IMPORT_EMPTY','请提供 yaml 或 template 内容');const tpl=normalizeImport(obj);const exists=n=>s.list('template',req.project).some(x=>x.name===n);let name=tpl.name,i=1;while(exists(name))name=`${tpl.name}-${i++}`;const rec=s.put('template',req.project,name,{...tpl,name:undefined,scope:tpl.scope,kind:tpl.kind,pinned:false,usage_count:0,imported_from:'yaml',template_revision:1,verified_at:now()});audit(req,'template.import',rec.id,{name});res.status(201).json(rec);});
}
