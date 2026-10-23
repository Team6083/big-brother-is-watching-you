import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, LabelBuilder, MessageFlags, ModalBuilder,
  PermissionFlagsBits, SlashCommandBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import { discordOwners, discordAssigner } from './owners.js';
import { taskDescription } from './description.js';
import {MongoTaskStore} from '../state/tasks.js';
import { TaskStore } from './store.js';
import { taskConfig, trelloTasks } from './trello.js';
import { TaskService } from './service.js';
import { isTaskThread, isTeamTaskChannel } from './scope.js';
import {createTaskCommand} from './create-ui.js';

export const taskCommands = [
  new SlashCommandBuilder().setName('任務').setDescription('開啟此提案的任務操作表單'),
  createTaskCommand,
];

export function controls(draftId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(draftId?'task:status:'+draftId:'task:status').setLabel('更新狀態').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(draftId?'task:edit:'+draftId:'task:edit').setLabel('任務設定').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('task:view').setLabel('查看任務').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('task:reconcile').setLabel('核對未確認更新').setStyle(ButtonStyle.Secondary),
  )];
}

export function taskModal(kind) {
  if(kind!=='dates')throw new Error('task_progress_retired');
  const modal=new ModalBuilder().setCustomId(`task:submit:${kind}`).setTitle('設定日期（Asia/Taipei）');
  const input=(id,label,description,style,required,maxLength)=>new LabelBuilder().setLabel(label).setDescription(description)
    .setTextInputComponent(new TextInputBuilder().setCustomId(id).setStyle(style).setRequired(required).setMaxLength(maxLength));
  if(kind==='dates')modal.addLabelComponents(
    input('start','開始日期','YYYY-MM-DD；留空不更改；填 - 清除',TextInputStyle.Short,false,10),
    input('due','截止日期','YYYY-MM-DD；當日 23:59；留空不更改；填 - 清除',TextInputStyle.Short,false,10),
  );
  return modal;
}

export function editModal(card,lists,actorId,draftId) {
  const modal=new ModalBuilder().setCustomId('task:submit:edit:'+draftId).setTitle('任務設定');
  const owners=(discordOwners(card.desc)||[]).map(o=>o.id);
  const ownerSelect=new UserSelectMenuBuilder().setCustomId('owners').setMinValues(1).setMaxValues(5).setRequired(true);
  if(owners.length)ownerSelect.setDefaultUsers(owners);
  const assigner=new UserSelectMenuBuilder().setCustomId('assigner').setMinValues(1).setMaxValues(1).setRequired(true)
    .setDefaultUsers(discordAssigner(card.desc)?.id || actorId);
  const date=value=>value?new Date(Date.parse(value)+8*3600000).toISOString().slice(0,10):'';
  const dates=new TextInputBuilder().setCustomId('dates').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(64)
    .setValue('開始：'+date(card.start)+'\n截止：'+date(card.due));
  const description=new TextInputBuilder().setCustomId('description').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000);
  const current=taskDescription(card.desc);
  if(current)description.setValue(current);
  else if(!(card.desc||'').includes('<!-- CMSFTC_TASK_DESCRIPTION_BEGIN -->'))description.setValue(descriptionTemplate);
  const open=lists.filter(l=>!l.closed && l.idBoard===card.idBoard);
  if(!open.length || open.length>25)throw new Error('task_invalid_status');
  const status=new StringSelectMenuBuilder().setCustomId('status').setMinValues(1).setMaxValues(1).setRequired(true)
    .addOptions(open.map(l=>({label:l.name.slice(0,100),value:l.id,default:l.id===card.idList})));
  modal.addLabelComponents(
    new LabelBuilder().setLabel('Owner（任務負責人）').setDescription('選擇實際執行任務的人；最多 5 位').setUserSelectMenuComponent(ownerSelect),
    new LabelBuilder().setLabel('Assignee（被指派的人）').setDescription('選擇被指派執行任務的人').setUserSelectMenuComponent(assigner),
    new LabelBuilder().setLabel('開始／截止日期').setDescription('兩行 YYYY-MM-DD；留空保留；- 清除；Asia/Taipei').setTextInputComponent(dates),
    new LabelBuilder().setLabel('狀態').setDescription('選擇後會移動 Trello 卡片至對應清單').setStringSelectMenuComponent(status),
    new LabelBuilder().setLabel('任務描述').setDescription('填工作內容、完成標準與參考資料；清空提交可清除').setTextInputComponent(description),
  );
  return modal;
}

export function parseDates(text) {
  const result={};
  if(!text.trim())return result;
  for(const line of text.split(/\r?\n/).filter(line=>line.trim())) {
    const match=/^\s*(開始|截止)(?:日期)?\s*[：:]\s*(.*?)\s*$/.exec(line);
    if(!match)throw new Error('task_invalid_date_format');
    const key=match[1]==='開始'?'start':'due';
    if(key in result)throw new Error('task_invalid_date_format');
    result[key]=match[2];
  }
  return result;
}

export function statusModal(card,lists,draftId) {
  const open=lists.filter(l=>!l.closed && l.idBoard===card.idBoard);
  if(!open.length || open.length>25)throw new Error('task_invalid_status');
  const select=new StringSelectMenuBuilder().setCustomId('status').setMinValues(1).setMaxValues(1).setRequired(true)
    .addOptions(open.map(l=>({label:l.name.slice(0,100),value:l.id,default:l.id===card.idList})));
  return new ModalBuilder().setCustomId('task:submit:status:'+draftId).setTitle('更新任務狀態').addLabelComponents(
    new LabelBuilder().setLabel('目前狀態').setDescription('選擇完成後，停止此任務的到期提醒').setStringSelectMenuComponent(select),
  );
}

export const descriptionTemplate='工作內容：\n\n完成標準：\n\n參考資料／連結（沒有可填「無」）：\n';

export function descriptionModal(card,draftId) {
  const input=new TextInputBuilder().setCustomId('description').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000)
    .setPlaceholder('工作內容、完成標準、參考資料；清空並提交可清除任務描述');
  const text=taskDescription(card.desc);
  if(text)input.setValue(text);
  else if(!(card.desc || '').includes('<!-- CMSFTC_TASK_DESCRIPTION_BEGIN -->'))input.setValue(descriptionTemplate);
  return new ModalBuilder().setCustomId('task:submit:description:'+draftId).setTitle('編輯任務描述').addLabelComponents(
    new LabelBuilder().setLabel('任務描述').setDescription('最多 4000 字；保留原始提案、負責人、日期與狀態').setTextInputComponent(input),
  );
}

const errors = {
  task_forbidden:'任務設定與狀態更新限可查看此論壇的授權成員。',
  task_progress_retired:'目前流程只需更新狀態，不再填寫進度；請重新輸入 /任務，按「更新狀態」。',
  task_outside_forum:'請在指定 Mentor 提案論壇或 Bot 建立的隊長／幹部任務討論串內操作。',
  task_not_synced:'此文章尚未完成 Trello 同步，請先等候成功通知。',
  task_card_mismatch:'卡片已封存或來源不符，請核對原始 Trello 卡片。',
  task_invalid_date:'日期請填有效的 YYYY-MM-DD；留空不更改，填 - 清除。',
  task_invalid_date_format:'日期請分兩行：開始：YYYY-MM-DD、截止：YYYY-MM-DD；留空保留，填 - 清除。',
  task_date_order:'截止日期不能早於開始日期。', task_empty_update:'請至少填寫一項要更改的日期。',
  task_pending_review:'已有更新未能確認，請先按「核對未確認更新」；核對前不重複送出。',
  task_trello_unconfirmed:'尚未確認 Trello 已更新。請先按「核對未確認更新」，不要反覆提交。',
  task_trello_rejected:'Trello 拒絕此操作，請檢查寫入授權與卡片權限。',
  task_nothing_to_reconcile:'目前沒有待核對的更新。',
  task_invalid_status:'狀態清單已變更或不可使用，請重新輸入 /任務。',
  task_invalid_assigner:'請選擇一位可查看論壇的人類成員作為被指派的人。',
  task_invalid_owners:'請選擇 1–5 位可查看論壇的人類負責人。',
  task_form_expired:'表單已過期或 Bot 已重新啟動，請重新輸入 /任務。',
  task_invalid_description:'描述最多 4000 字，請勿使用系統保留的 CMSFTC 標記。',
  task_invalid_description_block:'任務描述格式異常，請管理員核對 Trello 卡片。',
};
const safe=text=>String(text || '').replace(/@/g,'＠').replace(/[<>`]/g,' ').slice(0,1800);

export function taskView(card,lists) {
  const names=people=>people?.length?people.map(p=>safe(p.name)+'（<@'+p.id+'>）').join('\n'):'尚未設定';
  const assigner=discordAssigner(card.desc);
  const date=value=>value?new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',dateStyle:'short',timeStyle:'short'}).format(new Date(value)):'尚未設定';
  return {title:safe(card.name).slice(0,256),description:(taskDescription(card.desc)||'尚未填寫任務描述').replace(/@/g,'＠'),
    fields:[
      {name:'Owner（任務負責人）',value:names(discordOwners(card.desc))},
      {name:'Assignee（被指派的人）',value:names(assigner?[assigner]:[])},
      {name:'開始日期',value:date(card.start),inline:true},
      {name:'截止日期',value:date(card.due),inline:true},
      {name:'狀態',value:safe(lists.find(l=>l.id===card.idList)?.name || '尚未取得狀態'),inline:true},
    ],footer:{text:'最新資料來自 Trello；日期為 Asia/Taipei。查看不會通知其他人。'}};
}

export function registerTaskInteractions(client,proposalStore,config,log) {
  const policy=taskConfig();
  if(!policy.enabled)return;
  if(!policy.mode)throw new Error('task_missing_management_policy');
  const trello=trelloTasks(policy), store=proposalStore.db.mongo?new MongoTaskStore(proposalStore.db):new TaskStore(proposalStore.db);
  const service=new TaskService({store,proposalStore,trello,config,policy});
  let active=0;
  const drafts=new Map();
  const draftFor=(id,i)=>{const d=drafts.get(id);if(!d || d.actor!==i.user.id || d.thread!==i.channel.id || d.expires<Date.now())throw new Error('task_form_expired');return d;};
  client.on(Events.InteractionCreate, async i=>{
    const command=i.isChatInputCommand();
    if(command ? i.commandName!=='任務' : !i.customId?.startsWith('task:'))return;
    active++;
    try {
      const channel=i.channel;
      if(command && !i.user.bot && isTeamTaskChannel(channel,config))return await i.reply({flags:MessageFlags.Ephemeral,
        content:'新增工作請在此頻道使用 /建立任務。建立後，到 Bot 開的任務討論串使用 /任務 查看或修改狀態。',allowedMentions:{parse:[]}});
      if(!isTaskThread(channel,config) || i.user.bot)throw new Error('task_outside_forum');
      const member=i.member;
      const permissions=channel.permissionsFor(member);
      const actor={id:i.user.id,bot:i.user.bot,roles:member.roles.cache.map(r=>r.id),
        canViewForum:!!permissions?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory])};
      if(!actor.canViewForum)throw new Error('task_forbidden');
      if(i.isButton() && (i.customId.startsWith('task:edit:') || i.customId.startsWith('task:description:') || i.customId.startsWith('task:status:'))) {
        if(!service.canManage(actor))throw new Error('task_forbidden');
        const id=i.customId.split(':')[2],d=draftFor(id,i);
        return await i.showModal(i.customId.startsWith('task:description:')?descriptionModal(d.card,id):i.customId.startsWith('task:status:')?statusModal(d.card,d.lists,id):editModal(d.card,d.lists,actor.id,id));
      }
      if(i.customId==='task:progress' || i.customId==='task:submit:progress')throw new Error('task_progress_retired');
      if(i.isButton() && i.customId==='task:dates') {
        if(i.customId==='task:dates' && !service.canManage(actor))throw new Error('task_forbidden');
        return await i.showModal(taskModal(i.customId.split(':')[1]));
      }
      if(i.isButton() && i.customId==='task:owners') {
        if(!service.canManage(actor))throw new Error('task_forbidden');
        return await i.reply({flags:MessageFlags.Ephemeral,content:'選擇 1–5 位負責人。選擇後即取代此任務目前的全部 Discord 負責人，並在此文章 @他們。直接選擇 Discord 成員，不需要 Trello 帳號。',
          components:[new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('task:submit:owners').setMinValues(1).setMaxValues(5).setPlaceholder('選擇此任務的負責人'))]});
      }
      if(i.isChatInputCommand()) {
        await i.deferReply({flags:MessageFlags.Ephemeral});
        const [card,lists]=await Promise.all([service.context(channel,actor),trello.lists()]);
        for(const [id,d] of drafts)if(d.expires<Date.now())drafts.delete(id);
        if(drafts.size>=100)drafts.delete(drafts.keys().next().value);
        drafts.set(i.id,{actor:actor.id,thread:channel.id,card,lists,expires:Date.now()+15*60*1000});
        const displayDate=value=>value?new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',dateStyle:'short'}).format(new Date(value)):'尚未設定';
        return await i.editReply({content:`【任務操作】${safe(card.name)}\n開始：${displayDate(card.start)}｜截止：${displayDate(card.due)}\n負責人：${(discordOwners(card.desc)||[]).map(o=>safe(o.name)||'<@'+o.id+'>').join('、') || '尚未設定'}\n討論後設定人員與日期；後續只需更新狀態。`,components:controls(i.id),allowedMentions:{parse:[]}});
      }
      if(i.isButton() && i.customId==='task:view') {
        await i.deferReply({flags:MessageFlags.Ephemeral});
        const [card,lists]=await Promise.all([service.context(channel,actor),trello.lists()]);
        return await i.editReply({embeds:[taskView(card,lists)],allowedMentions:{parse:[]}});
      }
      const kind=i.customId?.split(':')[2];
      if(i.isButton() && i.customId==='task:reconcile') {
        await i.deferReply({flags:MessageFlags.Ephemeral});
        await service.reconcile(channel,actor);
        return await i.editReply({content:'✅ 已從 Trello 核對先前更新。',allowedMentions:{parse:[]}});
      }
      if(!['dates','owners','edit','description','status'].includes(kind))throw new Error('task_invalid_action');
      await i.deferReply();
      let input;
      if(kind==='status' && i.isModalSubmit()) {
        draftFor(i.customId.split(':')[3],i);
        input={status:i.fields.getStringSelectValues('status')[0]};
      } else if(kind==='description' && i.isModalSubmit()) {
        draftFor(i.customId.split(':')[3],i);
        input={text:i.fields.getTextInputValue('description')};
      } else if(kind==='edit' && i.isModalSubmit()) {
        draftFor(i.customId.split(':')[3],i);
        const ids=i.fields.getField('owners').values;
        const assigner=i.fields.getField('assigner').values?.[0];
        const names={};
        for(const id of [...new Set([...ids,assigner])]) {
          const target=await channel.guild.members.fetch({user:id,force:true});
          if(target.user.bot || !channel.permissionsFor(target)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]))throw new Error('task_forbidden');
          names[id]=target.displayName;
        }
        input={ids,assigner,names,...parseDates(i.fields.getTextInputValue('dates')),description:i.fields.getTextInputValue('description'),status:i.fields.getStringSelectValues('status')[0]};
      } else if(kind==='owners' && i.isUserSelectMenu()) {
        const names={};
        for(const id of i.values) {
          const target=await channel.guild.members.fetch({user:id,force:true});
          if(target.user.bot || !channel.permissionsFor(target)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]))throw new Error('task_forbidden');
          names[id]=target.displayName;
        }
        input={ids:i.values,names};
      } else if(kind==='dates' && i.isModalSubmit())input={start:i.fields.getTextInputValue('start'),due:i.fields.getTextInputValue('due')};
      else throw new Error('task_invalid_action');
      await service.execute({id:i.id,thread:channel,actor,kind,input});
      const mentions=['owners','edit'].includes(kind)?input.ids:[];
      const detail=kind==='edit'?'Owner：'+mentions.map(id=>'<@'+id+'>').join(' ')+'｜Assignee：'+safe(input.names[input.assigner]):kind==='owners'?mentions.map(id=>`<@${id}>`).join(' '):kind==='progress'?safe(input.text):'';
      await i.editReply({content:`✅ ${kind==='status'?'任務狀態':kind==='description'?'任務描述':kind==='edit'?'任務人員、日期、狀態與描述':kind==='dates'?'開始／截止日期':kind==='owners'?'任務負責人':'進度'}已更新至 Trello。${detail?'\n'+detail:''}`,
        allowedMentions:{parse:[],users:mentions,repliedUser:false}});
      log('task_updated',{thread_id:channel.id,code:kind});
    } catch(error) {
      log('task_operation_failed',{code:/^task_[a-z_]+$/.test(error.message)?error.message:'task_interaction_failed'});
      try {
        if(i.isAutocomplete())await i.respond([]);
        else if(i.deferred || i.replied)await i.editReply({content:errors[error.message] || '操作未完成，請管理員檢查設定。',components:[],allowedMentions:{parse:[]}});
        else await i.reply({flags:MessageFlags.Ephemeral,content:errors[error.message] || '操作未完成，請管理員檢查設定。',allowedMentions:{parse:[]}});
      } catch { log('task_reply_failed',{code:'discord_reply_failed'}); }
    } finally { active--; }
  });
  return {get running(){return active>0;}};
}
