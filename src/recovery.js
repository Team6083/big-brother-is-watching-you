import { isTargetThread } from './proposal.js';

// Metadata scans find new posts; message contents are fetched only by the normal worker.
export async function listRecoveryThreads(rest,config,since,until) {
  const found=new Map();
  const add=t=>{
    if(!/^\d{17,20}$/.test(t.id || ''))throw new Error('recovery_invalid_response');
    const created=Number((BigInt(t.id)>>22n)+1420070400000n);
    if(created<since || created>until)return;
    const thread={id:t.id,guildId:t.guild_id || config.guildId,parentId:t.parent_id,type:t.type};
    if(isTargetThread(thread,true,config))found.set(thread.id,thread);
  };
  const active=await rest.get('/guilds/'+config.guildId+'/threads/active');
  if(!Array.isArray(active.threads))throw new Error('recovery_invalid_response');
  active.threads.forEach(add);
  let before;
  for(let page=0;page<50;page++) {
    const query=new URLSearchParams({limit:'100',...(before?{before}:{})});
    const archived=await rest.get('/channels/'+config.forumId+'/threads/archived/public',{query});
    if(!Array.isArray(archived.threads)||typeof archived.has_more!=='boolean')throw new Error('recovery_invalid_response');
    archived.threads.forEach(add);
    if(!archived.has_more)return [...found.values()];
    const cursor=archived.threads.at(-1)?.thread_metadata?.archive_timestamp;
    if(!cursor || !Number.isFinite(Date.parse(cursor)) || (before && Date.parse(cursor)>=Date.parse(before)))throw new Error('recovery_invalid_response');
    if(Date.parse(cursor)<since)return [...found.values()];
    before=cursor;
  }
  throw new Error('recovery_page_limit');
}

export class Recovery {
  constructor({store,config,scan,log,now=Date.now}) {
    Object.assign(this,{store,config,scan,log,now});this.running=false;this.lastAttempt=-Infinity;
    if(store.db.postgres){this.ready=store.db.prepare('INSERT INTO forum_recovery VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(config.guildId,config.forumId,now(),now());return;}
    store.db.exec('CREATE TABLE IF NOT EXISTS forum_recovery(guild_id TEXT NOT NULL,forum_id TEXT NOT NULL,started_at INTEGER NOT NULL,scanned_at INTEGER NOT NULL,PRIMARY KEY(guild_id,forum_id))');
    const start=now();store.db.prepare('INSERT OR IGNORE INTO forum_recovery VALUES(?,?,?,?)').run(config.guildId,config.forumId,start,start);
  }
  async tick(force=false) {
    if(this.running || (!force && this.now()-this.lastAttempt<300000))return;
    this.running=true;this.lastAttempt=this.now();
    try {
      if(this.ready)await this.ready;
      const row=(await this.store.db.prepare('SELECT * FROM forum_recovery WHERE guild_id=? AND forum_id=?').get(this.config.guildId,this.config.forumId));
      const until=this.now(),since=Math.max(row.started_at,row.scanned_at-60000);let queued=0;
      const threads=await this.scan(since,until);
      for(const thread of threads)if(isTargetThread(thread,true,this.config) && await this.store.enqueue(thread.id,this.config))queued++;
      // Advance only after all pages have been read and all candidates durably enqueued.
      (await this.store.db.prepare('UPDATE forum_recovery SET scanned_at=? WHERE guild_id=? AND forum_id=?').run(until,this.config.guildId,this.config.forumId));
      this.log('recovery_scan_completed',{queued});
    } catch {this.log('recovery_scan_failed',{code:'discord_recovery_failed'});}
    finally{this.running=false;}
  }
}
