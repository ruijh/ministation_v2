import {leaderProbes,followerProbes,offlineEnvironment} from './common.mjs';
export const sglang={
 info:{id:'sglang',label:'SGLang',mode:'TP',stage:'experimental',rendezvous_port:20000,api_port:8000,requirement:'镜像需包含 Python 3 与 SGLang 多节点启动接口，支持非 root 用户。'},
 topology(spec){return {tensor_parallel_size:spec.nodes.length*spec.gpus_per_node,pipeline_parallel_size:1,nodes:spec.nodes.length,executor:'sglang'};},
 member(spec,{rank,address}){
  return {command:['python3','-m','sglang.launch_server'],
   args:['--model-path',spec.model_path,'--served-model-name',spec.served_model,'--tp-size',String(this.topology(spec).tensor_parallel_size),'--nnodes',String(spec.nodes.length),'--node-rank',String(rank),'--dist-init-addr',address+':20000','--host','0.0.0.0','--port','8000'],
   env:offlineEnvironment(),...rank?followerProbes(address):leaderProbes(),
  };
 },
};
