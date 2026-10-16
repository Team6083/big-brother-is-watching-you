export const teamChannelIds=(process.env.TASK_ALLOWED_CHANNEL_IDS||'').split(',').map(v=>v.trim()).filter(Boolean);

export function isTaskThread(thread,config) {
  return thread?.guildId===config.guildId && thread.type===11 && !thread.archived && !thread.locked &&
    (thread.parentId===config.forumId || teamChannelIds.includes(thread.parentId));
}

export async function isBoundTeamTask(db,guild,parent,thread,card) {
  if(!teamChannelIds.includes(parent) || !(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proposals'").get()))return false;
  const row=(await db.prepare("SELECT ack FROM proposals WHERE thread_id=? AND guild_id=? AND forum_id=? AND status='succeeded'").get(thread,guild,parent));
  try{return JSON.parse(row?.ack).trello_card_id===card;}catch{return false;}
}
