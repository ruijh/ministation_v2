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
 const manifests=distributedManifests(spec,process.env.MINISTATION_TEST_NAMESPACE||'ministation-workloads','msd-admission');
 for(const m of manifests)await kube.dryRun(m);
 const report={at:new Date().toISOString(),admission_passed:true,resource_count:manifests.length,gpu_count:nodes.reduce((n,node)=>n+Number(node.status.allocatable?.['nvidia.com/gpu']||0),0),gpu_inference_tested:false,note:'Server-side dry-run only; placeholder image and PVC are not executed or provisioned.'};
 mkdirSync('artifacts/distributed',{recursive:true});writeFileSync('artifacts/distributed/admission.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await kube.agent?.close();}
