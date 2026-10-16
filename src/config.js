export function loadConfig(env = process.env) {
  for (const name of ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_FORUM_CHANNEL_ID', 'MAKE_WEBHOOK_URL']) {
    if (!env[name]?.trim()) throw new Error(`missing_${name}`);
  }
  for (const name of ['DISCORD_GUILD_ID', 'DISCORD_FORUM_CHANNEL_ID']) {
    if (!/^\d{17,20}$/.test(env[name])) throw new Error(`invalid_${name}`);
  }
  let url;
  try { url = new URL(env.MAKE_WEBHOOK_URL); } catch { throw new Error('invalid_MAKE_WEBHOOK_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !/^hook(?:\.[a-z0-9-]+)?\.(?:make|integromat)\.com$/.test(url.hostname) || url.pathname.length < 2) {
    throw new Error('invalid_MAKE_WEBHOOK_URL');
  }
  if (env.DISCORD_NOTIFY && !['true', 'false'].includes(env.DISCORD_NOTIFY)) throw new Error('invalid_DISCORD_NOTIFY');
  for(const name of ['MEETING_CHANNEL_ID','MEETING_ROLE_ID'])if(env[name] && !/^\d{17,20}$/.test(env[name]))throw new Error('invalid_'+name);
  if(Boolean(env.MEETING_CHANNEL_ID)!==Boolean(env.MEETING_ROLE_ID))throw new Error('invalid_MEETING_CHANNEL_ID');
  if((env.TASK_ALLOWED_CHANNEL_IDS||'').split(',').filter(Boolean).some(id=>!/^\d{17,20}$/.test(id.trim())))throw new Error('invalid_TASK_ALLOWED_CHANNEL_IDS');
  return {
    token: env.DISCORD_BOT_TOKEN, guildId: env.DISCORD_GUILD_ID,
    forumId: env.DISCORD_FORUM_CHANNEL_ID, webhookUrl: url.href,
    webhookApiKey: env.MAKE_WEBHOOK_API_KEY || '',
    meetingChannelId:env.MEETING_CHANNEL_ID || '',
    notify: env.DISCORD_NOTIFY !== 'false',
  };
}
