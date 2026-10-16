import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mappedDiscordOwners } from '../tasks/store.js';
import {openDatabase} from '../state/database.js';
import { isBoundTeamTask } from '../tasks/scope.js';

// Pending deliveries survive restart. Ambiguous sends need manual review, not replay.
export async function notifyThreads(report, config, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!/^\d{17,20}$/.test(config.guildId || '') || !/^\d{17,20}$/.test(config.forumId || '') || !config.token) {
    throw new Error('pm_missing_discord_config');
  }
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = new DatabaseSync(config.databasePath);
  db.exec(`PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS pm_deliveries (
    delivery_key TEXT PRIMARY KEY, state TEXT NOT NULL, message_id TEXT, created_at INTEGER NOT NULL
  )`);
  const results = [];
  async function request(path, options = {}) {
    return fetchImpl(`https://discord.com/api/v10${path}`, {
      ...options, redirect:'error', signal:AbortSignal.timeout(15000),
      headers: { Authorization:`Bot ${config.token}`, 'content-type':'application/json' },
    });
  }
  try {
    for (const task of report.tasks.filter(t => t.warnings.length)) {
      if (!task.discord_thread_id) { results.push({card_id:task.task_id,status:'no_thread'}); continue; }
      const day = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
      const owners = task.discord_owner_ids?.length ? task.discord_owner_ids : db.postgres ? (await Promise.all((task.owner||[]).map(o=>db.prepare('SELECT discord_id FROM task_members WHERE guild_id=? AND trello_id=?').all(config.guildId,o.id)))).flat().map(r=>r.discord_id) : mappedDiscordOwners(db,config.guildId,(task.owner || []).map(owner=>owner.id));
      // Deadline keys ignore day, title and owner changes: each deadline gets at most three reminders.
      const identity = task.deadline_phase
        ? JSON.stringify(['deadline_v1',config.guildId,config.forumId,task.task_id,task.discord_thread_id,new Date(task.due_date).toISOString(),task.deadline_phase])
        : `${task.task_id}:${task.discord_thread_id}:${day}:${task.warnings.join('|')}${owners.length?':'+owners.slice().sort().join(','):''}`;
      const key = createHash('sha256').update(identity).digest('hex');
      const prior = await db.prepare('SELECT state FROM pm_deliveries WHERE delivery_key=?').get(key);
      if (prior) { results.push({card_id:task.task_id,status:prior.state}); continue; }
      let channel;
      try {
        const response = await request(`/channels/${task.discord_thread_id}`);
        if (!response.ok) { await response.body?.cancel(); results.push({card_id:task.task_id,status:'thread_unavailable'}); continue; }
        channel = await response.json();
      } catch { results.push({card_id:task.task_id,status:'thread_unavailable'}); continue; }
      if (channel.guild_id !== config.guildId || (channel.parent_id !== config.forumId && !await isBoundTeamTask(db,config.guildId,channel.parent_id,task.discord_thread_id,task.task_id)) || channel.type !== 11 || channel.thread_metadata?.archived || channel.thread_metadata?.locked) {
        results.push({card_id:task.task_id,status:'outside_forum_or_archived'}); continue;
      }
      if (!(await db.prepare("INSERT OR IGNORE INTO pm_deliveries(delivery_key,state,created_at) VALUES(?,'pending',?)").run(key,now)).changes) continue;
      const title = String(task.title).replace(/[\r\n@`<>]/g,' ').slice(0,150);
      const content = `【Project Manager】\n${owners.map(id=>`<@${id}>`).join(' ')}\n「${title}」：${task.warnings.join('、')}。\n請在原討論串輸入 /任務 →「更新狀態」；若遇到問題，請在討論串中討論。\n資料截至 ${report.fetched_at}。任務分配與日期調整由授權成員明確操作。`;
      try {
        const response = await request(`/channels/${task.discord_thread_id}/messages`, {
          method:'POST', body:JSON.stringify({content,allowed_mentions:{parse:[],...(owners.length?{users:owners}:{})},nonce:key.slice(0,24),enforce_nonce:true}),
        });
        if (!response.ok) { await response.body?.cancel(); results.push({card_id:task.task_id,status:'pending_review'}); continue; }
        const message = await response.json();
        if (!/^\d{17,20}$/.test(message.id || '')) throw new Error('pm_unconfirmed_notification');
        await db.prepare("UPDATE pm_deliveries SET state='sent',message_id=? WHERE delivery_key=?").run(message.id,key);
        results.push({card_id:task.task_id,status:'sent'});
      } catch { results.push({card_id:task.task_id,status:'pending_review'}); }
    }
    return results;
  } finally { await db.close(); }
}
