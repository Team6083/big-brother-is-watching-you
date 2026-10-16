import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase,PostgresDatabase} from './database.js';

export const stateTables=['proposals','forum_recovery','task_members','task_changes','meetings','meeting_records','meeting_dates','pm_deliveries'];

// Explicit one-off migration. Neither the source file nor its data belongs in Git.
export async function importSqlite(source,db) {
  const counts={};
  for(const table of stateTables) {
    if(!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
    const targetColumns=(await db.prepare('SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?').all(table)).map(r=>r.column_name);
    const columns=source.prepare(`PRAGMA table_info(${table})`).all().map(r=>r.name).filter(name=>targetColumns.includes(name)&&/^[a-z_]+$/.test(name));
    if(!columns.length)throw new Error('import_schema_missing');
    const insert=db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')}) ON CONFLICT DO NOTHING`);
    let imported=0;
    for(const row of source.prepare(`SELECT * FROM ${table}`).all())imported+=(await insert.run(...columns.map(name=>row[name]))).changes;
    counts[table]=imported;
  }
  return counts;
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  let db,client,source;
  try {
    if(process.argv[2]!=='--source' || !process.argv[3])throw new Error('import_source_required');
    source=new DatabaseSync(process.argv[3],{readOnly:true});db=await openDatabase();client=await db.client.connect();
    await client.query('BEGIN');
    const counts=await importSqlite(source,new PostgresDatabase(client));
    await client.query('COMMIT');console.log(JSON.stringify({event:'state_imported',counts}));
  } catch {if(client)await client.query('ROLLBACK').catch(()=>{});console.error(JSON.stringify({event:'state_import_failed'}));process.exitCode=1;}
  finally {source?.close();client?.release();await db?.close();}
}
