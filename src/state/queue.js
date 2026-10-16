import {randomUUID} from 'node:crypto';
import {openDatabase} from './database.js';

export class PostgresStore {
  constructor(db) {this.db=db;}
  async enqueue(id,config,now=Date.now()) {
    return (await this.db.prepare('INSERT INTO proposals(thread_id,guild_id,forum_id,received_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(id,config.guildId,config.forumId,now)).changes===1;
  }
  get(id) {return this.db.prepare('SELECT * FROM proposals WHERE thread_id=?').get(id);}
  list() {return this.db.prepare(`SELECT thread_id,status,fetch_attempts,send_attempts,last_error,notification_status,notification_error
    FROM proposals ORDER BY received_at DESC LIMIT 100`).all();}
  claim(config,now=Date.now()) {
    return this.db.prepare(`UPDATE proposals SET lease_until=?,lease_token=? WHERE thread_id=(
      SELECT thread_id FROM proposals WHERE guild_id=? AND forum_id=? AND lease_until<=? AND next_attempt_at<=?
      AND (status IN ('pending','awaiting_confirmation') OR (status='succeeded' AND notification_status='pending'))
      ORDER BY next_attempt_at,received_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`)
      .get(now+120000,randomUUID(),config.guildId,config.forumId,now,now);
  }
  async update(row,fields) {
    const allowed=new Set(['status','payload','task_snapshot','ack','fetch_attempts','send_attempts','next_attempt_at','last_error','confirmed_at','notification_status','notification_attempts','notification_message_id','notification_error']);
    const keys=Object.keys(fields);
    if(!keys.length || keys.some(key=>!allowed.has(key)))throw new Error('invalid_store_update');
    const result=await this.db.prepare(`UPDATE proposals SET ${keys.map(k=>k+'=?').join(',')} WHERE thread_id=? AND lease_token=?`)
      .run(...keys.map(k=>fields[k]),row.thread_id,row.lease_token);
    if(result.changes!==1)throw new Error('lease_lost');
    Object.assign(row,fields);
  }
  release(row) {return this.db.prepare('UPDATE proposals SET lease_until=0,lease_token=NULL WHERE thread_id=? AND lease_token=?').run(row.thread_id,row.lease_token);}
  async retry(id,notification=false,now=Date.now()) {
    const sql=notification?`UPDATE proposals SET notification_status='pending',notification_attempts=0,notification_error=NULL,next_attempt_at=0
      WHERE thread_id=? AND lease_until<=? AND status='succeeded' AND notification_status IN ('failed','skipped')`:
      `UPDATE proposals SET status=CASE WHEN payload IS NULL THEN 'pending' ELSE 'awaiting_confirmation' END,fetch_attempts=0,send_attempts=0,last_error=NULL,next_attempt_at=0
      WHERE thread_id=? AND lease_until<=? AND status='failed'`;
    return (await this.db.prepare(sql).run(id,now)).changes===1;
  }
  close() {return this.db.close();}
}
export async function openStore(env=process.env) {return new PostgresStore(await openDatabase(env));}
