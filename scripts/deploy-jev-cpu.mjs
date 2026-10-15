// Local administrator CLI. Requires filesystem access to the control-plane DB.
// Uses a short-lived session to exercise the same validated APIs as the console.
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createApp} from '../server/app.mjs';
import {hash} from '../server/store.mjs';
import {createBackup} from './backup.mjs';
import assert from 'node:assert/strict';

const dataDir=resolve(process.env.MINISTATION_DATA_DIR||'data');
await createBackup(dataDir,resolve(dataDir,'backups','before-jev-'+Date.now()));
const {app,store,kube,gateway}=createApp({dataDir,upstreamHosts:['127.0.0.1'],kubeUrl:'https://127.0.0.1:16443',kubeTokenFile:resolve('infra/wsl/credentials/controller.token'),kubeCa:resolve('infra/wsl/credentials/ca.crt')});
const admin=store.db.prepare("SELECT id,project_id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get();
if(!admin)throw Error('Initialize the administrator in the console first');
const token=randomBytes(32).toString('hex'),sessionHash=hash(token);
store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sessionHash,admin.id,Date.now()+20*60000);
store.audit(admin.project_id,'local-admin-cli','decision.install.start','jev-cpu');
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const base='http://127.0.0.1:'+server.address().port;let key;
async function api(path,body,status=200,headers={}){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Ministation-Client':'console',...headers},...(body?{body:JSON.stringify(body)}:{})});const output=await r.json();assert.equal(r.status,status,JSON.stringify(output.error||{status:r.status}));return output;}
async function wait(fn,label,timeout=240000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(e){last=e.message;}await new Promise(r=>setTimeout(r,2000));}throw Error(label+' timeout '+(last||''));}
try{
 const provenance=JSON.parse(readFileSync('examples/jev-cpu/provenance.json','utf8'));
 let model=(await api('/api/models')).find(m=>m.model_name==='Qwen/Qwen3-0.6B'&&m.task==='decision');
 if(!model)model=await api('/api/models',{name:'JEV CPU Qwen3 0.6B',model_name:provenance.model,model_version:provenance.model_revision,source:'external',task:'decision',description:'SemIf CPU FP32 选项概率读取；权重随固定摘要镜像部署；概率未校准。'},201);
 const image=readFileSync('examples/jev-cpu/image-ref.txt','utf8').trim();
 let deployment=(await api('/api/deployments')).find(d=>d.name==='JEV CPU Qwen3 0.6B');
 if(!deployment){const spec={name:'JEV CPU Qwen3 0.6B',kind:'ai',model_id:model.id,image,cpu:2,memory_gib:4,gpus:0,replicas:1,port:8000,health_path:'/api/health'};const check=await api('/api/deployments/validate',spec);assert.equal(check.valid,true,JSON.stringify(check));deployment=await api('/api/deployments',spec,201);}
 assert.equal(deployment.spec.image,image,'Existing deployment has a different image; use a revision explicitly');
 if(deployment.status==='Draft'){const op=await api('/api/deployments/'+deployment.id+'/launch',{},202);await wait(async()=>{const current=await api('/api/operations/'+op.id);if(current.status==='Failed')throw Error(current.error);return current.status==='Succeeded';},'deployment launch');}
 deployment=await wait(async()=>{const d=await api('/api/deployments/'+deployment.id+'/refresh',{});return d.conditions.InfrastructureReady?d:null;},'model readiness');
 writeFileSync('examples/jev-cpu/service-name.txt',deployment.resource_name);
 console.log('CPU deployment ready:',deployment.resource_name);
 let healthy=false;try{healthy=(await fetch('http://127.0.0.1:8801/api/health',{signal:AbortSignal.timeout(1000)})).ok;}catch{}
 if(!healthy){
  const wsl=(...args)=>execFileSync('wsl.exe',['-d','MiniStation','-u','root','--exec',...args],{windowsHide:true,stdio:'pipe',timeout:30000});
  const sourceDir=wsl('wslpath','-a',resolve('examples/jev-cpu')).toString().trim();
  const installDir='/opt/ministation/jev-forward';
  wsl('mkdir','-p',installDir);
  for(const file of ['port-forward.sh','service-name.txt'])wsl('cp',`${sourceDir}/${file}`,`${installDir}/${file}`);
  wsl('cp',`${sourceDir}/ministation-jev-forward.service`,'/etc/systemd/system/ministation-jev-forward.service');
  wsl('systemctl','daemon-reload');wsl('systemctl','enable','--now','ministation-jev-forward.service');
 }
 await wait(async()=>{const r=await fetch('http://127.0.0.1:8801/api/health',{signal:AbortSignal.timeout(1500)});return r.ok;},'port forward',30000);
 let backend=(await api('/api/backends')).find(b=>b.name==='JEV CPU decision');
 if(!backend)backend=await api('/api/backends',{name:'JEV CPU decision',logical_model:'jev-cpu-qwen3-0.6b',upstream_model:'Qwen/Qwen3-0.6B',protocol:'decision',base_url:'http://127.0.0.1:8801',deployment_id:deployment.id,timeout_seconds:120,input_rate:0,cache_rate:0,output_rate:0},201);
 await api('/api/backends/'+backend.id+'/probe',{});
 let route=(await api('/api/routes')).find(r=>r.name==='jev-cpu-qwen3-0.6b');
 if(!route)route=await api('/api/routes',{name:'jev-cpu-qwen3-0.6b',target_kind:'backend',target_id:backend.id},201);
 assert.equal(route.target_id,backend.id);if(!route.enabled)await api('/api/routes/'+route.id+'/toggle',{enabled:true,version:route.version});
 key=await api('/api/keys',{name:'JEV acceptance '+Date.now(),models:[route.name],expires:new Date(Date.now()+3600000).toISOString()},201);
 const response=await api('/v1/decisions',{model:route.name,state:'订单被重复扣款，请退回多扣的费用。',criteria:[{id:'route',question:'应由哪个部门处理？',options:[{id:'billing',description:'账单和退款'},{id:'technical',description:'技术故障'}]}]},200,{Authorization:'Bearer '+key.secret});
 assert.equal(response.results[0].winner,'billing');assert.ok(response.usage.prompt_tokens>0);assert.equal(response.usage.completion_tokens,0);
 const record=(await api('/api/usage')).find(u=>u.id===response.id);assert.equal(record.status,'settled');
 mkdirSync('artifacts/jev-cpu',{recursive:true});writeFileSync('artifacts/jev-cpu/validation.json',JSON.stringify({at:new Date().toISOString(),passed:true,image,model:provenance,deployment_id:deployment.id,service:deployment.resource_name,backend_id:backend.id,logical_model:route.name,response,usage:record},null,2));
 store.audit(admin.project_id,'local-admin-cli','decision.install.complete',backend.id,{deployment_id:deployment.id,logical_model:route.name});
 console.log('Published and verified:',route.name,'input tokens:',response.usage.prompt_tokens,'latency:',response.latency_ms);
}finally{
 if(key)await api('/api/keys/'+key.id+'/revoke',{}).catch(()=>{});
 store.db.prepare('DELETE FROM sessions WHERE hash=?').run(sessionHash);
 await new Promise(r=>server.close(r));await gateway.dispatcher.close();await kube.agent.close();store.close();
}
