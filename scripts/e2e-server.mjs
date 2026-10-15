import {createApp} from '../server/app.mjs';
import {fixture} from './fixture.mjs';
import {mkdirSync,mkdtempSync} from 'node:fs';
mkdirSync('artifacts/e2e',{recursive:true});
const mock=fixture().listen(8792,'127.0.0.1');
const {app,store}=createApp({dataDir:mkdtempSync('artifacts/e2e/run-'),upstreamHosts:['127.0.0.1']});
const server=app.listen(8791,'127.0.0.1');
process.on('SIGTERM',()=>{server.close();mock.close();store.close();process.exit(0);});
