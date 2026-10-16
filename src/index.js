import { Recovery, listRecoveryThreads } from './recovery.js';
import { Events } from 'discord.js';
import { loadConfig } from './config.js';
import { openStore } from './state/queue.js';
import { acquireProcessLock } from './state/database.js';
import { serveHealth } from './health.js';
import { createClient, createDiscordAdapter, registerEvents } from './discord.js';
import { sendProposal } from './webhook.js';
import { Worker } from './worker.js';
import { log } from './log.js';
import { registerTaskInteractions } from './tasks/interactions.js';
import { registerMeetings } from './meetings.js';

let client, store, timer, heartbeat, worker, taskInteractions, recovery, recoveryTimer, meetings, meetingTimer, unlock, health, stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  clearInterval(heartbeat);
  clearInterval(recoveryTimer);
  clearInterval(meetingTimer);
  client?.removeAllListeners(Events.InteractionCreate);
  client?.removeAllListeners(Events.ThreadCreate);
  const deadline = setTimeout(() => process.exit(1), 25_000);
  deadline.unref();
  while (worker?.running || taskInteractions?.running || recovery?.running || meetings?.running) await new Promise(resolve => setTimeout(resolve, 100));
  await client?.destroy();
  await health?.close();
  try {await unlock?.();}catch {log('shutdown_unlock_failed');}
  await store?.close();
  clearTimeout(deadline);
  process.exitCode = code;
}

process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
process.on('unhandledRejection', () => { log('fatal_error', { code: 'unhandled_rejection' }); void shutdown(1); });
process.on('uncaughtException', () => { log('fatal_error', { code: 'uncaught_exception' }); process.exit(1); });

try {
  const config = loadConfig();
  store = await openStore();
  unlock=await acquireProcessLock(store.db,'bot:'+config.guildId,()=>{void shutdown(1);});
  await store.db.prepare("UPDATE meetings SET status='uncertain' WHERE channel_id=? AND status='sending'").run(config.meetingChannelId);
  client = createClient();
  health=await serveHealth({ready:()=>!stopping&&client.isReady(),alive:()=>!stopping});
  const discord = createDiscordAdapter(client, config);
  worker = new Worker({ store, config, discord, send: proposal => sendProposal(proposal, config), log });
  registerEvents(client, store, config, log);
  recovery=new Recovery({store,config,scan:(since,until)=>listRecoveryThreads(client.rest,config,since,until),log});
  taskInteractions = registerTaskInteractions(client, store, config, log);
  meetings = registerMeetings(client, store, config, log);
  client.on(Events.Error, () => { log('discord_error', { code: 'discord_client_error' }); void shutdown(1); });
  client.on(Events.ShardError, () => log('discord_connection_error', { code: 'gateway_transport_error' }));
  client.on(Events.ShardDisconnect, () => log('discord_disconnected'));
  client.on(Events.ShardResume, () => {log('discord_resumed');if(!stopping && client.isReady())void recovery.tick(true);});
  client.on(Events.ShardReady,()=>{if(!stopping && client.isReady())void recovery.tick(true);});
  client.once(Events.ClientReady, async () => {
    try {
      await discord.verify();
      if (stopping) return;
      const tick = () => {
        if (stopping || !client.isReady()) return;
        worker.tick().catch(() => { log('worker_error', { code: 'worker_or_database_failed' }); void shutdown(1); });
      };
      timer = setInterval(tick, 1_000);
      heartbeat = setInterval(() => log('heartbeat', { status: client.isReady() ? 'connected' : 'disconnected' }), 60_000);
      recoveryTimer=setInterval(()=>{if(!stopping && client.isReady())void recovery.tick();},60000);
      const meetingTick=()=>{if(!stopping && client.isReady())meetings.tick().catch(()=>log('meeting_reminder_failed',{code:'meeting_database_failed'}));};
      meetingTimer=setInterval(meetingTick,60000);
      meetingTick();
      void recovery.tick(true);
      log('bot_ready');
      tick();
    } catch { log('startup_failed', { code: 'forum_or_permission_check_failed' }); await shutdown(1); }
  });
  await client.login(config.token);
} catch {
  log('startup_failed', { code: 'configuration_database_or_login_failed' });
  await shutdown(1);
}
