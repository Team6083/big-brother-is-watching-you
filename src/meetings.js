import {dateOptions,dateControls,timeModal,selectedTimes,previewControls,cancelControls,savedMeetingControls,recordControls,recordModal} from './meetings-ui.js';
import {MongoMeetingStore} from './state/meetings.js';
import { Events, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export const meetingChannelId=process.env.MEETING_CHANNEL_ID || '';
export const captainRoleId=process.env.MEETING_ROLE_ID || '';
export const meetingCommands=[
  new SlashCommandBuilder().setName('會議設定').setDescription('選擇會議日期、開始與結束時間，並填寫地點'),
  new SlashCommandBuilder().setName('會議查看').setDescription('查看下一次隊長會議與提醒狀態'),
  new SlashCommandBuilder().setName('查看會議記錄').setDescription('選擇已有的會議日期，取得記錄連結'),
];
export const retiredMeetingCommands=['會議取消','會議記錄設定'];

export function meetingTimes(date,time,now=Date.now(),previous) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw new Error('日期與時間格式：YYYY-MM-DD、HH:mm。');
  const starts=Date.parse(`${date}T${time}:00+08:00`);
  if(!Number.isFinite(starts) || new Date(starts+8*3600000).toISOString().slice(0,16)!==`${date}T${time}`)throw new Error('請填入有效的日期與時間。');
  const remind=Date.parse(`${date}T17:00:00+08:00`)-86400000;
  if(starts<=now)throw new Error('會議時間必須在未來。');
  if(remind<=now && !(previous?.starts_at>now && previous.remind_at===remind && ['pending','sent','uncertain'].includes(previous.status)))throw new Error('已過前一天下午 5 點的提醒時間，請另行通知；此次未儲存設定。');
  return {starts,remind};
}

export function meetingEnd(date,start,end) {
  if(end===undefined)return null;
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || end<=start)throw new Error('結束時間必須晚於開始時間，且在同一天。');
  return Date.parse(`${date}T${end}:00+08:00`);
}

export function checkMeetingEdit(previous,current) {
  if(previous && (!current || ['cancelled','missed'].includes(current.status) ||
    ['starts_at','ends_at','location'].some(key=>current[key]!==previous[key])))throw new Error('會議資料已變更，請重新開啟編輯。');
}

export function recordDate(date) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T00:00:00Z')) ||
    new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw new Error('請填入有效的會議日期，例如 2026-10-30。');
  return date;
}

export function recordLink(value) {
  let url;
  try {url=new URL(value);}catch{throw new Error('請填入有效的 HTTPS 會議記錄連結。');}
  if(typeof value!=='string' || value.length>1000 || url.href.length>1000 || /[\s<>]/.test(value) || url.protocol!=='https:' || url.username || url.password)throw new Error('請填入有效的 HTTPS 會議記錄連結。');
  return url.href;
}

const taipeiDate=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);

export class MeetingStore {
  constructor(db) {
    this.db=db;
    db.exec(`CREATE TABLE IF NOT EXISTS meetings (
      channel_id TEXT PRIMARY KEY, starts_at INTEGER NOT NULL, remind_at INTEGER NOT NULL,
      actor_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','uncertain','cancelled','missed')),
      message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0
    )`);
    if(!db.prepare('PRAGMA table_info(meetings)').all().some(column=>column.name==='location'))db.exec("ALTER TABLE meetings ADD COLUMN location TEXT NOT NULL DEFAULT ''");
    if(!db.prepare('PRAGMA table_info(meetings)').all().some(column=>column.name==='ends_at'))db.exec('ALTER TABLE meetings ADD COLUMN ends_at INTEGER');
    db.exec(`CREATE TABLE IF NOT EXISTS meeting_records (
      channel_id TEXT NOT NULL, meeting_date TEXT NOT NULL, url TEXT NOT NULL,
      actor_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(channel_id,meeting_date)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS meeting_dates (
      channel_id TEXT NOT NULL, meeting_date TEXT NOT NULL, PRIMARY KEY(channel_id,meeting_date)
    )`);
    for(const row of db.prepare("SELECT channel_id,starts_at FROM meetings WHERE status!='cancelled'").all()) {
      db.prepare('INSERT OR IGNORE INTO meeting_dates VALUES(?,?)').run(row.channel_id,taipeiDate(row.starts_at));
    }
    // A crash during send may mean Discord accepted it. Do not send a second notice.
    db.prepare("UPDATE meetings SET status='uncertain' WHERE status='sending'").run();
  }
  get(id) { return this.db.prepare('SELECT * FROM meetings WHERE channel_id=?').get(id); }
  set(id,date,time,actor,location,now=Date.now(),endTime,previous,recordUrl) {
    location=location?.trim();
    if(!location || location.length>200 || /[\r\n]/.test(location))throw new Error('請填入會議地點（單行，最多 200 字）。');
    if(recordUrl!==undefined&&recordUrl!=='')recordUrl=recordLink(recordUrl);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.get(id);
      if(old?.status==='sending')throw new Error('提醒正在發送，請稍後再修改。');
      checkMeetingEdit(previous,old);
      const {starts,remind}=meetingTimes(date,time,now,old),ends=meetingEnd(date,time,endTime);
      if(old?.remind_at===remind && ['pending','sent','uncertain'].includes(old.status)) {
        this.db.prepare('UPDATE meetings SET starts_at=?,location=?,actor_id=?,ends_at=? WHERE channel_id=?').run(starts,location,actor,ends,id);
      } else {
        this.db.prepare(`INSERT INTO meetings(channel_id,starts_at,remind_at,actor_id,location,ends_at,status) VALUES(?,?,?,?,?,?,'pending')
          ON CONFLICT(channel_id) DO UPDATE SET starts_at=excluded.starts_at,remind_at=excluded.remind_at,
          actor_id=excluded.actor_id,location=excluded.location,ends_at=excluded.ends_at,status='pending',message_id=NULL,attempts=0`).run(id,starts,remind,actor,location,ends);
        if(old && old.starts_at>now && taipeiDate(old.starts_at)!==date)this.db.prepare('DELETE FROM meeting_dates WHERE channel_id=? AND meeting_date=?').run(id,taipeiDate(old.starts_at));
        this.db.prepare('INSERT OR IGNORE INTO meeting_dates VALUES(?,?)').run(id,date);
      }
      if(recordUrl!==undefined)this.setRecord(id,date,recordUrl,actor);
      this.db.exec('COMMIT');
      return this.get(id);
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  cancel(id,now=Date.now(),previous) {
    const old=this.get(id);checkMeetingEdit(previous,old);
    if(old?.status==='sending')throw new Error('提醒正在發送，請稍後再操作。');
    if(previous&&old.starts_at<=now)throw new Error('會議時間已過，請重新查看會議。');
    const changed=this.db.prepare("UPDATE meetings SET status='cancelled' WHERE channel_id=? AND status!='sending'").run(id).changes;
    if(changed && old.starts_at>now)this.db.prepare('DELETE FROM meeting_dates WHERE channel_id=? AND meeting_date=?').run(id,taipeiDate(old.starts_at));
    return changed;
  }
  recordDates(channel) {
    return this.db.prepare(`SELECT meeting_date FROM meeting_dates WHERE channel_id=?
      UNION SELECT meeting_date FROM meeting_records WHERE channel_id=? ORDER BY meeting_date DESC`).all(channel,channel).map(row=>row.meeting_date);
  }
  setRecord(channel,date,url,actor) {
    const validDate=recordDate(date);
    if(url===''){this.db.prepare('DELETE FROM meeting_records WHERE channel_id=? AND meeting_date=?').run(channel,validDate);return;}
    const validUrl=recordLink(url);
    this.db.prepare(`INSERT INTO meeting_records VALUES(?,?,?,?,?) ON CONFLICT(channel_id,meeting_date)
      DO UPDATE SET url=excluded.url,actor_id=excluded.actor_id,updated_at=excluded.updated_at`).run(channel,validDate,validUrl,actor,Date.now());
    return this.record(channel,validDate);
  }
  record(channel,date) {return this.db.prepare('SELECT * FROM meeting_records WHERE channel_id=? AND meeting_date=?').get(channel,recordDate(date));}
  recordForMeeting(row) {return this.record(row.channel_id,new Date(row.starts_at+8*3600000).toISOString().slice(0,10));}
  markMissed(row) {this.db.prepare("UPDATE meetings SET status='missed' WHERE channel_id=? AND starts_at=? AND status='pending'").run(row.channel_id,row.starts_at);}
  verificationFailed(row) {this.db.prepare("UPDATE meetings SET attempts=attempts+1,status=CASE WHEN attempts>=4 THEN 'uncertain' ELSE 'pending' END WHERE channel_id=? AND starts_at=? AND status='pending'").run(row.channel_id,row.starts_at);}
  claim(row) {return this.db.prepare("UPDATE meetings SET status='sending' WHERE channel_id=? AND starts_at=? AND status='pending' RETURNING *").get(row.channel_id,row.starts_at);}
  markSent(row,id) {this.db.prepare("UPDATE meetings SET status='sent',message_id=? WHERE channel_id=? AND starts_at=? AND status='sending'").run(id,row.channel_id,row.starts_at);}
  markUncertain(row) {this.db.prepare("UPDATE meetings SET status='uncertain' WHERE channel_id=? AND starts_at=? AND status='sending'").run(row.channel_id,row.starts_at);}
}

const display=ms=>new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',dateStyle:'full',timeStyle:'short',hour12:false}).format(new Date(ms));
const meetingRange=row=>display(row.starts_at)+(row.ends_at?' ～ '+new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(row.ends_at)):'（結束時間尚未設定）');
const states={pending:'等待提醒',sending:'發送中',sent:'已提醒',uncertain:'發送結果未確認，請檢查頻道，避免重複通知',cancelled:'已取消',missed:'會議時間已過，未補發提醒'};
const editNotice=row=>row.status==='sent'?'\n原提醒已發出；此次修改不會重發或更新原提醒，請告知出席成員。':'';
const recordSummary=url=>'\n會議記錄：'+(url?'<'+url+'>':'尚未設定');
export function meetingSummary(row) {
  return !row?'尚未設定會議。':`隊長會議：${meetingRange(row)}\n地點：${row.location || '尚未設定'}\n提醒：${display(row.remind_at)}\n狀態：${states[row.status]}`;
}

export class MeetingReminder {
  constructor({store,send,verify,log,now=Date.now}) { Object.assign(this,{store,send,verify,log,now});this.running=false; }
  async tick() {
    if(this.running)return;
    this.running=true;
    try {
      const row=await this.store.get(meetingChannelId),now=this.now();
      if(!row || row.status!=='pending' || row.remind_at>now)return;
      if(row.starts_at<=now) {await this.store.markMissed(row);return;}
      try {await this.verify();} catch {
        await this.store.verificationFailed(row);
        this.log('meeting_reminder_failed',{code:'permission_or_channel_check_failed'});return;
      }
      const claimed=await this.store.claim(row);
      if(!claimed)return;
      try {
        const record=await this.store.recordForMeeting(claimed);
        const message=await this.send({content:`【隊長會議提醒】\n<@&${captainRoleId}>\n會議時間：${meetingRange(claimed)}\n地點：${claimed.location || '尚未設定'}\n請記得出席並準備各組簡報。${record?'\n會議記錄：<'+record.url+'>':''}`,allowedMentions:{parse:[],roles:[captainRoleId],users:[],repliedUser:false}});
        await this.store.markSent(row,message.id);
        this.log('meeting_reminder_sent');
      } catch {
        await this.store.markUncertain(row);
        this.log('meeting_reminder_failed',{code:'send_result_uncertain'});
      }
    } finally {this.running=false;}
  }
}

export function registerMeetings(client,proposalStore,config,log,{now=Date.now}={}) {
  if(!meetingChannelId || !captainRoleId)return {tick:async()=>{},get running(){return false;}};
  const store=proposalStore.db.mongo?new MongoMeetingStore(proposalStore.db):new MeetingStore(proposalStore.db);
  async function verify() {
    const channel=await client.channels.fetch(meetingChannelId);
    if(channel?.guildId!==config.guildId || channel.type!==0)throw new Error('invalid_meeting_channel');
    const role=await channel.guild.roles.fetch(captainRoleId);
    const permissions=channel.permissionsFor(client.user);
    if(!role || !permissions?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]) ||
      (!role.mentionable && !permissions.has(PermissionFlagsBits.MentionEveryone)))throw new Error('meeting_permission_missing');
    return channel;
  }
  const reminder=new MeetingReminder({store,verify,send:async payload=>(await verify()).send(payload),log,now});
  let active=0;
  const drafts=new Map();
  const draftFor=(id,i)=>{
    const draft=drafts.get(id);
    if(!draft || draft.actor!==i.user.id || draft.expires<now())throw new Error('請重新開啟會議設定，表單已逾時或不屬於你。');
    return draft;
  };
  const preview=(id,draft)=>{
    const {starts,remind}=meetingTimes(draft.date,draft.start,now(),draft.previous);
    const row={starts_at:starts,ends_at:meetingEnd(draft.date,draft.start,draft.end),remind_at:remind,location:draft.location,status:draft.previous?.status||'pending'};
    return {content:'請確認會議資料（尚未儲存）：\n'+meetingSummary(row)+recordSummary(draft.recordUrl)+editNotice(row),components:previewControls(id,!!draft.previous),allowedMentions:{parse:[]}};
  };
  client.on(Events.InteractionCreate,async i=>{
    const command=i.isChatInputCommand();
    if(command?![...meetingCommands.map(c=>c.name),...retiredMeetingCommands].includes(i.commandName):!i.customId?.startsWith('meeting:'))return;
    active++;
    try {
      if(i.guildId!==config.guildId || i.channelId!==meetingChannelId || i.user.bot ||
        !i.channel?.permissionsFor(i.member)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw new Error('請在隊長頻道內操作；限可查看並發言的成員。');
      if(retiredMeetingCommands.includes(i.commandName))return await i.reply({flags:MessageFlags.Ephemeral,
        content:i.commandName==='會議取消'?'請使用 /會議查看，按「編輯會議」→「取消會議」。':'請使用 /會議設定 內的「既有會議記錄」，或在設定預覽中填「會議記錄連結」。',allowedMentions:{parse:[]}});
      if(i.commandName==='會議設定' || i.customId==='meeting:open_edit') {
        await i.deferReply({flags:MessageFlags.Ephemeral});
        await verify();
        for(const [id,draft] of drafts)if(draft.expires<now())drafts.delete(id);
        if(drafts.size>=100)drafts.delete(drafts.keys().next().value);
        const old=await store.get(meetingChannelId),options=dateOptions(now()),editing=i.customId==='meeting:open_edit';
        if(editing && old?.status==='sending')throw new Error('提醒正在發送，請稍後再修改。');
        if(editing && !savedMeetingControls(old,now()).length)throw new Error('請先使用 /會議設定 建立尚未開始的會議。');
        const localTime=ms=>ms?new Date(ms+8*3600000).toISOString().slice(11,16):undefined;
        const record=editing?await store.recordForMeeting(old):null;
        const draft={actor:i.user.id,expires:now()+15*60000,options,stage:editing?'preview':'date',previous:editing?old:undefined,date:editing?taipeiDate(old.starts_at):undefined,recordUrl:record?.url,location:old?.location||'',start:localTime(old?.starts_at),end:localTime(old?.ends_at)};
        drafts.set(i.id,draft);
        if(editing)return await i.editReply(preview(i.id,draft));
        return await i.editReply({content:'選擇會議日期，再選開始／結束時間及填寫地點。日期可翻頁；分鐘每 5 分鐘一格。最後確認才會儲存。',components:dateControls(i.id,options,0),allowedMentions:{parse:[]}});
      }
      if(command) {
        await i.deferReply({flags:MessageFlags.Ephemeral});
        if(i.commandName==='查看會議記錄') {
          const dates=await store.recordDates(meetingChannelId);
          if(!dates.length)return await i.editReply({content:'目前沒有可選的會議日期。請先用 /會議設定 設定會議。',allowedMentions:{parse:[]}});
          for(const [id,draft] of drafts)if(draft.expires<now())drafts.delete(id);
          if(drafts.size>=100)drafts.delete(drafts.keys().next().value);
          drafts.set(i.id,{actor:i.user.id,expires:now()+15*60000,kind:'record_view',dates});
          return await i.editReply({content:'請選擇會議日期（只列出已設定的會議及已有記錄的日期）。',components:recordControls(i.id,dates),allowedMentions:{parse:[]}});
        }
        const row=await store.get(meetingChannelId),record=row?await store.recordForMeeting(row):null;
        await i.editReply({content:meetingSummary(row)+(record?'\n會議記錄：<'+record.url+'>':''),components:savedMeetingControls(row,now()),allowedMentions:{parse:[]}});
        return;
      }
      const [,action,id,pageValue]=i.customId.split(':'),draft=draftFor(id,i);
      if(action==='record_history' && i.isButton() && draft.stage==='date') {
        const dates=await store.recordDates(meetingChannelId);
        if(!dates.length)throw new Error('請先設定會議，再補登該日期的會議記錄。');
        Object.assign(draft,{kind:'record_set',dates});
        return await i.update({content:'選擇已有的會議日期，設定或更新會議記錄連結。',components:recordControls(id,dates),allowedMentions:{parse:[]}});
      }
      if(action==='record_page' && i.isButton() && draft.kind?.startsWith('record_')) {
        return await i.update({components:recordControls(id,draft.dates,Number(pageValue)),allowedMentions:{parse:[]}});
      }
      if(action==='record_date' && i.isStringSelectMenu() && draft.kind?.startsWith('record_')) {
        const date=i.values[0];
        if(!draft.dates.includes(date) || !(await store.recordDates(meetingChannelId)).includes(date))throw new Error('請重新選擇已有的會議日期。');
        const record=await store.record(meetingChannelId,date);
        if(draft.kind==='record_set') {
          draft.date=date;
          return await i.showModal(recordModal(id,date,record?.url));
        }
        await i.deferUpdate();
        return await i.editReply({content:record?`${date} 會議記錄：\n<${record.url}>`:`${date} 尚未登錄會議記錄連結。`,allowedMentions:{parse:[]}});
      }
      if(action==='record_submit' && i.isModalSubmit() && draft.kind==='record_set' && draft.date) {
        await i.deferReply({flags:MessageFlags.Ephemeral});
        if(!(await store.recordDates(meetingChannelId)).includes(draft.date))throw new Error('請重新選擇已有的會議日期。');
        const record=await store.setRecord(meetingChannelId,draft.date,i.fields.getTextInputValue('url').trim(),i.user.id);
        drafts.delete(id);
        return await i.editReply({content:record?`✅ 已儲存 ${draft.date} 會議記錄：\n<${record.url}>`:`✅ 已清除 ${draft.date} 會議記錄連結。`,components:[],allowedMentions:{parse:[]}});
      }
      if(action==='record_link' && i.isButton() && draft.stage==='preview')return await i.showModal(recordModal(id,draft.date,draft.recordUrl,'record_draft'));
      if(action==='record_draft' && i.isModalSubmit() && draft.stage==='preview') {
        const value=i.fields.getTextInputValue('url').trim();draft.recordUrl=value?recordLink(value):'';draft.recordChanged=true;
        return await i.reply({...preview(id,draft),flags:MessageFlags.Ephemeral});
      }
      if(action==='cancel' && i.isButton() && draft.previous && draft.stage==='preview') {
        draft.stage='cancel_confirm';
        return await i.update({content:'確定取消這場會議及後續提醒？\n'+meetingSummary(draft.previous)+'\n會議記錄與已發出的訊息會保留。',components:cancelControls(id),allowedMentions:{parse:[]}});
      }
      if(action==='keep' && i.isButton() && draft.stage==='cancel_confirm') {draft.stage='preview';return await i.update(preview(id,draft));}
      if(action==='confirm_cancel' && i.isButton() && draft.previous && draft.stage==='cancel_confirm') {
        await i.deferUpdate();await store.cancel(meetingChannelId,now(),draft.previous);drafts.delete(id);
        return await i.editReply({content:'✅ 已取消會議及後續提醒；會議記錄與已發出的訊息保留。',components:[],allowedMentions:{parse:[]}});
      }
      if(action==='discard' && i.isButton()) {
        drafts.delete(id);return await i.update({content:'已取消本次設定，原有會議不變。',components:[],allowedMentions:{parse:[]}});
      }
      if(action==='page' && i.isButton() && draft.stage==='date') {
        const page=Number(pageValue),options=dateOptions(now(),page);
        draft.options=options;
        return await i.update({components:dateControls(id,options,page,draft.date),allowedMentions:{parse:[]}});
      }
      if(action==='change_date' && i.isButton() && draft.stage==='preview') {
        draft.stage='date';draft.options=dateOptions(now());
        return await i.update({content:'選擇新的會議日期；原時間與地點會帶入，確認儲存後才會變更。',components:dateControls(id,draft.options,0,draft.date),allowedMentions:{parse:[]}});
      }
      if(action==='date' && i.isStringSelectMenu() && draft.stage==='date') {
        if(!draft.options.some(o=>o.value===i.values[0]))throw new Error('請重新選擇會議日期。');
        draft.date=i.values[0];
        if(!draft.recordChanged)draft.recordUrl=(await store.record(meetingChannelId,draft.date))?.url;
        return await i.showModal(timeModal(id,draft));
      }
      if(action==='edit' && i.isButton() && draft.stage==='preview')return await i.showModal(timeModal(id,draft));
      if(action==='times' && i.isModalSubmit() && draft.date) {
        await i.deferReply({flags:MessageFlags.Ephemeral});
        const {start,end}=selectedTimes(i.fields),location=i.fields.getTextInputValue('location').trim();
        meetingTimes(draft.date,start,now(),draft.previous);
        meetingEnd(draft.date,start,end);
        if(!location || location.length>200 || /[\r\n]/.test(location))throw new Error('請填入會議地點（單行，最多 200 字）。');
        Object.assign(draft,{start,end,location,stage:'preview'});
        return await i.editReply(preview(id,draft));
      }
      if(action==='save' && i.isButton() && draft.stage==='preview') {
        await i.deferUpdate();
        await verify();
        const row=await store.set(meetingChannelId,draft.date,draft.start,i.user.id,draft.location,now(),draft.end,draft.previous,draft.recordChanged?draft.recordUrl:undefined);
        drafts.delete(id);
        const record=await store.recordForMeeting(row);
        return await i.editReply({content:'✅ 已儲存會議設定。\n'+meetingSummary(row)+recordSummary(record?.url)+editNotice(row),components:savedMeetingControls(row,now()),allowedMentions:{parse:[]}});
      }
      throw new Error('請重新開啟會議設定。');
    } catch(error) {
      log('meeting_operation_failed',{code:'meeting_configuration_or_permission_failed'});
      const safe=/^(日期與時間格式|請填入|會議時間必須|會議時間已過|會議資料已變更|已過前一天|請在隊長|提醒正在|請重新|請先|結束時間)/.test(error.message);
      const reply={content:safe?error.message:'操作未完成，請確認 Bot 可查看及傳送訊息，且能提及隊長角色。',allowedMentions:{parse:[]}};
      try {if(i.deferred||i.replied)await i.editReply(reply);else await i.reply({...reply,flags:MessageFlags.Ephemeral});}catch{}
    } finally {active--;}
  });
  return {tick:()=>reminder.tick(),get running(){return active>0 || reminder.running;}};
}
