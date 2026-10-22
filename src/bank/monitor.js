import {createHash} from 'node:crypto';
import {PermissionFlagsBits} from 'discord.js';
import {MongoBankStore} from '../state/bank.js';
import {bankConfig,readMissions,missionMessage,missionMarker} from './source.js';

export function bankDiscord(client,config) {
  async function channel() {
    const c=await client.channels.fetch(config.channelId,{force:true});
    if(c?.guildId!==config.guildId||c.type!==0||!c.permissionsFor(client.user)?.has([
      PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.ReadMessageHistory]))throw new Error('bank_channel_unavailable');
    return c;
  }
  return {verify:channel,
    send:async(row,task)=>(await channel()).send({...missionMessage(task),nonce:createHash('sha256').update(row._id).digest('hex').slice(0,24),enforceNonce:true}),
    async findSent(rows) {
      const recent=await (await channel()).messages.fetch({limit:100}),found=[];
      for(const row of rows) {
        const message=recent.find(m=>m.author.id===client.user.id&&m.embeds.some(e=>e.url===row.payload?.url&&e.footer?.text===missionMarker(row.payload)));
        if(message)found.push({row,id:message.id});
      }
      return found;
    },
  };
}

export class BankMonitor {
  constructor({state,client,env=process.env,store,discord,read=readMissions,now=Date.now,log}) {
    this.config=bankConfig(env);this.enabled=this.config.enabled;this.intervalMs=this.config.intervalMs;
    Object.assign(this,{read,now,log});this.running=false;this.stopping=false;this.abort=new AbortController();
    if(this.enabled){this.store=store||new MongoBankStore(state);this.discord=discord||bankDiscord(client,this.config);}
  }
  stop() {this.stopping=true;this.abort.abort();}
  async tick() {
    if(!this.enabled||this.running||this.stopping)return;
    this.running=true;
    try {
      const tasks=await this.read(this.config,{signal:this.abort.signal,now:this.now()});
      if(this.stopping)return;
      await this.discord.verify();
      const result=await this.store.recordSnapshot(this.config.sourceKey,tasks,this.now());
      this.log(result.initial?'bank_baseline_created':'bank_scan_completed',{queued:result.queued});
      await this.store.recover(this.config.sourceKey,this.now());
      const uncertain=await this.store.uncertain(this.config.sourceKey);
      if(uncertain.length)for(const {row,id} of await this.discord.findSent(uncertain))await this.store.sent(row,id);
      const current=new Map(tasks.map(task=>[task.id,task]));
      for(let count=0;count<5&&!this.stopping;count++) {
        const row=await this.store.claim(this.config.sourceKey,this.now());if(!row)break;
        const task=current.get(row.task_id);
        if(!task?.active){await this.store.finish(row,'ignored',{last_error:'bank_task_not_open'});continue;}
        try {
          const message=await this.discord.send(row,task);
          if(!/^\d{17,20}$/.test(message?.id||''))throw new Error('bank_send_uncertain');
          await this.store.sent(row,message.id);this.log('bank_notification_sent');
        } catch(error) {
          const limited=error.status===429||error.name==='RateLimitError';
          const state=limited?(row.attempts<5?'pending':'failed'):[400,401,403,404].includes(error.status)?'failed':'uncertain';
          await this.store.finish(row,state,{last_error:limited?'bank_rate_limited':state==='failed'?'bank_send_rejected':'bank_send_uncertain',
            next_attempt_at:this.now()+Math.min(900000,60000*2**(row.attempts-1))});
          this.log('bank_notification_failed',{code:limited?'bank_rate_limited':state==='failed'?'bank_send_rejected':'bank_send_uncertain'});
        }
      }
    } catch(error) {
      if(!this.stopping)this.log('bank_scan_failed',{code:['bank_invalid_response','bank_api_rejected','bank_api_unavailable','bank_channel_unavailable'].includes(error.message)?error.message:'bank_state_or_delivery_failed'});
    } finally {this.running=false;}
  }
}
