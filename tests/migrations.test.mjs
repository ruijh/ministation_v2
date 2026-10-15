import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Store,passwordHash,passwordMatches} from '../server/store.mjs';
import {migrate} from '../server/migrations.mjs';
import {rehearse} from '../scripts/rehearse-recovery.mjs';
test('Recovery rehearsal migrates v1 in isolation and retains users and encrypted credentials',async()=>{
 mkdirSync('artifacts/tests',{recursive:true});const root=mkdtempSync('artifacts/tests/rehearsal-'),source=new Store(join(root,'source'));
 source.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run('u','rehearsal',passwordHash('test-recovery-password'),'admin','p',new Date().toISOString());source.put('backend','p','secret',{secret:source.seal('fixture-secret')});source.db.exec('DROP TABLE schema_migrations; PRAGMA user_version=1');
 const report=await rehearse(source.dir,join(root,'drill'));assert.equal(report.passed,true);assert.equal(report.credentials_decrypted,1);assert.equal(report.counts.users,1);assert.equal(source.db.prepare('PRAGMA user_version').get().user_version,1);source.close();
 const restored=new Store(join(root,'drill','restored'));assert.equal(restored.db.prepare('PRAGMA user_version').get().user_version,2);assert.ok(passwordMatches('test-recovery-password',restored.db.prepare('SELECT password FROM users').get().password));restored.close();
 await assert.rejects(rehearse(join(root,'source'),join(root,'drill')),/must not exist/);
});
test('Future database versions are rejected without downgrade and failed migration rolls back',()=>{
 const root=mkdtempSync('artifacts/tests/future-'),store=new Store(root);store.db.exec('PRAGMA user_version=99');store.close();assert.throws(()=>new Store(root),/newer/);const db=new DatabaseSync(join(root,'ministation.db'));assert.equal(db.prepare('PRAGMA user_version').get().user_version,99);
 db.exec("PRAGMA user_version=1; DELETE FROM schema_migrations; CREATE TRIGGER block_migration BEFORE INSERT ON schema_migrations BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");assert.throws(()=>migrate(db),/fixture failure/);assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations').get().n,0);db.close();
});
