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
    this.startedAt=now();
    if(!store.db.mongo)store.initializeRecovery(config,this.startedAt);
  }
  async tick(force=false) {
    if(this.running || (!force && this.now()-this.lastAttempt<300000))return;
    this.running=true;this.lastAttempt=this.now();
    try {
      let row=await this.store.recoveryCheckpoint(this.config);
      if(!row) {
        await this.store.initializeRecovery(this.config,this.startedAt);
        row=await this.store.recoveryCheckpoint(this.config);
      }
      const until=this.now(),since=Math.max(row.started_at,row.scanned_at-60000);let queued=0;
      const threads=await this.scan(since,until);
      for(const thread of threads)if(isTargetThread(thread,true,this.config) && await this.store.enqueue(thread.id,this.config))queued++;
      // Advance only after all pages have been read and all candidates durably enqueued.
      await this.store.advanceRecovery(this.config,until);
      this.log('recovery_scan_completed',{queued});
    } catch {this.log('recovery_scan_failed',{code:'discord_recovery_failed'});}
    finally{this.running=false;}
  }
}
