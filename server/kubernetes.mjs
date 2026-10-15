import {readFileSync} from 'node:fs';
import {Agent,fetch} from 'undici';
import {fail,resourcePaths} from './domain.mjs';
export class Kubernetes{
 constructor(config){this.config=config;this.enabled=Boolean(config.kubeUrl);if(this.enabled){if(!config.kubeUrl.startsWith('https://'))throw new Error('Kubernetes API requires HTTPS');this.agent=new Agent({connect:{ca:config.kubeCa?readFileSync(config.kubeCa):undefined}});}}
 async request(path,method='GET',body){if(!this.enabled)fail(503,'CLUSTER_NOT_CONFIGURED','尚未接入集群；请配置Kubernetes API与受限ServiceAccount凭据');const token=readFileSync(this.config.kubeTokenFile,'utf8').trim();const res=await fetch(this.config.kubeUrl.replace(/\/$/,'')+path,{method,dispatcher:this.agent,signal:AbortSignal.timeout(20000),headers:{authorization:`Bearer ${token}`,'Content-Type':method==='PATCH'?'application/merge-patch+json':'application/json'},body:body?JSON.stringify(body):undefined});const data=res.headers.get('content-type')?.includes('json')?await res.json():await res.text();if(!res.ok)fail([404,409].includes(res.status)?res.status:502,'KUBERNETES_ERROR',data.message||'集群API请求失败');return data;}
 path(d){const [api,plural]=resourcePaths[d.kind];return `${api==='v1'?'/api/v1':'/apis/'+api}/namespaces/${encodeURIComponent(d.metadata.namespace)}/${plural}`;}
 async dryRun(d){return this.request(this.path(d)+'?dryRun=All','POST',d);}
 async apply(d){return this.request(this.path(d),'POST',d);}
 async replace(d,dryRun=false){const path=this.path(d)+'/'+encodeURIComponent(d.metadata.name);let generation;for(let attempt=0;attempt<4;attempt++){const old=await this.request(path);if(generation!==undefined&&old.metadata.generation!==generation)fail(409,'KUBERNETES_CONFIG_CONFLICT','集群配置已被其他操作修改，请同步后重试');generation=old.metadata.generation;const spec=d.kind==='Service'?{...old.spec,...d.spec}:d.spec;try{return await this.request(path+(dryRun?'?dryRun=All':''),'PUT',{...d,spec,metadata:{...d.metadata,resourceVersion:old.metadata.resourceVersion}});}catch(e){if(e.status!==409||attempt===3)throw e;}}}

 async nodes(){return this.request('/api/v1/nodes');}
 async assertQuota(ns){const q=await this.request(`/api/v1/namespaces/${encodeURIComponent(ns)}/resourcequotas`);if(!q.items?.some(x=>x.spec?.hard?.['requests.cpu']&&x.spec.hard['requests.memory']))fail(422,'QUOTA_REQUIRED','命名空间缺少CPU和内存ResourceQuota，拒绝创建工作负载');}
 async deployment(ns,name){return this.request(`/apis/apps/v1/namespaces/${ns}/deployments/${name}`);}
 async scale(ns,name,replicas){return this.request(`/apis/apps/v1/namespaces/${ns}/deployments/${name}/scale`,'PATCH',{spec:{replicas}});}
 async logs(ns,pod,previous=false){return this.request(`/api/v1/namespaces/${ns}/pods/${encodeURIComponent(pod)}/log?tailLines=100&previous=${previous}`);}
}
