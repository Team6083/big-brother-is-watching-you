import { discordOwners, withDiscordOwners, withDiscordAssigner, assigneeIds } from './owners.js';
import { withTaskDescription } from './description.js';
import { isTaskThread } from './scope.js';
const snowflake=id=>/^\d{17,20}$/.test(id || '');
const cardId=id=>/^[a-f0-9]{24}$/i.test(id || '');
const sameMembers=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const sameDate=(a,b)=>a===b || (!!a && !!b && Date.parse(a)===Date.parse(b));

export function parseDate(value,end=false) {
  if(value==='-')return null;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('task_invalid_date');
  const date=new Date(`${value}T${end?'23:59:00':'00:00:00'}+08:00`);
  if(!Number.isFinite(date.getTime()) || new Date(date.getTime()+8*3600000).toISOString().slice(0,10)!==value)throw new Error('task_invalid_date');
  return date.toISOString();
}

export class TaskService {
  constructor({store,proposalStore,trello,config,policy}) { Object.assign(this,{store,proposalStore,trello,config,policy}); }
  canManage(actor) {
    return !actor.bot && actor.canViewForum && (this.policy.mode==='forum' ||
      (this.policy.mode==='roles' && this.policy.roleIds.some(id=>actor.roles?.includes(id))));
  }
  async context(thread,actor) {
    if(!isTaskThread(thread,this.config) || !snowflake(thread.id) || actor.bot || !actor.canViewForum)throw new Error('task_outside_forum');
    const row=await this.proposalStore.get(thread.id);
    if(!row || row.status!=='succeeded')throw new Error('task_not_synced');
    let id;try{id=JSON.parse(row.ack).trello_card_id;}catch{}
    if(!cardId(id))throw new Error('task_not_synced');
    if(thread.parentId!==this.config.forumId && (row.guild_id!==this.config.guildId || row.forum_id!==thread.parentId))throw new Error('task_not_synced');
    const [board,card]=await Promise.all([this.trello.board(),this.trello.card(id)]);
    if(board.closed || card.closed || card.id!==id || card.idBoard!==board.id ||
        !new RegExp(`(?:^|\\n)CMSFTC_THREAD_ID\\s*=\\s*${thread.id}(?:\\s|$)`).test(card.desc || ''))throw new Error('task_card_mismatch');
    return card;
  }
  async authorize(kind,actor,card) {
    if(kind!=='progress' && this.canManage(actor))return;
    const member=await this.store.member(this.config.guildId,actor.id);
    const owners=discordOwners(card.desc);
    if(kind==='progress' && (owners ? owners.some(o=>o.id===actor.id) : member && card.idMembers.includes(member)))return;
    throw new Error('task_forbidden');
  }
  async mapMember(actor,discordId,trelloId) {
    if(!this.canManage(actor) || !snowflake(discordId) || !cardId(trelloId))throw new Error('task_forbidden');
    const members=await this.trello.members();
    if(!members.some(m=>m.id===trelloId))throw new Error('task_member_not_on_board');
    try{await this.store.map(this.config.guildId,discordId,trelloId);}catch{throw new Error('task_mapping_conflict');}
  }
  async execute({id,thread,actor,kind,input}) {
    if(!snowflake(id) || !['dates','owners','progress','edit','description','status'].includes(kind))throw new Error('task_invalid_action');
    let card=await this.context(thread,actor);await this.authorize(kind,actor,card);
    const old=await this.store.get(id);
    if(old) {
      if(old.actor_id!==actor.id || old.card_id!==card.id || old.kind!==kind)throw new Error('task_invalid_action');
      if(old.state==='succeeded')return JSON.parse(old.result);
      throw new Error('task_pending_review');
    }
    if(await this.store.pending(card.id))throw new Error('task_pending_review');
    let payload;
    if(kind==='status') {
      const lists=await this.trello.lists();
      if(!lists.some(l=>l.id===input.status && !l.closed && l.idBoard===card.idBoard))throw new Error('task_invalid_status');
      payload={idList:input.status};
    } else if(kind==='description') {
      payload={desc:withTaskDescription(card.desc,input.text)};
    } else if(kind==='edit') {
      const ids=[...new Set(input.ids || [])];
      if(!ids.length || ids.length>5 || ids.some(id=>!snowflake(id)))throw new Error('task_invalid_owners');
      const assignees=assigneeIds(input.assigner);
      const person=id=>({id,name:String(input.names?.[id] || id).replace(/[\r\n<>@]/g,' ').slice(0,100)});
      const lists=await this.trello.lists();
      if(!lists.some(l=>l.id===input.status && !l.closed && l.idBoard===card.idBoard))throw new Error('task_invalid_status');
      payload={desc:withDiscordAssigner(withDiscordOwners(card.desc,ids.map(person)),assignees.map(person)),idList:input.status};
      if(input.description!==undefined)payload.desc=withTaskDescription(payload.desc,input.description);
      for(const [key,end] of [['start',false],['due',true]])if(input[key]?.trim())payload[key]=parseDate(input[key].trim(),end);
      const start=payload.start===undefined?card.start:payload.start,due=payload.due===undefined?card.due:payload.due;
      if(start && due && Date.parse(start)>Date.parse(due))throw new Error('task_date_order');
    } else if(kind==='dates') {
      payload={};
      for(const [key,end] of [['start',false],['due',true]])if(input[key]?.trim())payload[key]=parseDate(input[key].trim(),end);
      if(!Object.keys(payload).length)throw new Error('task_empty_update');
      const start=payload.start===undefined?card.start:payload.start;
      const due=payload.due===undefined?card.due:payload.due;
      if(start && due && Date.parse(start)>Date.parse(due))throw new Error('task_date_order');
    } else if(kind==='owners') {
      const ids=[...new Set(input.ids || [])];
      if(!ids.length || ids.length>5 || ids.some(id=>!snowflake(id)))throw new Error('task_invalid_owners');
      const owners=ids.map(id=>({id,name:String(input.names?.[id] || id).replace(/[\r\n<>@]/g,' ').slice(0,100)}));
      payload={desc:withDiscordOwners(card.desc,owners)};
    } else {
      const text=input.text?.trim();
      if(!text || text.length>1800)throw new Error('task_invalid_progress');
      payload={text:`[進度] Discord 使用者 ${actor.id}\n${text}\nCMSFTC_INTERACTION_ID=${id}`};
    }
    try{await this.store.begin(id,card.id,actor.id,kind,payload);}catch{throw new Error('task_pending_review');}
    try {
      // Recheck authorization after acquiring the durable card reservation.
      card=await this.context(thread,actor);await this.authorize(kind,actor,card);
      if(kind==='owners'){payload.desc=withDiscordOwners(card.desc,discordOwners(payload.desc));await this.store.savePayload(id,payload);}
      if(kind==='description'){payload.desc=withTaskDescription(card.desc,input.text);await this.store.savePayload(id,payload);}
      if(kind==='status'){const lists=await this.trello.lists();if(!lists.some(l=>l.id===payload.idList && !l.closed && l.idBoard===card.idBoard))throw new Error('task_invalid_status');}
      if(kind==='edit') {
        const lists=await this.trello.lists();
        if(!lists.some(l=>l.id===payload.idList && !l.closed && l.idBoard===card.idBoard))throw new Error('task_invalid_status');
        const person=id=>({id,name:String(input.names?.[id] || id).replace(/[\r\n<>@]/g,' ').slice(0,100)});
        payload.desc=withDiscordAssigner(withDiscordOwners(card.desc,[...new Set(input.ids)].map(person)),assigneeIds(input.assigner).map(person));
        if(input.description!==undefined)payload.desc=withTaskDescription(payload.desc,input.description);
        await this.store.savePayload(id,payload);
      }
      if(kind==='dates' || kind==='edit') {
        const start=payload.start===undefined?card.start:payload.start;
        const due=payload.due===undefined?card.due:payload.due;
        if(start && due && Date.parse(start)>Date.parse(due))throw new Error('task_date_order');
      }
    } catch(error){await this.store.fail(id);throw error;}
    let result;
    try {
      if(kind==='progress') {
        const action=await this.trello.progress(card.id,payload.text);
        if(!cardId(action.id) || action.data?.card?.id!==card.id || action.data?.text!==payload.text)throw new Error('task_trello_unconfirmed');
        result={kind,card_id:card.id,action_id:action.id,url:card.shortUrl};
      } else {
        const updated=await this.trello.update(card.id,payload);
        if(updated.id!==card.id || updated.idBoard!==card.idBoard ||
            (['owners','description'].includes(kind) && updated.desc!==payload.desc) ||
            (['dates','edit','status'].includes(kind) && Object.keys(payload).some(key=>['start','due'].includes(key)?!sameDate(updated[key] ?? null,payload[key]):updated[key]!==payload[key])))throw new Error('task_trello_unconfirmed');
        result={kind,card_id:card.id,url:card.shortUrl};
      }
      await this.store.finish(id,result);return result;
    } catch(error) {
      if(error.message==='task_trello_rejected')await this.store.fail(id);
      throw error;
    }
  }
  async reconcile(thread,actor) {
    if(!this.canManage(actor))throw new Error('task_forbidden');
    const card=await this.context(thread,actor), pending=await this.store.pending(card.id);
    if(!pending)throw new Error('task_nothing_to_reconcile');
    const payload=JSON.parse(pending.payload);let actionId;
    if(pending.kind==='progress') {
      const actions=await this.trello.comments(card.id,new Date(pending.created_at-1000).toISOString());
      actionId=actions.find(a=>a.data?.text===payload.text && a.data?.card?.id===card.id)?.id;
      if(!cardId(actionId))throw new Error('task_pending_review');
    } else if(pending.kind==='owners') {
      if(payload.desc!==undefined ? card.desc!==payload.desc : !sameMembers(card.idMembers,payload.idMembers))throw new Error('task_pending_review');
    } else if(Object.keys(payload).some(key=>['start','due'].includes(key)?!sameDate(card[key] ?? null,payload[key]):card[key]!==payload[key]))throw new Error('task_pending_review');
    const result={kind:pending.kind,card_id:card.id,url:card.shortUrl,...(actionId?{action_id:actionId}:{})};
    await this.store.finish(pending.interaction_id,result);return result;
  }
}
