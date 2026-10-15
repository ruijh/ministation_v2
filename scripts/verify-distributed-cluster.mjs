// Read-only Kubernetes admission validation. Does not create workloads or claim GPU execution.
import {mkdirSync,writeFileSync} from 'node:fs';
import {configuration} from '../server/app.mjs';
import {Kubernetes} from '../server/kubernetes.mjs';
import {distributedSchema,distributedManifests} from '../server/distributed.mjs';
const kube=new Kubernetes(configuration());
try{
 const nodes=(await kube.nodes()).items;
 const selected=nodes.filter(n=>n.metadata.labels?.['kubernetes.io/hostname']===n.metadata.name).slice(0,2);
 if(selected.length<2)throw Error('Two nodes required for admission validation');
 const spec=distributedSchema.parse({name:'admission validation',image:'registry.example/sglang@sha256:'+'a'.repeat(64),nodes:selected.map(n=>n.metadata.name),gpus_per_node:1,cpu:1,memory_gib:2,model_pvc:'validation-models',model_path:'/models/model',served_model:'validation-model'});
 const engines=['sglang','vllm'];
 const manifests=engines.flatMap(engine=>distributedManifests({...spec,engine},process.env.MINISTATION_TEST_NAMESPACE||'ministation-workloads','msd-admission-'+engine));
 manifests.push(...distributedManifests(distributedSchema.parse({...spec,engine:'vllm',mode:'pd',pd:{prefill_nodes:1,router_image:'registry.example/node@sha256:'+'b'.repeat(64),max_model_len:8192,prefill_batch:4096,decode_batch:2048,max_num_seqs:32,gpu_memory_utilization:0.85}}),process.env.MINISTATION_TEST_NAMESPACE||'ministation-workloads','msd-admission-pd'));
 for(const m of manifests)await kube.dryRun(m);
 const report={at:new Date().toISOString(),admission_passed:true,engines,resource_count:manifests.length,gpu_count:nodes.reduce((n,node)=>n+Number(node.status.allocatable?.['nvidia.com/gpu']||0),0),gpu_inference_tested:false,note:'Server-side dry-run only; placeholder image and PVC are not executed or provisioned.'};
 mkdirSync('artifacts/distributed',{recursive:true});writeFileSync('artifacts/distributed/admission.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await kube.agent?.close();}
