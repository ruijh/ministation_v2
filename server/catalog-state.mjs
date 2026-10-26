export function createRouteTargetState(store, local){
 return function routeTargetState(route){
  const project=route.project_id,target=store.get(route.target_kind,route.target_id,project);
  if(!target)return {state:'Missing',reason:'目录目标不存在或已删除'};
  const deploymentState=deployment=>{
   if(!deployment)return null;
   if(['Draft','Stopped','Deleted'].includes(deployment.status))return {state:'NotStarted',reason:deployment.reason||'目标部署未启动'};
   if(deployment.status==='Failed')return {state:'Failed',reason:deployment.reason||'目标部署启动失败'};
   if(!deployment.conditions?.InfrastructureReady)return {state:'Starting',reason:deployment.reason||'目标部署尚未就绪'};
   return null;
  };
  const backendState=backend=>{
   if(!backend)return {state:'Missing',reason:'接入服务不存在或已删除'};
   if(backend.status==='Failed')return {state:'Failed',reason:backend.reason||'接入服务验证失败'};
   if(backend.status!=='EndpointValidated')return {state:'Unverified',reason:backend.reason||'接入服务需要重新验证'};
   return deploymentState(backend.deployment_id?store.get('deployment',backend.deployment_id,project):null)
    ||(backend.distributed_id&&store.get('distributed',backend.distributed_id,project)?.status!=='Ready'?{state:'Starting',reason:'分布式模型组尚未就绪'}:null)
    ||(backend.local_id&&local?.get(project,backend.local_id)?.status!=='Running'?{state:'NotStarted',reason:'本机引擎未运行'}:null)
    ||{state:'Ready'};
  };
  if(route.target_kind==='backend')return backendState(target);
  const backendIds=[],visit=node=>{if(node?.backend_id)backendIds.push(node.backend_id);node?.children?.forEach(visit);};
  visit(target.graph);if(!backendIds.length)return {state:'Missing',reason:'服务编排缺少接入服务'};
  const states=backendIds.map(backendId=>backendState(store.get('backend',backendId,project)));
  return states.find(value=>value.state==='Failed')||states.find(value=>value.state==='NotStarted')||states.find(value=>value.state==='Starting')||states.find(value=>value.state!=='Ready')||{state:'Ready'};
 };
}
