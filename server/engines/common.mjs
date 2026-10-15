// Health probes are process-level checks, not proof of GPU inference correctness.
export function leaderProbes(port=8000){return {
 startupProbe:{httpGet:{path:'/health',port},periodSeconds:10,failureThreshold:120},
 readinessProbe:{httpGet:{path:'/health',port},periodSeconds:5},
};}
export function followerProbes(address,port=8000){return {
 readinessProbe:{exec:{command:['python3','-c',`import urllib.request; urllib.request.urlopen('http://${address}:${port}/health',timeout=2).close()`]},periodSeconds:10,timeoutSeconds:3},
};}
export const offlineEnvironment=()=>[
 {name:'HF_HUB_OFFLINE',value:'1'},
 {name:'TRANSFORMERS_OFFLINE',value:'1'},
 {name:'HF_HOME',value:'/tmp/huggingface'},
];
