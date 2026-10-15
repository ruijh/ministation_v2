import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTextMessages} from '../server/messages.mjs';

test('chat text parts preserve order, roles and source input',()=>{
 const input=[{role:'system',content:'Be helpful'},{role:'user',content:[{type:'text',text:'你好'},{type:'text',text:' world'}]},{role:'assistant',content:[]}];
 assert.deepEqual(normalizeTextMessages(input),[{role:'system',content:'Be helpful'},{role:'user',content:'你好 world'},{role:'assistant',content:''}]);
 assert.ok(Array.isArray(input[1].content));
});
test('non-text parts and malformed messages fail explicitly without dropping content',()=>{
 for(const input of [null,[],[null],[{content:null}],[{content:[{type:'text',text:42}]}],[{content:[{type:'text',text:'Look'},{type:'image_url',image_url:{url:'x'}}]}]])assert.throws(()=>normalizeTextMessages(input),e=>e.status===422&&e.code==='UNSUPPORTED_MESSAGES');
});
