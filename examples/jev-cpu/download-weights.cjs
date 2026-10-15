const {spawn}=require('node:child_process');
const {mkdirSync,statSync,createReadStream,createWriteStream,renameSync,existsSync}=require('node:fs');
const {join}=require('node:path');
const {createHash}=require('node:crypto');
const {once}=require('node:events');
const root=join(__dirname,'model'),parts=join(root,'download-parts'),size=1503300328,count=192;
const expected='f47f71177f32bcd101b7573ec9171e6a57f4f4d31148d38e382306f42996874b';
const target=join(root,'model.safetensors');
async function checksum(path){const h=createHash('sha256');for await(const bytes of createReadStream(path))h.update(bytes);return h.digest('hex');}
async function main(){
 mkdirSync(parts,{recursive:true});if(existsSync(target)&&await checksum(target)===expected){console.log('Weights already verified');return;}
 const urls=Array.from({length:count},(_,i)=>{const start=Math.floor(size*i/count),end=Math.floor(size*(i+1)/count)-1;return {i,start,end,path:join(parts,String(i))};});
 let next=0;await Promise.all(Array.from({length:16},async()=>{while(next<urls.length){const part=urls[next++];
  if(existsSync(part.path)&&statSync(part.path).size===part.end-part.start+1)continue;
  await new Promise((resolve,reject)=>{const child=spawn('curl.exe',['-fLsS','--retry','4','--max-time','1800','-r',`${part.start}-${part.end}`,'https://www.modelscope.cn/models/Qwen/Qwen3-0.6B/resolve/master/model.safetensors?part='+part.i,'-o',part.path],{windowsHide:true,stdio:['ignore','ignore','inherit']});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error('Part '+part.i+' failed: '+code)));});
  if(statSync(part.path).size!==part.end-part.start+1)throw Error('Range response has wrong size: '+part.i);
  console.log('Downloaded part',part.i+1,'/',count);
 }}));
 const temp=target+'.assembled',out=createWriteStream(temp);const h=createHash('sha256');
 for(const part of urls)for await(const bytes of createReadStream(part.path)){h.update(bytes);if(!out.write(bytes))await once(out,'drain');}
 out.end();await once(out,'finish');if(h.digest('hex')!==expected)throw Error('SHA-256 mismatch');renameSync(temp,target);console.log('Complete: pinned weights SHA-256 verified');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
