// Standalone Node 24 router, mounted into the router Pod. No external dependencies.
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';

export function createPDRouter(config){
 let sequence=0,active=0;
 const clean=value=>{if(value&&typeof value==='object'){delete value.kv_transfer_params;delete value.prompt_token_ids;}return value;};
 const send=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 return http.createServer(async(req,res)=>{
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),config.timeout_ms||120000);
  res.on('close',()=>abort.abort());abort.signal.addEventListener('abort',()=>{if(!req.complete)req.destroy();},{once:true});let acquired=false;
  try{
   if(req.method==='GET'&&req.url==='/health'){
    await Promise.all([...config.prefill,...config.decode].map(async url=>{const r=await fetch(url+'/health',{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(3000)]),redirect:'error'});await r.body?.cancel();if(!r.ok)throw Error('unhealthy');}));
    return send(res,200,{status:'ok'});
   }
   if(req.method==='GET'&&req.url==='/v1/models')return send(res,200,{object:'list',data:[{id:config.model,object:'model',owned_by:'ministation'}]});
   if(req.method!=='POST'||req.url!=='/v1/chat/completions')return send(res,404,{error:{message:'Only chat completions are supported'}});
   if(active>=(config.max_inflight||32))return send(res,429,{error:{message:'PD router is busy'}});
   active++;acquired=true;
   const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024)return send(res,413,{error:{message:'Request too large'}});chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');
   let body;try{body=JSON.parse(raw);}catch{return send(res,400,{error:{message:'Invalid JSON'}});}
   if(!body||body.model!==config.model||!Array.isArray(body.messages)||!body.messages.length||body.messages.some(m=>typeof m.content!=='string')||(body.n!==undefined&&body.n!==1)||body.kv_transfer_params||body.prompt_token_ids||body.extra_body||body.stream!==undefined&&typeof body.stream!=='boolean')return send(res,400,{error:{message:'PD requires text messages, the configured model and n=1; transfer overrides are forbidden'}});
   const index=sequence++,requestId=randomUUID(),headers={'content-type':'application/json','x-request-id':requestId};
   const call=(url,data)=>fetch(url+req.url,{method:'POST',headers,body:JSON.stringify(data),signal:abort.signal,redirect:'error'});
   const prefill={...body,stream:false,max_tokens:1,kv_transfer_params:{do_remote_decode:true,do_remote_prefill:false,remote_engine_id:null,remote_block_ids:null,remote_host:null,remote_port:null}};
   if('max_completion_tokens' in prefill)prefill.max_completion_tokens=1;
   for(const key of ['stream_options','min_tokens','min_completion_tokens'])delete prefill[key];
   const p=await call(config.prefill[index%config.prefill.length],prefill);
   if(!p.ok){await p.body?.cancel();return send(res,p.status,{error:{message:'Prefill rejected the request'}});}
   const prepared=await p.json(),kv=prepared.kv_transfer_params;
   if(!kv||!kv.remote_engine_id||!Array.isArray(kv.remote_block_ids)||!kv.remote_host||!kv.remote_port)return send(res,502,{error:{message:'Prefill did not return valid KV transfer metadata'}});
   const d=await call(config.decode[index%config.decode.length],{...body,kv_transfer_params:kv});
   if(!d.ok){await d.body?.cancel();return send(res,d.status,{error:{message:'Decode rejected the request'}});}
   if(!body.stream)return send(res,200,clean(await d.json()));
   if(!d.headers.get('content-type')?.includes('text/event-stream')){await d.body?.cancel();return send(res,502,{error:{message:'Decode did not return SSE'}});}
   res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','x-accel-buffering':'no'});
   let pending='',done=false;const decoder=new TextDecoder();
   for await(const chunk of d.body){
    pending=(pending+decoder.decode(chunk,{stream:true})).replace(/\r\n/g,'\n');if(pending.length>2*1024*1024)throw Error('SSE frame too large');
    let end;while((end=pending.indexOf('\n\n'))>=0){const event=pending.slice(0,end);pending=pending.slice(end+2);const data=event.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(!data)continue;
     const output=data==='[DONE]'?'[DONE]':JSON.stringify(clean(JSON.parse(data)));
     if(!res.write('data: '+output+'\n\n'))await once(res,'drain',{signal:abort.signal});
     if(data==='[DONE]'){done=true;break;}
    }if(done)break;
   }
   if(!done)throw Error('Incomplete SSE');res.end();
  }catch{if(!res.destroyed){if(res.headersSent)res.destroy();else send(res,abort.signal.aborted?504:502,{error:{message:abort.signal.aborted?'PD request timed out':'PD upstream failure'}});}}
  finally{clearTimeout(timer);if(acquired)active--;}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const server=createPDRouter(JSON.parse(process.env.PD_CONFIG));server.listen(8000,'0.0.0.0');process.on('SIGTERM',()=>{server.close();setTimeout(()=>process.exit(0),55000).unref();});}
