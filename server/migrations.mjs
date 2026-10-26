export const schemaVersion=4;
export function checkSchema(db){const v=db.prepare('PRAGMA user_version').get().user_version;if(v>schemaVersion)throw Error('Database schema is newer than this application; use a compatible version');return v;}
export function migrate(db){
 const version=checkSchema(db);if(version===schemaVersion)return;
 db.exec('BEGIN IMMEDIATE');try{
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  if(version<3&&!db.prepare('PRAGMA table_info(api_keys)').all().some(c=>c.name==='secret'))db.exec('ALTER TABLE api_keys ADD COLUMN secret TEXT');
  if(version<4){
   for(const group of db.prepare('SELECT project_id,name FROM api_keys GROUP BY project_id,name HAVING count(*)>1').all()){
    const rows=db.prepare('SELECT id FROM api_keys WHERE project_id=? AND name=? ORDER BY created_at,id').all(group.project_id,group.name);
    const base=group.name.slice(0,60);let suffix=2;
    for(const row of rows.slice(1)){
     let candidate=`${base}-${suffix++}`;
     while(db.prepare('SELECT 1 FROM api_keys WHERE project_id=? AND name=?').get(group.project_id,candidate)){candidate=`${base}-${suffix++}`;}
     db.prepare('UPDATE api_keys SET name=? WHERE id=?').run(candidate,row.id);
    }
   }
   db.exec('CREATE UNIQUE INDEX IF NOT EXISTS api_keys_project_name ON api_keys(project_id,name)');
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(?,?)').run(3,new Date().toISOString());
  db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(?,?)').run(4,new Date().toISOString());
  db.exec('PRAGMA user_version=4; COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
