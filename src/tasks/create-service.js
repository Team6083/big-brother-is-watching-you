import {withDiscordOwners,withDiscordAssigner,assigneeIds} from './owners.js';
import {withTaskDescription} from './description.js';
import {parseDate} from './service.js';
import {validateAck} from '../webhook.js';

const snowflake=value=>/^\d{17,20}$/.test(value||'');
export function creationInput(input) {
  const title=input.title?.trim(),description=input.description?.trim(),ids=[...new Set(input.ids||[])];
  if(!title || title.length>100 || /[\r\n]/.test(title))throw new Error('create_invalid_title');
  if(!description)throw new Error('task_invalid_description');
  withTaskDescription('',description);
  if(!ids.length || ids.length>5 || !ids.every(snowflake))throw new Error('create_invalid_members');
  const assigner=assigneeIds(input.assigner);
  const start=input.start?parseDate(input.start):null,due=input.due?parseDate(input.due,true):null;
  if(start&&due&&start>due)throw new Error('task_date_order');
  return {title,description,ids,assigner,start:input.start||null,due:input.due||null,status:input.status,names:input.names||{}};
}

export function creationPayload(row) {
  const input=row.input,url=`https://discord.com/channels/${row.guild_id}/${row.thread_id}`;
  const person=id=>({id,name:String(input.names[id]||id).replace(/[\r\n<>@]/g,' ').slice(0,100)});
  const desc=withTaskDescription(withDiscordAssigner(withDiscordOwners(
    `Discord 建立者：${row.actor_id}\n原始 Discord 討論連結：${url}\nCMSFTC_THREAD_ID=${row.thread_id}`,input.ids.map(person)),assigneeIds(input.assigner).map(person)),input.description);
  return {name:input.title,desc,idList:input.status,start:input.start?parseDate(input.start):null,due:input.due?parseDate(input.due,true):null};
}

function confirmed(row,card) {
  const payload=creationPayload(row);
  if(!validateAck({status:'succeeded',thread_id:row.thread_id,trello_card_id:card?.id,trello_card_url:card?.shortUrl},row.thread_id) || card.closed || card.idBoard!==row.board_id ||
    Object.entries(payload).some(([key,value])=>['start','due'].includes(key)?(value?Date.parse(card[key])!==Date.parse(value):card[key]!=null):card[key]!==value))throw new Error('create_pending');
  return card;
}

export class TaskCreationService {
  constructor({store,trello,discord,authorize}) {Object.assign(this,{store,trello,discord,authorize});}
  async create({id,guild,channel,actor,input}) {
    if(![id,guild,channel,actor].every(snowflake))throw new Error('create_forbidden');
    input=creationInput(input);
    const scope={guild_id:guild,channel_id:channel,actor_id:actor,input};
    await this.authorize(scope);
    const [board,lists]=await Promise.all([this.trello.board(),this.trello.lists()]);
    if(board.closed || !lists.some(l=>l.id===input.status&&l.idBoard===board.id&&!l.closed))throw new Error('task_invalid_status');
    const row={...scope,id,board_id:board.id,list_name:lists.find(l=>l.id===input.status).name};
    if(!await this.store.reserve(row))return this.reconcile(id,scope);
    // Reserve before either external side effect. Unknown results are read back, never POSTed again.
    const thread=await this.discord.createThread(row);
    if(!snowflake(thread?.id) || thread.guildId!==guild || thread.parentId!==channel || thread.type!==11)throw new Error('create_pending');
    await this.store.attachThread(id,thread.id);row.thread_id=thread.id;
    await this.authorize(row);
    const card=confirmed(row,await this.trello.create(creationPayload(row)));
    await this.store.finish(id,card);
    return this.notify(await this.store.get(id));
  }
  async reconcile(id,scope) {
    const row=await this.store.get(id);
    if(!row || row.guild_id!==scope.guild_id || row.channel_id!==scope.channel_id || row.actor_id!==scope.actor_id)throw new Error('create_forbidden');
    await this.authorize(row);
    if(row.state!=='succeeded') {
      if(!row.thread_id)throw new Error('create_thread_uncertain');
      const cards=await this.trello.cardsForThread(row.thread_id);
      if(cards.length!==1)throw new Error('create_pending');
      await this.store.finish(id,confirmed(row,cards[0]));
    }
    return this.notify(await this.store.get(id));
  }
  async notify(row) {
    if(await this.store.claimNotice(row.id)) {
      try {const message=await this.discord.notify(row);if(!snowflake(message?.id))throw new Error('create_pending');await this.store.noticeSent(row.id,message.id);}
      catch {return {...row,notification_state:'sending'};}
    }
    return await this.store.get(row.id);
  }
}
