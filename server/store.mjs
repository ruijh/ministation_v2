import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID,createHash,scryptSync,timingSafeEqual,createCipheriv,createDecipheriv} from 'node:crypto';
export const now=()=>new Date().toISOString();
export const id=()=>randomUUID();
export const hash=s=>createHash('sha256').update(s).digest('hex');
export function passwordHash(p){const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(p,salt,64).toString('hex')}`;}
export function passwordMatches(p,h){try{const[s,v]=h.split(':');return timingSafeEqual(Buffer.from(v,'hex'),scryptSync(p,s,64));}catch{return false;}}
export class Store{
 constructor(dir){this.dir=resolve(dir);mkdirSync(this.dir,{recursive:true});const key=join(this.dir,'master.key');if(!existsSync(key)&&existsSync(join(this.dir,'ministation.db')))throw new Error('Existing database has no master.key; restore the matching key before startup');if(!existsSync(key))writeFileSync(key,randomBytes(32),{mode:0o600,flag:'wx'});this.key=readFileSync(key);this.db=new DatabaseSync(join(this.dir,'ministation.db'));this.db.exec(`
 PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE,password TEXT,role TEXT,project_id TEXT,created_at TEXT);
 CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,expires INTEGER);
 CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY,kind TEXT,project_id TEXT,name TEXT,data TEXT,version INTEGER DEFAULT 1,created_at TEXT,updated_at TEXT,UNIQUE(kind,project_id,name));
 CREATE INDEX IF NOT EXISTS objects_scope ON objects(kind,project_id);
 CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,project_id TEXT,name TEXT,hash TEXT UNIQUE,prefix TEXT,models TEXT,expires TEXT,rpm INTEGER,tpm INTEGER,budget INTEGER,used INTEGER DEFAULT 0,reserved INTEGER DEFAULT 0,revoked INTEGER DEFAULT 0,created_at TEXT);
 CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,project_id TEXT,key_id TEXT,model TEXT,target_id TEXT,parent_id TEXT,status TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,cost_micros INTEGER,rate_version TEXT,source TEXT,latency_ms REAL,ttft_ms REAL,error_code TEXT,created_at TEXT);
 CREATE INDEX IF NOT EXISTS usage_scope ON usage(project_id,created_at);
 CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY,key_id TEXT,project_id TEXT,amount INTEGER,status TEXT,created INTEGER);
 CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,project_id TEXT,actor TEXT,action TEXT,target TEXT,details TEXT,created_at TEXT);
 CREATE TABLE IF NOT EXISTS idempotency(scope TEXT,key TEXT,digest TEXT,result TEXT,created INTEGER,PRIMARY KEY(scope,key));
 PRAGMA user_version=1;
 `);this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 seal(v){if(!v)return null;const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);const out=Buffer.concat([c.update(v,'utf8'),c.final()]);return [iv,c.getAuthTag(),out].map(b=>b.toString('base64')).join('.');}
 unseal(v){if(!v)return '';const [iv,tag,b]=v.split('.').map(x=>Buffer.from(x,'base64'));const c=createDecipheriv('aes-256-gcm',this.key,iv);c.setAuthTag(tag);return Buffer.concat([c.update(b),c.final()]).toString();}
 decode(r){return r?{...JSON.parse(r.data),id:r.id,name:r.name,project_id:r.project_id,version:r.version,created_at:r.created_at,updated_at:r.updated_at}:null;}
 get(kind,oid,project){const r=this.db.prepare('SELECT * FROM objects WHERE kind=? AND id=?').get(kind,oid);return r&&(!project||r.project_id===project)?this.decode(r):null;}
 list(kind,project){return this.db.prepare('SELECT * FROM objects WHERE kind=? AND project_id=? ORDER BY created_at DESC').all(kind,project).map(r=>this.decode(r));}
 put(kind,project,name,data,oid=id()){const t=now();this.db.prepare('INSERT INTO objects(id,kind,project_id,name,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(oid,kind,project,name,JSON.stringify(data),t,t);return this.get(kind,oid,project);}
 update(kind,oid,project,data,expected){const old=this.get(kind,oid,project);if(!old)throw Object.assign(new Error('对象不存在'),{status:404,code:'NOT_FOUND'});if(expected!==undefined&&old.version!==expected)throw Object.assign(new Error('配置已被更新，请刷新后重试'),{status:409,code:'VERSION_CONFLICT'});this.db.prepare('UPDATE objects SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify({...old,...data}),now(),oid);return this.get(kind,oid,project);}
 remove(kind,oid,project){this.db.prepare('DELETE FROM objects WHERE kind=? AND id=? AND project_id=?').run(kind,oid,project);}
 audit(project,actor,action,target,details={}){this.db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?)').run(id(),project,actor,action,target,JSON.stringify(details),now());}
 recover(){this.tx(()=>{this.db.prepare("UPDATE usage SET status='pending',error_code='PROCESS_RESTARTED' WHERE status='in_progress' AND parent_id IS NULL").run();this.db.prepare("UPDATE reservations SET status='uncertain' WHERE status='active'").run();for(const row of this.db.prepare("SELECT * FROM objects WHERE kind IN ('operation','deployment')").all()){const v=JSON.parse(row.data);if(row.kind==='operation'&&v.status==='Running')this.update('operation',row.id,row.project_id,{status:'Interrupted',error:'控制面重启中断操作，后台将核对实际资源；不会自动重放写操作'});if(row.kind==='deployment'&&['Scheduling','Updating'].includes(v.status))this.update('deployment',row.id,row.project_id,{status:'Reconciling',reason:'控制面重启，正在核对实际状态；请检查中断任务'});}});}
 close(){this.db.close();}
}
