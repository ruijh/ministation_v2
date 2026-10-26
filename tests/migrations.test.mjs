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
 const restored=new Store(join(root,'drill','restored'));assert.equal(restored.db.prepare('PRAGMA user_version').get().user_version,4);assert.ok(passwordMatches('test-recovery-password',restored.db.prepare('SELECT password FROM users').get().password));restored.close();
 await assert.rejects(rehearse(join(root,'source'),join(root,'drill')),/must not exist/);
});
test('v2 key table gains encrypted secret column and unique project names',()=>{
 const root=mkdtempSync('artifacts/tests/key-migration-'),db=new DatabaseSync(join(root,'ministation.db'));db.exec('CREATE TABLE api_keys(id TEXT PRIMARY KEY,project_id TEXT,name TEXT,created_at TEXT); PRAGMA user_version=2;');const insert=db.prepare('INSERT INTO api_keys VALUES(?,?,?,?)');insert.run('a','p','same-key','2026-01-01T00:00:00Z');insert.run('b','p','same-key','2026-01-02T00:00:00Z');insert.run('c','p','same-key','2026-01-03T00:00:00Z');insert.run('d','q','same-key','2026-01-04T00:00:00Z');migrate(db);assert.ok(db.prepare('PRAGMA table_info(api_keys)').all().some(c=>c.name==='secret'));assert.deepEqual(db.prepare('SELECT name FROM api_keys WHERE project_id=? ORDER BY created_at').all('p').map(r=>r.name),['same-key','same-key-2','same-key-3']);assert.equal(db.prepare('SELECT name FROM api_keys WHERE project_id=?').get('q').name,'same-key');assert.ok(db.prepare('PRAGMA index_list(api_keys)').all().some(i=>i.name==='api_keys_project_name'&&i.unique));db.close();
});
test('Future database versions are rejected without downgrade and failed migration rolls back',()=>{
 const root=mkdtempSync('artifacts/tests/future-'),store=new Store(root);store.db.exec('PRAGMA user_version=99');store.close();assert.throws(()=>new Store(root),/newer/);const db=new DatabaseSync(join(root,'ministation.db'));assert.equal(db.prepare('PRAGMA user_version').get().user_version,99);
 db.exec("PRAGMA user_version=1; DELETE FROM schema_migrations; CREATE TRIGGER block_migration BEFORE INSERT ON schema_migrations BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");assert.throws(()=>migrate(db),/fixture failure/);assert.equal(db.prepare('PRAGMA user_version').get().user_version,1);assert.equal(db.prepare('SELECT count(*) n FROM schema_migrations').get().n,0);db.close();
});
