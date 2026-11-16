import {MongoTasks} from '../tasks/database.js';
import {analyze} from './report.js';
import {notifyThreads} from './notify.js';
import {MongoTaskStore} from '../state/tasks.js';

export async function collectReport(state,env=process.env,{read,progress=()=>new MongoTaskStore(state).progressActionIds()}={}) {
  const snapshot=await (read?read():new MongoTasks(state,{guildId:env.DISCORD_GUILD_ID,forumId:env.DISCORD_FORUM_CHANNEL_ID}).snapshot());
  return analyze(snapshot,{trustedProgressActions:await progress()});
}

export class PmMonitor {
  constructor({state,env=process.env,read,notify=notifyThreads,progress,log}) {
    Object.assign(this,{state,env,read,notify,progress,log});this.running=false;this.stopping=false;
    if(env.PM_ENABLED&&!['true','false'].includes(env.PM_ENABLED))throw new Error('pm_invalid_enabled');
    this.enabled=env.PM_ENABLED==='true';
    this.intervalMs=Number(env.PM_INTERVAL_MS||60000);
    if(!Number.isSafeInteger(this.intervalMs)||this.intervalMs<60000||this.intervalMs>86400000)throw new Error('pm_invalid_interval');
  }
  stop() {this.stopping=true;}
  async tick() {
    if(!this.enabled || this.stopping || this.running)return;
    this.running=true;
    try {
      const report=await collectReport(this.state,this.env,{read:this.read,progress:this.progress});
      const results=await this.notify(report,{guildId:this.env.DISCORD_GUILD_ID,forumId:this.env.DISCORD_FORUM_CHANNEL_ID,token:this.env.DISCORD_BOT_TOKEN},{state:this.state});
      this.log('pm_scan_completed',{queued:results.filter(r=>r.status==='sent').length});
    } catch {this.log('pm_scan_failed',{code:'pm_read_or_notification_failed'});}
    finally {this.running=false;}
  }
}
