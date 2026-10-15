import {z} from 'zod';
import {backendSchema,assertURL,fail,publicObject} from './domain.mjs';

export function installBackendEdit(app,s,config,{get,write,audit}){
 app.get('/api/backends/:id',(req,res)=>res.json(publicObject(get('backend',req))));
 app.post('/api/backends/:id/update',(req,res)=>{
  write(req,true);const old=get('backend',req);
  const {version,api_key,...data}=backendSchema.extend({version:z.number().int().positive()}).parse(req.body);
  data.base_url=assertURL(data.base_url,config.upstreamHosts);
  if(data.deployment_id!==undefined&&data.deployment_id!==old.deployment_id)fail(422,'DEPLOYMENT_IMMUTABLE','关联部署不可在此修改');
  if(data.distributed_id!==undefined&&data.distributed_id!==old.distributed_id)fail(422,'DEPLOYMENT_IMMUTABLE','关联模型组不可在此修改');
  const changed=['base_url','upstream_model','protocol','timeout_seconds'].filter(k=>data[k]!==old[k]);
  const rotate=typeof api_key==='string'&&api_key.length>0;
  const invalidate=changed.length>0||rotate;
  const updated=s.tx(()=>{
   if(s.list('backend',req.project).some(b=>b.id!==old.id&&b.name===data.name))fail(409,'NAME_EXISTS','服务名称已存在');
   s.update('backend',old.id,req.project,{...data,...(rotate?{secret:s.seal(api_key)}:{}),...(invalidate?{status:'Unverified',reason:null,checked_at:null,usage:null}:{})},version);
   s.db.prepare('UPDATE objects SET name=? WHERE id=?').run(data.name,old.id);
   if(invalidate&&old.deployment_id){const d=s.get('deployment',old.deployment_id,req.project);if(d)s.update('deployment',d.id,req.project,{conditions:{...d.conditions,ModelReady:false,EndpointReady:false}});}
   audit(req,'backend.update',old.id,{changed_fields:Object.keys(data).filter(k=>data[k]!==old[k]),credential_rotated:rotate,revalidation_required:invalidate});
   return s.get('backend',old.id,req.project);
  });
  res.json(publicObject(updated));
 });
}
