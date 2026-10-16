import pg from 'pg';
import { readFile } from 'node:fs/promises';

// Millisecond timestamps fit safely within JS integers. Discord IDs remain TEXT.
pg.types.setTypeParser(20,value=>Number(value));

export class PostgresDatabase {
  constructor(client) {this.client=client;this.postgres=true;}
  prepare(sql) {
    let index=0;
    let text=sql.replace(/\?/g,()=>'$'+(++index));
    if(/^INSERT OR IGNORE /i.test(text))text=text.replace(/^INSERT OR IGNORE /i,'INSERT ')+(text.includes('ON CONFLICT')?'':' ON CONFLICT DO NOTHING');
    text=text.replace(/SELECT name FROM sqlite_master WHERE type='table' AND name='([a-z_]+)'/g,
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='$1'");
    const query=(values)=>this.client.query(text,values);
    return {
      get:async(...values)=>(await query(values)).rows[0],
      all:async(...values)=>(await query(values)).rows,
      run:async(...values)=>{const result=await query(values);return {changes:result.rowCount??result.affectedRows??0};},
    };
  }
  async exec(sql) {return this.client.exec?this.client.exec(sql):this.client.query(sql);}
  async close() {await this.client.end?.();}
}

export async function openDatabase(env=process.env) {
  let url;
  try {url=new URL(env.DATABASE_URL);}catch{throw new Error('invalid_DATABASE_URL');}
  if(!['postgres:','postgresql:'].includes(url.protocol))throw new Error('invalid_DATABASE_URL');
  const pool=new pg.Pool({connectionString:env.DATABASE_URL,max:4,connectionTimeoutMillis:5000,
    statement_timeout:10000,query_timeout:12000});
  pool.on('error',()=>{console.error(JSON.stringify({event:'database_connection_failed'}));process.exitCode=1;});
  try {await pool.query('SELECT 1');return new PostgresDatabase(pool);}
  catch {await pool.end();throw new Error('database_unavailable');}
}

export async function migrate(db) {
  await db.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
}

export async function acquireProcessLock(db,identity,onLost=()=>{}) {
  const client=await db.client.connect();
  client.on('error',onLost);
  try {
    const result=await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[identity]);
    if(!result.rows[0].locked)throw new Error('process_already_running');
    return async()=>{try{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[identity]);}finally{client.release();}};
  } catch(error) {client.release();throw error;}
}
