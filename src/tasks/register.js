import { REST, Routes } from 'discord.js';
import { taskCommands } from './interactions.js';
import { meetingCommands } from '../meetings.js';

try {
  const token=process.env.DISCORD_BOT_TOKEN,guild=process.env.DISCORD_GUILD_ID;
  if(!token || !/^\d{17,20}$/.test(guild || ''))throw new Error();
  const rest=new REST({version:'10',timeout:15000,retries:0}).setToken(token);
  const me=await rest.get(Routes.user('@me'));
  // Upsert our commands individually; do not replace other guild commands.
  const commands=await rest.get(Routes.applicationGuildCommands(me.id,guild));
  const retired=commands.find(c=>c.name==='成員對應');
  if(retired)await rest.delete(Routes.applicationGuildCommand(me.id,guild,retired.id));
  const enabled=[...(process.env.TASK_CONTROLS_ENABLED==='true'?taskCommands.filter(c=>c.name!=='建立任務'||process.env.TASK_ALLOWED_CHANNEL_IDS?.split(',').some(id=>id.trim())):[]),
    ...(process.env.MEETING_CHANNEL_ID&&process.env.MEETING_ROLE_ID?meetingCommands:[])];
  for(const command of [...taskCommands,...meetingCommands]) {
    if(enabled.includes(command))await rest.post(Routes.applicationGuildCommands(me.id,guild),{body:command.toJSON()});
    else {
      const existing=commands.find(c=>c.name===command.name);
      if(existing)await rest.delete(Routes.applicationGuildCommand(me.id,guild,existing.id));
    }
  }
  console.log('Task and meeting commands registered in the configured guild.');
} catch { console.error('task_command_registration_failed');process.exitCode=1; }
