import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamCompletion} from '../server/stream-completion.mjs';
test('MiniMax EOF requires all choices finished and explicit successful usage',()=>{
 const s=new StreamCompletion();s.observe({choices:[{index:0,delta:{content:'OK'}}]});assert.equal(s.canNormalize(),false);
 s.observe({choices:[{index:0,finish_reason:'stop'}]});assert.equal(s.canNormalize(),false);
 s.observe({usage:{prompt_tokens:1,completion_tokens:1}});assert.equal(s.canNormalize(),false);
 s.observe({base_resp:{status_code:0},usage:{prompt_tokens:1,completion_tokens:1}});assert.equal(s.canNormalize(),true);
 s.observe({choices:[{index:1,delta:{content:'partial'}}]});assert.equal(s.canNormalize(),false);
 s.observe({choices:[{index:1,finish_reason:'length'}]});assert.equal(s.canNormalize(),true);
 s.observe({base_resp:{status_code:1000},usage:{prompt_tokens:1,completion_tokens:1}});assert.equal(s.canNormalize(),false);
});
