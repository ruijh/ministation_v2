import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouteTargetState} from '../server/catalog-state.mjs';

test('route target state reflects stopped local engines and failed deployments',()=>{
 const objects=new Map();
 const store={get:(kind,oid)=>objects.get(kind+':'+oid)};
 const local={get:()=>({status:'Stopped'})};
 const routeTargetState=createRouteTargetState(store,local);

 objects.set('backend:local',{status:'EndpointValidated',local_id:'local'});
 assert.deepEqual(routeTargetState({project_id:'project',target_kind:'backend',target_id:'local'}),{state:'NotStarted',reason:'本机引擎未运行'});

 objects.set('deployment:failed',{status:'Failed',reason:'image pull failed'});
 objects.set('backend:failed',{status:'EndpointValidated',deployment_id:'failed'});
 assert.deepEqual(routeTargetState({project_id:'project',target_kind:'backend',target_id:'failed'}),{state:'Failed',reason:'image pull failed'});
});

test('route target state does not query missing runtime references',()=>{
 const store={get(kind){if(kind!=='backend')throw new Error('unexpected query');return {status:'EndpointValidated'}}};
 const routeTargetState=createRouteTargetState(store,null);
 assert.deepEqual(routeTargetState({project_id:'project',target_kind:'backend',target_id:'external'}),{state:'Ready'});
});

test('route target state reports the least healthy backend in a flow',()=>{
 const store={get:(kind,oid)=>({flow:{graph},backend:oid==='good'?{status:'EndpointValidated'}:{status:'EndpointValidated',deployment_id:'loading'},deployment:{status:'Loading',conditions:{}}})[kind]};
 const routeTargetState=createRouteTargetState(store,{get:()=>({status:'Running'})});
 const graph={id:'root',type:'serial',children:[{id:'good',type:'service',backend_id:'good'},{id:'loading',type:'service',backend_id:'loading'}]};
 assert.deepEqual(routeTargetState({project_id:'project',target_kind:'flow',target_id:'flow',graph}),{state:'Starting',reason:'目标部署尚未就绪'});
});
