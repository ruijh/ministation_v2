import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mkdirSync,mkdtempSync,writeFileSync,symlinkSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {runProcess} from '../server/process-runner.mjs';
import {installMaterials} from '../server/materials.mjs';
import {runEnvironmentSetup} from '../server/env-setup.mjs';
import {scanModelRoot} from '../server/model-scan.mjs';

mkdirSync('artifacts/tests',{recursive:true});
test('runner reports spawn failure, nonzero exit, and cancels an active process',async()=>{
 await assert.rejects(runProcess('missing-ministation-binary',[]),/ENOENT/);
 await assert.rejects(runProcess(process.execPath,['-e','process.exit(7)']),/7/);
 const ac=new AbortController();let pid;
 const run=runProcess(process.execPath,['-e',"console.log(process.pid);setInterval(()=>{},1000)"],text=>{pid=Number(text.trim());ac.abort();},{signal:ac.signal});
 await assert.rejects(run,{name:'AbortError'});assert.ok(pid);assert.throws(()=>process.kill(pid,0));
 const pre=new AbortController();pre.abort();assert.throws(()=>runProcess(process.execPath,[],()=>{},{signal:pre.signal}),{name:'AbortError'});
});

test('cancelled environment setup cannot execute later stages',async()=>{
 const ac=new AbortController();let later=false;
 const stages=[{id:'one',run:async(e,emit,signal)=>{assert.equal(signal,ac.signal);ac.abort();}},{id:'two',run:async()=>{later=true;}}];
 await assert.rejects(runEnvironmentSetup(['one','two'],{stages,env:{},signal:ac.signal,emit(){}}),{name:'AbortError'});assert.equal(later,false);
});

test('model scanning terminates on directory junction cycles',()=>{
 const root=mkdtempSync(resolve('artifacts/tests/cycle-')),model=join(root,'model');mkdirSync(model);
 writeFileSync(join(model,'config.json'),'{}');writeFileSync(join(model,'model.safetensors'),'weights');
 symlinkSync(model,join(model,'loop'),process.platform==='win32'?'junction':'dir');
 const models=scanModelRoot(root).models;assert.equal(models.length,1);assert.equal(models[0].size_gib,0);
});

test('download lock spans requests, cancels on disconnect, and isolates model directories',async t=>{
 const dir=mkdtempSync(resolve('artifacts/tests/download-'));const app=express();app.use(express.json());app.use((req,res,next)=>{req.project='p';next();});
 let release,started,aborted;const began=new Promise(r=>started=r);const calls=[];
 installMaterials(app,{s:{list:()=>[{name:'modelscope-dl',dir}]},get(){},write(){},audit(){},hasTool:()=>true,run:async(cmd,args,emit,{signal})=>{
  calls.push(args);started();if(calls.length===1)await new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});});
 }});
 app.use((err,req,res,next)=>res.status(err.name==='ZodError'?422:err.status||500).json({code:err.code}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{release?.();server.closeAllConnections();server.close();});
 const base='http://127.0.0.1:'+server.address().port+'/api/materials/modelscope/download';
 const post=model=>fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model})});
 const first=await post('org/model');await began;
 const busy=await post('other/model');assert.equal(busy.status,409);await busy.text();
 await first.body.cancel();for(let i=0;i<100&&!aborted;i++)await new Promise(r=>setTimeout(r,10));assert.equal(aborted,true);
 const second=await post('other/model');assert.equal(second.status,200);const text=await second.text();assert.match(text,/event: done/);
 assert.notEqual(calls[0].at(-1),calls[1].at(-1));assert.equal(calls[0].at(-1),join(dir,'org@model'));
 const invalid=await post('../escape');assert.equal(invalid.status,422);await invalid.text();
});

test('runner cancellation terminates a job child process as well',async()=>{
 const ac=new AbortController();let pids;
 const code="const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.on('spawn',()=>console.log(JSON.stringify([process.pid,child.pid])));setInterval(()=>{},1000)";
 const run=runProcess(process.execPath,['-e',code],text=>{pids=JSON.parse(text);ac.abort();},{signal:ac.signal});
 await assert.rejects(run,{name:'AbortError'});assert.equal(pids.length,2);
 for(const pid of pids)assert.throws(()=>process.kill(pid,0));
});
