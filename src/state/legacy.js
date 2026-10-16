// SQLite is retained solely for the existing regression tests in phase one.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {mappedDiscordOwners} from '../tasks/store.js';

export class LegacyDeliveryStore {
  constructor(path) {
    mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;CREATE TABLE IF NOT EXISTS pm_deliveries (
      delivery_key TEXT PRIMARY KEY,state TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL
    )`);
  }
  get(key) {return this.db.prepare('SELECT state FROM pm_deliveries WHERE delivery_key=?').get(key);}
  claim(key,now) {return this.db.prepare("INSERT OR IGNORE INTO pm_deliveries VALUES(?,'pending',NULL,?)").run(key,now).changes===1;}
  complete(key,id) {this.db.prepare("UPDATE pm_deliveries SET state='sent',message_id=? WHERE delivery_key=?").run(id,key);}
  owners(guild,ids) {return mappedDiscordOwners(this.db,guild,ids);}
  isBoundTask(guild,parent,thread,card) {
    if(!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'").get())return false;
    const row=this.db.prepare("SELECT ack FROM proposals WHERE thread_id=? AND guild_id=? AND forum_id=? AND status='succeeded'").get(thread,guild,parent);
    try {return JSON.parse(row?.ack).trello_card_id===card;}catch{return false;}
  }
  close() {this.db.close();}
}
