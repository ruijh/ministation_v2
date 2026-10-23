import {openSync,closeSync,fstatSync,readSync} from 'node:fs';

// Read a bounded byte window, never the entire engine log into memory.
export function readLogTail(path,{offset=0,maxBytes=256*1024,lines=100}={}){
 let fd;
 try{
  fd=openSync(path,'r');const size=fstatSync(fd).size;
  const start=Math.max(Math.min(offset,size),size-maxBytes,0);
  const buffer=Buffer.alloc(size-start);const bytes=readSync(fd,buffer,0,buffer.length,start);
  let text=buffer.subarray(0,bytes).toString('utf8');
  if(start>offset){const newline=text.indexOf('\n');text=newline<0?'':text.slice(newline+1);}
  const all=text.split(/\r?\n/).filter(Boolean);
  return {text,lines:all.slice(-lines),size,bytes_read:bytes,truncated:start>offset||all.length>lines,available:true};
 }catch(error){return {text:'',lines:[],size:0,bytes_read:0,truncated:false,available:false,error:error.code||'READ_FAILED'};}
 finally{if(fd!==undefined)closeSync(fd);}
}

export function localLogFindings(lines){
 const rules=[
  ['GPU_OOM',/CUDA out of memory|torch\.OutOfMemoryError|out of memory.*(?:cuda|gpu)/i,'GPU 显存不足','降低上下文长度、并发或模型显存占用，核对可用 GPU。'],
  ['HOST_MEMORY',/cannot allocate memory|not enough memory|std::bad_alloc/i,'主机内存分配失败','检查主机/容器内存限额与峰值，不要直接认定为显存不足。'],
  ['DISK_FULL',/no space left on device/i,'磁盘空间不足','检查模型、缓存及日志所在文件系统的空间。'],
  ['PORT_IN_USE',/address already in use|EADDRINUSE/i,'监听端口已占用','确认端口使用者，选择空闲端口后重试。'],
  ['PERMISSION',/permission denied|EACCES/i,'文件或执行权限不足','检查模型目录、缓存和引擎文件的访问权限。'],
  ['DEPENDENCY',/ModuleNotFoundError|No module named|error while loading shared libraries/i,'引擎依赖缺失','使用启动命令对应的环境检查依赖和动态库。'],
  ['SPAWN_FAILED',/spawn .* ENOENT|ENOEXEC/i,'引擎无法启动','检查引擎可执行文件路径和文件格式。'],
  ['ENGINE_ERROR',/\b(?:RuntimeError|ValueError|ImportError|TypeError|AssertionError|Error|Exception|FATAL)\b/i,'引擎报告异常','结合本次启动日志、退出码和健康检查定位原因。'],
 ];
 const findings=[],seen=new Set();
 for(const raw of lines){
  const evidence=String(raw).replace(/\x1b\[[0-9;]*m/g,'').trim();
  if(!evidence)continue;
  const rule=rules.find(([,pattern])=>pattern.test(evidence));
  if(!rule||seen.has(rule[0]))continue;
  seen.add(rule[0]);findings.push({code:rule[0],title:rule[2],evidence:evidence.slice(0,1000),action:rule[3]});
 }
 return findings;
}
