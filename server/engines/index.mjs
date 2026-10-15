import {fail} from '../domain.mjs';
import {sglang} from './sglang.mjs';
import {vllm} from './vllm.mjs';
const adapters=new Map([sglang,vllm].map(adapter=>[adapter.info.id,adapter]));
export const distributedEngineIds=[...adapters.keys()];
export const distributedEngineCatalog=()=>[...adapters.values()].map(a=>({...a.info}));
export function distributedEngine(engine='sglang'){
 const adapter=adapters.get(engine);
 if(!adapter)fail(422,'UNSUPPORTED_ENGINE','不支持的分布式推理引擎',{supported:distributedEngineIds});
 return adapter;
}
