import {z} from 'zod';
import {createHmac} from 'node:crypto';
import {assertURL,name,fail} from './domain.mjs';
import {id,now} from './store.mjs';
const schema=z.object({name,url:z.string().url(),signing_secret:z.string().min(16).max(256),enabled:z.boolean().default(false)}).strict();
const publicChannel=c=>({id:c.id,name:c.name,version:c.version,enabled:c.enabled,host:c.host,has_credential:true});
export function createWebhooks(s,config){
 let work=null,stopped=false,timer;
 function enqueue(project,event){for(const c of s.list('webhook',project).filter(c=>c.enabled)){const key=c.id+':'+event.id;if(s.list('webhook_delivery',project).some(d=>d.name===key))continue;s.put('webhook_delivery',project,key,{channel_id:c.id,event,status:'Pending',attempts:0,next_at:Date.now(),last_error:null});}}
 async function tick(){
  for(const project of s.list('project','system'))for(const d of s.list('webhook_delivery',project.id).filter(d=>d.status==='Pending'&&d.next_at<=Date.now()).slice(0,20)){
   if(stopped)return;const c=s.get('webhook',d.channel_id,project.id);if(!c?.enabled){s.update('webhook_delivery',d.id,project.id,{status:'Cancelled',last_error:'渠道已禁用'});continue;}
   if(d.attempts>=5){s.update('webhook_delivery',d.id,project.id,{status:'Failed',last_error:'投递尝试已达上限，接收端需核对事件 ID'});continue;}
   const attempts=d.attempts+1;let status='Delivered',error=null;
   // Persist the attempt before network I/O. Receivers deduplicate using the stable event ID.
   s.update('webhook_delivery',d.id,project.id,{attempts,next_at:Date.now()+Math.min(300000,10000*2**attempts)});
   try{const url=assertURL(s.unseal(c.url_secret),config.webhookHosts||[]),payload=JSON.stringify(d.event),timestamp=String(Math.floor(Date.now()/1000));const signature=createHmac('sha256',s.unseal(c.secret)).update(timestamp+'.'+payload).digest('hex');
    const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'content-type':'application/json','x-ministation-event-id':d.event.id,'x-ministation-timestamp':timestamp,'x-ministation-signature':'sha256='+signature},body:payload});await response.body?.cancel();if(!response.ok){error='HTTP '+response.status;status=response.status===429||response.status>=500?'Pending':'Failed';}
   }catch{status='Pending';error='连接失败、超时或目标不在允许列表';}
   if(status==='Pending'&&attempts>=5)status='Failed';
   if(status==='Pending'&&!s.get('webhook',c.id,project.id)?.enabled){status='Cancelled';error='渠道已禁用';}
   s.update('webhook_delivery',d.id,project.id,{status,last_error:error,finished_at:status==='Pending'?null:now()});s.audit(project.id,'webhook-worker','webhook.'+status.toLowerCase(),d.id,{attempts});
  }
 }
 const process=()=>work|| (work=tick().finally(()=>{work=null;}));
 return {enqueue,process,start(){if(timer)return;stopped=false;timer=setInterval(()=>{void process().catch(()=>console.error('webhook_worker_failed'));},1000);timer.unref();},async stop(){stopped=true;clearInterval(timer);timer=null;await work;}};
}
export function installWebhooks(app,{s,config,webhooks,get,write,audit}){
 app.get('/api/webhooks',(req,res)=>{write(req,true);res.json({channels:s.list('webhook',req.project).map(publicChannel),deliveries:s.list('webhook_delivery',req.project).slice(0,100),allowed_hosts:config.webhookHosts||[]});});
 app.post('/api/webhooks',(req,res)=>{write(req,true);const v=schema.parse(req.body),url=assertURL(v.url,config.webhookHosts||[]);const c=s.put('webhook',req.project,v.name,{enabled:v.enabled,host:new URL(url).hostname,url_secret:s.seal(url),secret:s.seal(v.signing_secret)});audit(req,'webhook.create',c.id,{host:c.host,enabled:c.enabled});res.status(201).json(publicChannel(c));});
 app.post('/api/webhooks/:id/toggle',(req,res)=>{write(req,true);const c=get('webhook',req),v=z.object({enabled:z.boolean(),version:z.number().int().positive()}).parse(req.body);const updated=s.update('webhook',c.id,req.project,{enabled:v.enabled},v.version);if(!v.enabled)for(const d of s.list('webhook_delivery',req.project).filter(d=>d.channel_id===c.id&&d.status==='Pending'))s.update('webhook_delivery',d.id,req.project,{status:'Cancelled',last_error:'渠道已禁用'});audit(req,'webhook.toggle',c.id,{enabled:v.enabled});res.json(publicChannel(updated));});
 app.post('/api/webhooks/:id/test',(req,res)=>{write(req,true);const c=get('webhook',req);if(!c.enabled)fail(409,'CHANNEL_DISABLED','请先启用渠道');const event={id:id(),type:'test',project_id:req.project,at:now(),message:'MiniStation Webhook connectivity test'};const d=s.put('webhook_delivery',req.project,c.id+':'+event.id,{channel_id:c.id,event,status:'Pending',attempts:0,next_at:Date.now()});audit(req,'webhook.test',c.id);res.status(202).json(d);});
}
