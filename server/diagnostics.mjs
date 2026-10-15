// Findings are evidence-based suggestions, never automated repairs or readiness gates.
export function deploymentFindings(pods,events){
 const findings=[],seen=new Set();
 const add=(code,title,evidence,action,scope='deployment')=>{const key=code+':'+scope;if(seen.has(key))return;seen.add(key);findings.push({code,title,evidence,action,scope});};
 for(const p of pods){
  const scope=p.metadata?.name||'pod';
  for(const c of [...(p.status?.initContainerStatuses||[]),...(p.status?.containerStatuses||[])]){
   const state=c.state||{},last=c.lastState?.terminated;
   if(state.terminated?.reason==='OOMKilled'||last?.reason==='OOMKilled')add('OOM_KILLED','容器内存不足',`${scope} / ${c.name||'container'}：OOMKilled${last?'（上次退出）':''}`,'检查内存峰值和容器日志，增加容器内存或降低模型负载；这不是 GPU 显存不足的直接证据。',scope);
   const reason=state.waiting?.reason;
   if(['ErrImagePull','ImagePullBackOff'].includes(reason))add('IMAGE_PULL','镜像拉取失败',state.waiting.message||reason,'核对镜像仓库、摘要、网络与仓库认证配置，再重试部署。',scope);
   if(reason==='CrashLoopBackOff')add('CRASH_LOOP','容器反复退出',state.waiting.message||reason,'查看当前和上一次容器日志，检查启动参数、模型目录与引擎依赖；不要仅通过增加探针等待时间处理。',scope);
   if(['CreateContainerConfigError','CreateContainerError','RunContainerError'].includes(reason))add('CONTAINER_CONFIG','容器启动配置异常',state.waiting.message||reason,'检查事件中的缺失配置、卷挂载与文件权限，确认镜像支持非 root 用户。',scope);
  }
  for(const c of p.status?.conditions||[])if(c.type==='PodScheduled'&&c.status==='False')classify(c.reason||'FailedScheduling',c.message||'Pod 未完成调度',scope);
 }
 function classify(reason,message,scope){
  if(/unbound.*persistentvolumeclaim|persistentvolumeclaim.*not found|failedmount|failedattachvolume/i.test(reason+' '+message))add('MODEL_VOLUME','模型卷未就绪',message,'检查当前命名空间 PVC 是否存在且为 Bound，核对访问模式、节点挂载限制和存储驱动。',scope);
  else if(['FailedScheduling','Unschedulable'].includes(reason)||/Insufficient (cpu|memory|nvidia.com\/gpu)/i.test(message))add('SCHEDULING','没有满足条件的调度位置',message,'检查节点剩余 CPU、内存、GPU、资源池标签与污点。项目配额充足不代表节点有空闲容量。',scope);
  else if(reason==='Unhealthy')add('PROBE_FAILED','健康探针未通过',message,'核对端口和健康检查路径，查看模型加载日志。加载完成前不会接入流量；仅在确认正常慢加载后调整启动等待。',scope);
  else if(reason==='FailedCreate')add('CREATE_FAILED','副本创建失败',message,'检查命名空间配额、准入策略和 Deployment 事件，按具体拒绝原因修正配置。',scope);
 }
 for(const e of events)classify(e.reason||'',e.message||'',e.involvedObject?.name||'deployment');
 if(!pods.length)add('NO_PODS','尚未发现 Pod','当前部署没有匹配的 Pod','同步部署状态，检查任务记录与副本创建事件；若已停止，这是预期状态。');
 return findings;
}
