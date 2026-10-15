import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {deploymentManifest} from './domain.mjs';
import {leaderProbes,offlineEnvironment} from './engines/common.mjs';

export const pdPresets=[
 {id:'balanced',label:'初次验证 / 均衡对话',description:'从 1P1D 建立基线，适合负载特征尚不明确时。',prefill:1,decode:1,max_model_len:8192,prefill_batch:4096,decode_batch:2048,max_num_seqs:32,gpu_memory_utilization:0.85},
 {id:'long-input',label:'长输入 / 文档问答',description:'2P1D 增加输入处理能力；先观察 TTFT 和 Prefill 排队，网络传输可能抵消收益。',prefill:2,decode:1,max_model_len:32768,prefill_batch:8192,decode_batch:2048,max_num_seqs:32,gpu_memory_utilization:0.85},
 {id:'long-output',label:'长输出 / 持续生成',description:'1P2D 分摊生成请求；先观察生成间隔、Decode 并发和 KV 显存占用。',prefill:1,decode:2,max_model_len:16384,prefill_batch:4096,decode_batch:2048,max_num_seqs:64,gpu_memory_utilization:0.85},
];
export const pdSchema=z.object({
 preset:z.enum(['balanced','long-input','long-output','custom']).default('balanced'),
 prefill_nodes:z.number().int().min(1).max(7),router_image:z.string().regex(/^[^\s]+@sha256:[a-f0-9]{64}$/),
 max_model_len:z.number().int().min(512).max(131072),prefill_batch:z.number().int().min(512).max(32768),decode_batch:z.number().int().min(512).max(32768),max_num_seqs:z.number().int().min(1).max(256),
 gpu_memory_utilization:z.number().min(0.5).max(0.95),timeout_seconds:z.number().int().min(10).max(600).default(120),
}).strict();
export const pdOverhead=v=>v.mode==='pd'?0.5:0;
export function pdManifests(v,namespace,prefix,nodeSelector){
 const group={'ministation.io/distributed':prefix},docs=[],p=v.pd;
 const service=(name,role)=>({apiVersion:'v1',kind:'Service',metadata:{name,namespace},spec:{type:'ClusterIP',selector:{...group,'ministation.io/role':role},ports:[{name:'http',port:8000,targetPort:8000}]}});
 const base={name:v.name,kind:'llm',image:v.image,cpu:v.cpu,memory_gib:v.memory_gib,gpus:v.gpus_per_node,replicas:1,labels:v.labels,command:[],args:[],port:8000,health_path:'/health',model_pvc:v.model_pvc,model_mount:'/models'};
 const peers={prefill:[],decode:[]};
 v.nodes.forEach((node,i)=>{
  const role=i<p.prefill_nodes?'prefill':'decode',member=role+'-'+i,key=prefix+'-'+i;
  peers[role].push(`http://${key}.${namespace}.svc:8000`);docs.push(service(key,member));
  const [d]=deploymentManifest({...base,node_selector:{...nodeSelector,'kubernetes.io/hostname':node}},namespace,key),pod=d.spec.template.spec,c=pod.containers[0];
  d.spec.strategy={type:'Recreate'};delete pod.topologySpreadConstraints;pod.terminationGracePeriodSeconds=60;
  d.spec.template.metadata.labels={...d.spec.template.metadata.labels,...group,'ministation.io/role':member,'ministation.io/rank':String(i)};
  if(v.pool_id)d.spec.template.metadata.annotations={'ministation.io/pool-id':v.pool_id};
  c.command=['vllm'];c.args=['serve',v.model_path,'--served-model-name',v.served_model,'--host','0.0.0.0','--port','8000','--tensor-parallel-size',String(v.gpus_per_node),'--max-model-len',String(p.max_model_len),'--max-num-seqs',String(p.max_num_seqs),'--max-num-batched-tokens',String(role==='prefill'?p.prefill_batch:p.decode_batch),'--gpu-memory-utilization',String(p.gpu_memory_utilization),'--enable-chunked-prefill','--kv-transfer-config',JSON.stringify({kv_connector:'NixlConnector',kv_role:role==='prefill'?'kv_producer':'kv_consumer',kv_load_failure_policy:'fail'})];
  c.env=[...offlineEnvironment(),...['VLLM_HOST_IP','VLLM_NIXL_SIDE_CHANNEL_HOST'].map(name=>({name,valueFrom:{fieldRef:{apiVersion:'v1',fieldPath:'status.podIP'}}})),{name:'VLLM_NIXL_SIDE_CHANNEL_PORT',value:'5600'}];
  Object.assign(c,leaderProbes());pod.volumes.push({name:'shm',emptyDir:{medium:'Memory',sizeLimit:'1Gi'}});c.volumeMounts.push({name:'shm',mountPath:'/dev/shm'});docs.push(d);
 });
 const source=readFileSync(new URL('./pd-router.mjs',import.meta.url),'utf8');
 docs.unshift({apiVersion:'v1',kind:'ConfigMap',metadata:{name:prefix+'-router',namespace},data:{'router.mjs':source}});
 const [router]=deploymentManifest({...base,image:p.router_image,cpu:0.5,memory_gib:0.5,gpus:0,model_pvc:undefined,node_selector:{...nodeSelector,'kubernetes.io/hostname':v.nodes[0]}},namespace,prefix+'-router');
 router.spec.strategy={type:'Recreate'};router.spec.template.metadata.labels={...router.spec.template.metadata.labels,...group,'ministation.io/role':'router'};
 if(v.pool_id)router.spec.template.metadata.annotations={'ministation.io/pool-id':v.pool_id};
 const pod=router.spec.template.spec;delete pod.topologySpreadConstraints;pod.terminationGracePeriodSeconds=60;pod.volumes=[{name:'router',configMap:{name:prefix+'-router'}}];
 Object.assign(pod.containers[0],{command:['node'],args:['/router/router.mjs'],volumeMounts:[{name:'router',mountPath:'/router',readOnly:true}],env:[{name:'PD_CONFIG',value:JSON.stringify({...peers,model:v.served_model,timeout_ms:p.timeout_seconds*1000,max_inflight:p.max_num_seqs})}]});
 docs.push(router,service(prefix,'router'));
 return docs.map(d=>({...d,metadata:{...d.metadata,labels:{...v.labels,...group,'app.kubernetes.io/managed-by':'ministation-distributed'}}}));
}
