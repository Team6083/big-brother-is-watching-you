export const teamChannelIds=(process.env.TASK_ALLOWED_CHANNEL_IDS||'').split(',').map(v=>v.trim()).filter(Boolean);

export function isTeamTaskChannel(channel,config) {
  return channel?.guildId===config.guildId && channel.type===0 && teamChannelIds.includes(channel.id);
}

export function isTaskThread(thread,config) {
  return thread?.guildId===config.guildId && thread.type===11 && !thread.archived && !thread.locked &&
    (thread.parentId===config.forumId || teamChannelIds.includes(thread.parentId));
}

export async function isBoundTeamTask(store,guild,parent,thread,card) {
  return teamChannelIds.includes(parent) && await store.isBoundTask(guild,parent,thread,card);
}
