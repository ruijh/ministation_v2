import {spawn} from 'node:child_process';

// Each job owns its process group. Keep its lock until the child has closed.
export function runProcess(command,args,emit=()=>{},{signal,env=process.env}={}){
 signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],env,windowsHide:true,detached:process.platform!=='win32'});
  let failure;
  const abort=()=>{
   if(!child.pid)return;
   if(process.platform==='win32'){
    const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
    killer.on('error',()=>child.kill('SIGKILL'));
    killer.on('exit',code=>{if(code)child.kill('SIGKILL');});
   }else{
    try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}
   }
  };
  const push=chunk=>{if(!signal?.aborted)emit(chunk.toString());};
  child.stdout.on('data',push);child.stderr.on('data',push);
  child.on('error',error=>{failure=error;});
  child.on('close',code=>{
   signal?.removeEventListener('abort',abort);
   if(signal?.aborted)reject(signal.reason);
   else if(failure)reject(failure);
   else if(code!==0)reject(new Error(`命令退出码 ${code}`));
   else resolve();
  });
  signal?.addEventListener('abort',abort,{once:true});
  if(signal?.aborted)abort();
 });
}
