import {localLogFindings} from './local-logs.mjs';

export async function collectPodLogs(kube,namespace,pods,{maxSources=20}={}){
 const sources=[];
 for(const pod of pods){
  const statuses=[...(pod.status?.initContainerStatuses||[]),...(pod.status?.containerStatuses||[])];
  const containers=[...(pod.spec?.initContainers||[]),...(pod.spec?.containers||[])];
  if(!containers.length)containers.push(...statuses);
  if(!containers.length)containers.push({name:undefined});
  for(const container of containers){
   const source={pod:pod.metadata.name,container:container.name,previous:false};sources.push(source);
   const status=statuses.find(s=>s.name===container.name);
   if(status?.restartCount>0||status?.lastState?.terminated)sources.push({...source,previous:true});
  }
 }
 const selected=sources.slice(0,maxSources),logs=new Array(selected.length);let next=0;
 await Promise.all(Array.from({length:Math.min(4,selected.length)},async()=>{
  while(next<selected.length){
   const index=next++,source=selected[index];
   try{const text=String(await kube.logs(namespace,source.pod,source.previous,source.container));logs[index]={...source,text,available:true,findings:localLogFindings(text.split(/\r?\n/))};}
   catch(error){logs[index]={...source,text:'',available:false,error:{code:error.code||'LOG_UNAVAILABLE',message:error.message}};}
  }
 }));
 return {logs,truncated:sources.length>selected.length,total_sources:sources.length,observed_at:new Date().toISOString(),text:logs.map(log=>`=== ${log.pod} / ${log.container||'default'} / ${log.previous?'previous':'current'} ===\n${log.available?log.text:'日志采集失败：'+log.error.message}`).join('\n\n')};
}
