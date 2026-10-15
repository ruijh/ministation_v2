import {DatabaseSync} from 'node:sqlite';
import {resolve,join} from 'node:path';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createBackup,restoreBackup} from './backup.mjs';
import {Store} from '../server/store.mjs';
import {schemaVersion} from '../server/migrations.mjs';
export async function rehearse(source,workspace){
 source=resolve(source);workspace=resolve(workspace);if(existsSync(workspace))throw Error('Rehearsal directory must not exist');
 mkdirSync(workspace,{recursive:true,mode:0o700});const started=Date.now(),backupDir=join(workspace,'backup'),restored=join(workspace,'restored');
 await createBackup(source,backupDir);restoreBackup(backupDir,restored);
 const before=new DatabaseSync(join(backupDir,'ministation.db'),{readOnly:true});const tables=['users','objects','api_keys','usage','audit'],expected=Object.fromEntries(tables.map(table=>[table,before.prepare('SELECT count(*) n FROM '+table).get().n]));before.close();
 const store=new Store(restored);let report;
 try{
  if(store.db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Integrity check failed');
  if(store.db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Foreign key check failed');
  let credentials=0;for(const row of store.db.prepare('SELECT data FROM objects').all()){const data=JSON.parse(row.data);for(const key of ['secret','url_secret'])if(data[key]){store.unseal(data[key]);credentials++;}}
  const counts=Object.fromEntries(tables.map(table=>[table,store.db.prepare('SELECT count(*) n FROM '+table).get().n]));
  if(JSON.stringify(counts)!==JSON.stringify(expected))throw Error('Business row counts changed during migration');
  report={at:new Date().toISOString(),passed:true,schema_version:schemaVersion,counts,credentials_decrypted:credentials,elapsed_ms:Date.now()-started,scope:'Isolated backup/restore and schema migration; no Kubernetes, provider calls or production failover'};
 }finally{store.close();}
 writeFileSync(join(workspace,'report.json'),JSON.stringify(report,null,2));return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){if(!process.argv[2]||!process.argv[3])throw Error('Usage: node scripts/rehearse-recovery.mjs <source-data> <new-rehearsal-directory>');console.log(JSON.stringify(await rehearse(process.argv[2],process.argv[3]),null,2));}
