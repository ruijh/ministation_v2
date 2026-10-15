export const schemaVersion=2;
export function checkSchema(db){const v=db.prepare('PRAGMA user_version').get().user_version;if(v>schemaVersion)throw Error('Database schema is newer than this application; use a compatible version');return v;}
export function migrate(db){
 const version=checkSchema(db);if(version===schemaVersion)return;
 db.exec('BEGIN IMMEDIATE');try{
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(?,?)').run(2,new Date().toISOString());
  db.exec('PRAGMA user_version=2; COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
