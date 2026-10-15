import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {Agent,fetch} from 'undici';
const root=dirname(fileURLToPath(import.meta.url));
const agent=new Agent({connect:{ca:readFileSync(join(root,'credentials/ca.crt'))}});
const token=readFileSync(join(root,'credentials/controller.token'),'utf8').trim();
async function request(path){const res=await fetch('https://127.0.0.1:16443'+path,{dispatcher:agent,headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});return {status:res.status,data:await res.json()};}
try {
 const nodes=await request('/api/v1/nodes');
 if(nodes.status!==200||nodes.data.items.length!==3||nodes.data.items.some(n=>!n.status.conditions.some(c=>c.type==='Ready'&&c.status==='True')))throw Error('Windows API connectivity or node readiness failed');
 const quota=await request('/api/v1/namespaces/ministation-workloads/resourcequotas');
 if(quota.status!==200||!quota.data.items.length)throw Error('Namespace quota missing');
 const secret=await request('/api/v1/namespaces/ministation-workloads/secrets');
 if(secret.status!==403)throw Error('Expected Secret access to be denied');
 const other=await request('/api/v1/namespaces/kube-system/pods');
 if(other.status!==403)throw Error('Expected other namespace access to be denied');
 const report={at:new Date().toISOString(),passed:true,api:'https://127.0.0.1:16443',nodes:nodes.data.items.map(n=>n.metadata.name),quota:true,secretAccessDenied:true,otherNamespaceAccessDenied:true};
 writeFileSync(join(root,'windows-validation.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
} finally {await agent.close();}
