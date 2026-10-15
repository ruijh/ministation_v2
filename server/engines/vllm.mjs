import {leaderProbes,followerProbes,offlineEnvironment} from './common.mjs';
export const vllm={
 info:{id:'vllm',label:'vLLM',mode:'TP / MP',stage:'experimental',rendezvous_port:29501,api_port:8000,reference_version:'0.31.0',requirement:'镜像需包含 Python 3、vllm CLI 及多节点 MP/headless 接口（参考 v0.31.0），支持非 root 用户；不需要 Ray。'},
 topology(spec){return {tensor_parallel_size:spec.nodes.length*spec.gpus_per_node,pipeline_parallel_size:1,nodes:spec.nodes.length,executor:'mp'};},
 member(spec,{rank,address}){
  const topology=this.topology(spec);
  return {command:['vllm'],
   args:['serve',spec.model_path,'--served-model-name',spec.served_model,'--distributed-executor-backend','mp','--tensor-parallel-size',String(topology.tensor_parallel_size),'--pipeline-parallel-size','1','--data-parallel-size','1','--nnodes',String(spec.nodes.length),'--node-rank',String(rank),'--master-addr',address,'--master-port','29501',...(rank?['--headless']:['--host','0.0.0.0','--port','8000'])],
   // The process advertises its actual Pod IP, not a node address or loopback.
   env:[...offlineEnvironment(),{name:'VLLM_HOST_IP',valueFrom:{fieldRef:{apiVersion:'v1',fieldPath:'status.podIP'}}}],
   ...rank?followerProbes(address):leaderProbes(),
  };
 },
};
