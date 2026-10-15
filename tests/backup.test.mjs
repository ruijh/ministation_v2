import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Store} from '../server/store.mjs';
import {createBackup,restoreBackup} from '../scripts/backup.mjs';
test('online backup restores database and encrypted credentials; tamper rejected',async()=>{mkdirSync('artifacts/tests',{recursive:true});const root=mkdtempSync(resolve('artifacts/tests/backup-'));const source=new Store(join(root,'source'));const item=source.put('backend','p','secret test',{secret:source.seal('never-print-this-value')});await createBackup(source.dir,join(root,'backup'));restoreBackup(join(root,'backup'),join(root,'restored'));const restored=new Store(join(root,'restored'));assert.equal(restored.unseal(restored.get('backend',item.id,'p').secret),'never-print-this-value');restored.close();source.close();writeFileSync(join(root,'backup','master.key'),'tampered');assert.throws(()=>restoreBackup(join(root,'backup'),join(root,'bad')),/checksum/);});
