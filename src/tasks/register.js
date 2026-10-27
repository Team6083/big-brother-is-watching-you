import { REST, Routes } from 'discord.js';
import { taskCommands } from './interactions.js';
import { meetingCommands,retiredMeetingCommands } from '../meetings.js';

export async function registerCommands(rest,applicationId,guild,env=process.env) {
  // Upsert our commands individually; do not replace other guild commands.
  const commands=await rest.get(Routes.applicationGuildCommands(applicationId,guild));
  for(const retired of commands.filter(c=>['成員對應',...retiredMeetingCommands].includes(c.name)))await rest.delete(Routes.applicationGuildCommand(applicationId,guild,retired.id));
  const enabled=[...(env.TASK_CONTROLS_ENABLED==='true'?taskCommands.filter(c=>c.name!=='建立任務'||env.TASK_ALLOWED_CHANNEL_IDS?.split(',').some(id=>id.trim())):[]),
    ...(env.MEETING_CHANNEL_ID&&env.MEETING_ROLE_ID?meetingCommands:[])];
  for(const command of [...taskCommands,...meetingCommands]) {
    if(enabled.includes(command))await rest.post(Routes.applicationGuildCommands(applicationId,guild),{body:command.toJSON()});
    else {
      const existing=commands.find(c=>c.name===command.name);
      if(existing)await rest.delete(Routes.applicationGuildCommand(applicationId,guild,existing.id));
    }
  }
}

if(import.meta.main) {
  try {
    const token=process.env.DISCORD_BOT_TOKEN,guild=process.env.DISCORD_GUILD_ID;
    if(!token || !/^\d{17,20}$/.test(guild || ''))throw new Error();
    const rest=new REST({version:'10',timeout:15000,retries:0}).setToken(token);
    const me=await rest.get(Routes.user('@me'));
    await registerCommands(rest,me.id,guild);
    console.log('Task and meeting commands registered in the configured guild.');
  } catch {console.error('task_command_registration_failed');process.exitCode=1;}
}
