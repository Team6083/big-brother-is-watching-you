import {ActionRowBuilder,ButtonBuilder,ButtonStyle,ChannelType,Events,MessageFlags,PermissionFlagsBits} from 'discord.js';
import {MongoCreationStore} from '../state/creations.js';
import {TaskCreationService,creationInput} from './create-service.js';
import {createTaskModal,createTaskPreview,creationCheckControls,safeTaskText,taskDateControls,taskDateCursor} from './create-ui.js';
import {isTeamTaskChannel,teamChannelIds} from './scope.js';
import {taskConfig,trelloTasks} from './trello.js';
import {assigneeIds} from './owners.js';

const userPermissions=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.SendMessages,PermissionFlagsBits.SendMessagesInThreads];
const botPermissions=[...userPermissions,PermissionFlagsBits.CreatePublicThreads];
const errors={
  create_forbidden:'請在設定允許的隊長／幹部文字頻道操作；限能查看及發言的授權成員。',
  create_bot_permissions:'Bot 需要查看頻道、讀取歷史、傳送訊息、建立公開討論串與在討論串發言的權限。',
  create_invalid_members:'請選擇可查看此頻道的人類成員：Owner 與 Assignee 各 1–5 位。',
  task_invalid_assigner:'請選擇 1–5 位可查看此頻道的人類成員作為 Assignee。',
  create_invalid_title:'請填入任務名稱（單行，最多 100 字）。',
  task_invalid_description:'請填入任務描述（最多 4000 字），勿使用系統保留標記。',
  task_date_order:'截止日期不能早於開始日期，請重新選擇。',
  create_invalid_date:'請重新選擇年、月、日。',
  create_expired:'表單已過期或不屬於你，請重新使用 /建立任務；若已確認建立，請以原操作編號核對。',
  task_invalid_status:'看板已封存或狀態清單已變更，請重新開啟表單。',
  create_thread_uncertain:'建立討論串的結果尚未確認，請管理員依操作編號核對 Discord 與資料庫；不要重複建立。',
  create_pending:'建立結果尚未確認，請按「核對建立結果」。若仍未找到，請管理員核對；不要重複建立。',
};

export function registerTeamTaskCreation(client,proposalStore,config,log,{policy=taskConfig(),trello,store,now=Date.now}={}) {
  if(!policy.enabled || !teamChannelIds.length)return {get running(){return false;}};
  trello??=trelloTasks(policy);store??=new MongoCreationStore(proposalStore.db);
  const canManage=member=>!member.user.bot && (policy.mode==='forum'||policy.mode==='roles'&&policy.roleIds.some(id=>member.roles.cache.has(id)));
  async function authorize(row) {
    const channel=await client.channels.fetch(row.channel_id,{force:true});
    if(row.guild_id!==config.guildId || !isTeamTaskChannel(channel,config))throw new Error('create_forbidden');
    const actor=await channel.guild.members.fetch({user:row.actor_id,force:true});
    if(!canManage(actor)||!channel.permissionsFor(actor)?.has(userPermissions))throw new Error('create_forbidden');
    if(!channel.permissionsFor(client.user)?.has(botPermissions))throw new Error('create_bot_permissions');
    for(const id of new Set([...(row.input?.ids||[]),...(row.input?assigneeIds(row.input.assigner):[])])) {
      const member=await channel.guild.members.fetch({user:id,force:true});
      if(member.user.bot || !channel.permissionsFor(member)?.has(userPermissions))throw new Error('create_invalid_members');
    }
    if(row.thread_id) {
      const thread=await client.channels.fetch(row.thread_id,{force:true});
      if(thread?.guildId!==config.guildId || thread.parentId!==row.channel_id || thread.type!==ChannelType.PublicThread || thread.locked)throw new Error('create_pending');
    }
    return channel;
  }
  const service=new TaskCreationService({store,trello,authorize,discord:{
    createThread:async row=>(await authorize(row)).threads.create({name:row.input.title,type:ChannelType.PublicThread,autoArchiveDuration:10080}),
    notify:async row=>{
      await authorize(row);
      const thread=await client.channels.fetch(row.thread_id,{force:true}),input=row.input,assignees=assigneeIds(input.assigner);
      return thread.send({content:'✅ 任務已建立。\nOwner：'+input.ids.map(id=>'<@'+id+'>').join(' ')+'\nAssignee：'+assignees.map(id=>'<@'+id+'>').join(' ')+'\n開始：'+(input.start||'未設定')+'｜截止：'+(input.due||'未設定')+
        '\n狀態：'+safeTaskText(row.list_name||input.status)+'\n後續請在此討論串使用 /任務 查看或更新狀態。',
        embeds:[{title:safeTaskText(input.title),description:safeTaskText(input.description)}],
        allowedMentions:{parse:[],users:[...new Set([...input.ids,...assignees])],repliedUser:false},nonce:row.id,enforceNonce:true});
    },
  }});
  let active=0;
  const drafts=new Map();
  const draftFor=(id,i)=>{
    const d=drafts.get(id);
    if(!d||d.actor!==i.user.id||d.channel!==i.channelId||d.guild!==i.guildId||d.expires<now()||d.submitted)throw new Error('create_expired');
    return d;
  };
  const scope=i=>({guild_id:i.guildId,channel_id:i.channelId,actor_id:i.user.id});
  const success=row=>({content:`✅ 任務已建立，請到 <#${row.thread_id}> 討論與更新。${row.notification_state==='sent'?'':'\n討論串通知尚未確認，請先查看討論串。'}`,embeds:[],components:[],allowedMentions:{parse:[]}});
  client.on(Events.InteractionCreate,async i=>{
    const command=i.isChatInputCommand();
    if(command?i.commandName!=='建立任務':!i.customId?.startsWith('create_task:'))return;
    active++;let operation;
    try {
      if(i.guildId!==config.guildId||!isTeamTaskChannel(i.channel,config)||i.user.bot||!i.channel.permissionsFor(i.member)?.has(userPermissions))throw new Error('create_forbidden');
      if(command) {
        await i.deferReply({flags:MessageFlags.Ephemeral});
        await authorize(scope(i));
        const check=i.options.getString('核對編號');
        if(check) {
          if(!/^\d{17,20}$/.test(check))throw new Error('create_forbidden');
          operation=check;return await i.editReply(success(await service.reconcile(check,scope(i))));
        }
        const [board,lists]=await Promise.all([trello.board(),trello.lists()]);
        const open=lists.filter(l=>!l.closed&&l.idBoard===board.id);
        if(board.closed||!open.length||open.length>25)throw new Error('task_invalid_status');
        for(const [id,d] of drafts)if(d.expires<now())drafts.delete(id);
        if(drafts.size>=100)drafts.delete(drafts.keys().next().value);
        drafts.set(i.id,{actor:i.user.id,channel:i.channelId,guild:i.guildId,lists:open,expires:now()+15*60000});
        return await i.editReply({content:'填寫任務內容與人員，再用選單設定日期。預覽後按「確認建立」，才會建立討論串及任務。',components:[new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('create_task:open:'+i.id).setLabel('填寫任務').setStyle(ButtonStyle.Primary))],allowedMentions:{parse:[]}});
      }
      const [,action,id]=i.customId.split(':');
      if(action==='check') {
        operation=id;await i.deferUpdate();
        return await i.editReply(success(await service.reconcile(id,scope(i))));
      }
      const d=draftFor(id,i);
      if(['open','edit'].includes(action)&&i.isButton())return await i.showModal(createTaskModal(id,d));
      if(action==='cancel'&&i.isButton()) {drafts.delete(id);return await i.update({content:'已取消，未建立任務。',embeds:[],components:[],allowedMentions:{parse:[]}});}
      if(action==='details'&&i.isModalSubmit()) {
        await i.deferUpdate();
        const ids=i.fields.getField('owners').values,assigner=i.fields.getField('assignee').values;
        const input=creationInput({...d.input,title:i.fields.getTextInputValue('title'),description:i.fields.getTextInputValue('description'),ids,assigner,status:i.fields.getStringSelectValues('status')[0]});
        if(!d.lists.some(l=>l.id===input.status))throw new Error('task_invalid_status');
        const channel=await authorize({...scope(i),input}),names={};
        for(const user of new Set([...input.ids,...input.assigner]))names[user]=(await channel.guild.members.fetch({user,force:true})).displayName;
        d.input={...input,names};
        return await i.editReply(createTaskPreview(id,d));
      }
      if(!d.input)throw new Error('create_expired');
      if(['start','due'].includes(action)&&i.isButton())d.cursor=taskDateCursor(action,d.input[action],now());
      else if(['year','month','day'].includes(action)&&i.isStringSelectMenu()) {
        if(!d.cursor)throw new Error('create_invalid_date');
        const controls=taskDateControls(id,d.cursor).map(r=>r.toJSON()),select=controls.find(r=>r.components[0].custom_id===i.customId)?.components[0];
        if(!select?.options.some(o=>o.value===i.values[0]))throw new Error('create_invalid_date');
        if(action==='day') {
          const input=creationInput({...d.input,[d.cursor.field]:i.values[0]});
          d.input=input;d.cursor=null;return await i.update(createTaskPreview(id,d));
        }
        d.cursor[action]=Number(i.values[0]);d.cursor.page=0;
      } else if(['previous','next'].includes(action)&&i.isButton()&&d.cursor)d.cursor.page=action==='previous'?0:1;
      else if(['back','clear'].includes(action)&&i.isButton()&&d.cursor) {
        if(action==='clear')d.input[d.cursor.field]=null;
        d.cursor=null;return await i.update(createTaskPreview(id,d));
      } else if(action==='save'&&i.isButton()) {
        operation=id;d.submitted=true;await i.deferUpdate();
        const row=await service.create({id,guild:i.guildId,channel:i.channelId,actor:i.user.id,input:d.input});
        drafts.delete(id);log('team_task_created',{thread_id:row.thread_id});
        return await i.editReply(success(row));
      } else throw new Error('create_expired');
      return await i.update({content:'選擇'+(d.cursor.field==='start'?'開始':'截止')+'日期（台灣時間）。先選年、月，再選日；26 日以後可翻頁。',embeds:[],components:taskDateControls(id,d.cursor),allowedMentions:{parse:[]}});
    } catch(error) {
      if(operation) {
        try {if(!await store.get(operation)){const draft=drafts.get(operation);if(draft)draft.submitted=false;operation=undefined;}}catch{}
      }
      log('team_task_creation_failed',{code:Object.hasOwn(errors,error.message)?error.message:'create_operation_failed'});
      const message=errors[error.message]||'操作未完成，請管理員檢查權限與連線。';
      const reply={content:message+(operation?'\n操作編號：'+operation+'\n可用 /建立任務 的「核對編號」選項查詢；核對不會重建。':''),allowedMentions:{parse:[]}};
      try {
        if(i.deferred||i.replied)await i.editReply({...reply,...(operation?{embeds:[],components:creationCheckControls(operation)}:{})});
        else await i.reply({...reply,flags:MessageFlags.Ephemeral});
      } catch {log('team_task_creation_failed',{code:'create_reply_failed'});}
    } finally {active--;}
  });
  return {get running(){return active>0;}};
}
