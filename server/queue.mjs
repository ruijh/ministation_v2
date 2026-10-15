import {z} from 'zod';
import {fail} from './domain.mjs';
export const queueSchema=z.object({enabled:z.boolean(),max_active:z.number().int().min(1).max(100),max_waiting:z.number().int().min(0).max(100),wait_seconds:z.number().int().min(1).max(120)}).strict();
export class RequestQueue{
 constructor(store){this.s=store;this.states=new Map();}
 policy(project){return this.s.list('queue_policy',project)[0]||{enabled:false,max_active:8,max_waiting:32,wait_seconds:30};}
 state(project){if(!this.states.has(project))this.states.set(project,{active:0,waiting:[],completed:0,timed_out:0,cancelled:0,rejected:0});return this.states.get(project);}
 snapshot(project){const {waiting,...rest}=this.state(project);return {...rest,waiting:waiting.length,oldest_wait_ms:waiting.length?Date.now()-waiting[0].at:0};}
 acquire(project,signal){
  const p=this.policy(project),s=this.state(project);if(signal.aborted)return Promise.reject(Object.assign(Error('请求已取消'),{status:499,code:'REQUEST_CANCELLED'}));
  const release=()=>{let released=false;return()=>{if(released)return;released=true;s.active--;s.completed++;const next=s.waiting.shift();if(next){next.cleanup();s.active++;next.resolve(release());}};};
  if(!p.enabled){s.active++;return Promise.resolve(release());}
  if(s.active<p.max_active){s.active++;return Promise.resolve(release());}
  if(s.waiting.length>=p.max_waiting||[...this.states.values()].reduce((n,v)=>n+v.waiting.length,0)>=1000){s.rejected++;return Promise.reject(Object.assign(Error('请求队列已满，请稍后重试'),{status:429,code:'QUEUE_FULL'}));}
  return new Promise((resolve,reject)=>{
   const entry={resolve,at:Date.now()},remove=(code,status,message)=>{const i=s.waiting.indexOf(entry);if(i<0)return;s.waiting.splice(i,1);entry.cleanup();s[code==='QUEUE_TIMEOUT'?'timed_out':'cancelled']++;reject(Object.assign(Error(message),{code,status}));};
   const cancelled=()=>remove('REQUEST_CANCELLED',499,'请求已取消'),timer=setTimeout(()=>remove('QUEUE_TIMEOUT',503,'排队超时，请稍后重试'),p.wait_seconds*1000);
   entry.cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancelled);};s.waiting.push(entry);signal.addEventListener('abort',cancelled,{once:true});
  });
 }
 middleware(gateway){return async(req,res,next)=>{const ctrl=new AbortController();res.once('close',()=>ctrl.abort());let release;try{
  const key=gateway.key((req.headers.authorization||'').replace(/^Bearer /i,''));
  if(!JSON.parse(key.models).includes(req.body?.model))fail(403,'MODEL_FORBIDDEN','该 Key 未授权此模型');
  if(!gateway.routes(key.project_id).some(r=>r.name===req.body?.model))fail(404,'MODEL_NOT_PUBLISHED','模型未发布');
  const began=Date.now();release=await this.acquire(key.project_id,ctrl.signal);
  if(ctrl.signal.aborted){release();return;}
  res.setHeader('X-Queue-Wait-Ms',String(Date.now()-began));res.once('finish',release);res.once('close',release);next();
 }catch(e){release?.();if(!res.destroyed)next(e);}};}
}
export function installQueue(app,{s,queue,write,audit}){
 app.get('/api/request-queue',(req,res)=>res.json({policy:queue.policy(req.project),state:queue.snapshot(req.project)}));
 app.post('/api/request-queue',(req,res)=>{write(req,true);const {version,...raw}=req.body,v=queueSchema.parse(raw),old=s.list('queue_policy',req.project)[0],state=queue.snapshot(req.project);if(state.active||state.waiting)fail(409,'QUEUE_BUSY','请等待在途和排队请求结束后修改队列');if(old)z.number().int().positive().parse(version);const result=old?s.update('queue_policy',old.id,req.project,v,version):s.put('queue_policy',req.project,'request-queue',v);audit(req,'queue.configure',result.id,v);res.json(result);});
}
