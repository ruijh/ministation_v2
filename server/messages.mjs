import {fail} from './domain.mjs';

// Chat clients can encode plain text as a string or typed content parts.
// Normalize text before routing, composition and token reservation.
export function normalizeTextMessages(messages){
 if(!Array.isArray(messages)||!messages.length)fail(422,'UNSUPPORTED_MESSAGES','messages 必须是非空消息数组');
 return messages.map(message=>{
  if(!message||typeof message!=='object'||Array.isArray(message))fail(422,'UNSUPPORTED_MESSAGES','消息必须是对象');
  if(typeof message.content==='string')return {...message};
  if(Array.isArray(message.content)&&message.content.every(part=>part&&part.type==='text'&&typeof part.text==='string'))return {...message,content:message.content.map(part=>part.text).join('')};
  fail(422,'UNSUPPORTED_MESSAGES','当前支持文本字符串或 text 内容数组，暂不支持图片、音频及非文本消息');
 });
}
