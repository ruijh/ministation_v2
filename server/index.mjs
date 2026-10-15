import {createApp} from './app.mjs';
const port=Number(process.env.PORT||8787),host=process.env.HOST||'127.0.0.1';
if(!['127.0.0.1','localhost'].includes(host)&&!process.env.MINISTATION_BOOTSTRAP_TOKEN){throw new Error('绑定非回环地址需要设置MINISTATION_BOOTSTRAP_TOKEN');}
const {app,store,observer,runtime}=createApp({dataDir:process.env.MINISTATION_DATA_DIR||'data'});
store.recover();
observer.start();
runtime.start();
const server=app.listen(port,host,()=>console.log(`MiniStation: http://${host}:${port}`));
function stop(){server.close(async()=>{await runtime.stop();await observer.stop();store.close();process.exit(0);});setTimeout(()=>process.exit(1),5000).unref();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
