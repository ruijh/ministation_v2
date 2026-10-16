import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendEnvironment} from '../server/environment.mjs';
const policy={max_cpu:8,max_memory_gib:32,max_gpus:4};
const quota={cpu:3,memory_gib:8,gpus:2};
const node=(name,remaining,extra={})=>({name,remaining,allocatable:{cpu:8,memory_gib:32,gpus:2},ready:true,cordoned:false,taints:[],labels:{'kubernetes.io/arch':'amd64'},...extra});
const cap=nodes=>({configured:true,allocation_available:true,nodes});
test('recommendation fits one node, project quota and policy without aggregating fragmented resources',()=>{
 const r=recommendEnvironment(cap([node('a',{cpu:2,memory_gib:8,gpus:1}),node('b',{cpu:8,memory_gib:2,gpus:2})]),policy,quota);
 assert.equal(r.recommendation.example_node,'a');assert.deepEqual(r.recommendation.resources,{cpu:2,memory_gib:8,gpus:1,tensor_parallel:1,shared_memory_gib:.5});assert.equal(r.nodes[0].hardware.gpu_model,null);assert.equal(r.pd.recommended,false);
 const restricted=recommendEnvironment(cap([node('a',{cpu:8,memory_gib:32,gpus:2})]),{...policy,max_cpu:1,max_memory_gib:4},quota);assert.equal(restricted.recommendation.resources.cpu,1);assert.equal(restricted.recommendation.resources.memory_gib,4);
 assert.equal(recommendEnvironment(cap([node('a',{cpu:0,memory_gib:16,gpus:1}),node('b',{cpu:8,memory_gib:0,gpus:1})]),policy,quota).state,'capacity_blocked');
});
test('recommendation separates unknown capacity, no GPU, quotas, pool selectors and unschedulable nodes',()=>{
 assert.equal(recommendEnvironment({configured:false,nodes:[]},policy,quota).state,'unconfigured');
 assert.equal(recommendEnvironment({configured:true,allocation_available:false,nodes:[]},policy,quota).state,'unknown');
 assert.equal(recommendEnvironment(cap([node('cpu',{cpu:8,memory_gib:32,gpus:0},{allocatable:{cpu:8,memory_gib:32,gpus:0}})]),policy,quota).state,'no_gpu');
 const n=node('gpu',{cpu:8,memory_gib:32,gpus:2});assert.equal(recommendEnvironment(cap([n]),policy,{...quota,gpus:0}).state,'quota_blocked');
 for(const extra of [{ready:false},{cordoned:true},{taints:[{effect:'NoSchedule'}]},{taints:[{effect:'NoExecute'}]}])assert.equal(recommendEnvironment(cap([{...n,...extra}]),policy,quota).recommendation,null);
 assert.equal(recommendEnvironment(cap([n]),policy,quota,{pool:'other'}).recommendation,null);
 const labels={'nvidia.com/gpu.product':'test-device','nvidia.com/gpu.memory':'24576'};assert.equal(recommendEnvironment(cap([{...n,labels}]),policy,quota).nodes[0].hardware.gpu_memory_mib,24576);
});
