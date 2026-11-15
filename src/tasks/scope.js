export const teamChannelIds=(process.env.TASK_ALLOWED_CHANNEL_IDS||'').split(',').map(v=>v.trim()).filter(Boolean);

export function teamChannelAccessEnabled(env=process.env) {
  if(env.TEAM_CHANNEL_ACCESS_ENABLED && !['true','false'].includes(env.TEAM_CHANNEL_ACCESS_ENABLED))throw new Error('invalid_TEAM_CHANNEL_ACCESS_ENABLED');
  return env.TASK_CONTROLS_ENABLED==='true' && env.TEAM_CHANNEL_ACCESS_ENABLED==='true';
}

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

export function taskThreadId(value,guildId) {
  if(/^\d{17,20}$/.test(value))return value;
  let url;try{url=new URL(value);}catch{throw new Error('task_invalid_thread');}
  if(url.protocol!=='https:' || url.port || url.username || url.password || !['discord.com','ptb.discord.com','canary.discord.com'].includes(url.hostname))throw new Error('task_invalid_thread');
  const match=/^\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?$/.exec(url.pathname);
  if(!match)throw new Error('task_invalid_thread');
  if(match[1]!==guildId)throw new Error('task_outside_forum');
  return match[2];
}
