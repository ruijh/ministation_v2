import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
const cases=JSON.parse(readFileSync('examples/jev-cpu/eval-cases.json','utf8'));
const base=process.env.DECISION_EVAL_URL||'http://127.0.0.1:8801/api/decide';
const samples=[];let index=0;
for(const [expected,texts] of Object.entries(cases.cases))for(const state of texts){
 const start=performance.now();
 const response=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state,criteria:[{id:'route',question:cases.question,options:cases.options}]}),signal:AbortSignal.timeout(120000)});
 const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));const result=data.results[0];
 samples.push({state,expected,predicted:result.winner,correct:result.winner===expected,latency_ms:performance.now()-start,input_tokens:result.input_tokens,probabilities:result.ranked});
 console.log(`${++index}/100 ${expected} -> ${result.winner} ${samples.at(-1).latency_ms.toFixed(0)}ms`);
}
const latency=samples.map(s=>s.latency_ms).sort((a,b)=>a-b),correct=samples.filter(s=>s.correct).length;
const report={endpoint:base,environment:{concurrency:1,cpu_threads:2,dtype:'float32',notes:process.env.DECISION_EVAL_NOTES||'CPU run; see deployment validation for resources'},at:new Date().toISOString(),description:cases.description,model:JSON.parse(readFileSync('examples/jev-cpu/provenance.json','utf8')),samples:samples.length,correct,accuracy:correct/samples.length,p50_ms:latency[Math.ceil(latency.length*0.5)-1],p95_ms:latency[Math.ceil(latency.length*0.95)-1],by_class:Object.fromEntries(Object.keys(cases.cases).map(label=>[label,{total:samples.filter(s=>s.expected===label).length,correct:samples.filter(s=>s.expected===label&&s.correct).length}])),results:samples};
mkdirSync('artifacts/jev-cpu',{recursive:true});writeFileSync(process.env.DECISION_EVAL_OUTPUT||'artifacts/jev-cpu/evaluation.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,results:undefined},null,2));
