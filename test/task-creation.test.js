import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskCreationService,creationInput,creationPayload} from '../src/tasks/create-service.js';
import {createTaskCommand,createTaskModal,taskDateCursor,taskDateControls} from '../src/tasks/create-ui.js';
import {registerTeamTaskCreation} from '../src/tasks/create-interactions.js';
import {TaskService} from '../src/tasks/service.js';
import {discordOwners,discordAssigner} from '../src/tasks/owners.js';
import {taskDescription} from '../src/tasks/description.js';

const guild='900000000000000100',channel='900000000000000010',thread='900000000000000102',actor='900000000000000103',owner='900000000000000104',assignee='900000000000000105',id='900000000000000106';
const anotherAssignee='900000000000000107';
const board='aaaaaaaaaaaaaaaaaaaaaaaa',cardId='bbbbbbbbbbbbbbbbbbbbbbbb',list='cccccccccccccccccccccccc';
const input={title:'底盤教學',description:'工作內容：製作教學\n完成標準：講義\n參考資料：無',ids:[owner],assigner:assignee,status:list,start:'2026-11-20',due:'2026-11-28',names:{[owner]:'Owner',[assignee]:'Assignee'}};

// Domain tests use an atomic in-memory fake; real MongoDB receipts are tested separately.
class FakeStore {
  rows=new Map();bindings=new Map();
  async get(id) {return structuredClone(this.rows.get(id));}
  async reserve(row) {if(this.rows.has(row.id))return false;this.rows.set(row.id,{...structuredClone(row),state:'thread_pending',thread_id:null,notification_state:'pending'});return true;}
  async attachThread(id,thread) {Object.assign(this.rows.get(id),{thread_id:thread,state:'card_pending'});}
  async finish(id,card) {const row=this.rows.get(id);Object.assign(row,{state:'succeeded',card_id:card.id});this.bindings.set(row.thread_id,{guild_id:row.guild_id,forum_id:row.channel_id,status:'succeeded',ack:JSON.stringify({trello_card_id:card.id})});}
  async claimNotice(id) {const row=this.rows.get(id);if(row.notification_state!=='pending')return false;row.notification_state='sending';return true;}
  async noticeSent(id,message) {Object.assign(this.rows.get(id),{notification_state:'sent',notification_message_id:message});}
}
function fixture() {
  const store=new FakeStore(),cards=[];let posts=0,threads=0,notices=0;
  const trello={board:async()=>({id:board,closed:false}),lists:async()=>[{id:list,idBoard:board,name:'待執行',closed:false}],
    create:async payload=>{posts++;const card={...payload,id:cardId,idBoard:board,closed:false,shortUrl:'https://trello.com/c/example1'};cards.push(card);return structuredClone(card);},
    cardsForThread:async()=>structuredClone(cards),card:async()=>structuredClone(cards[0])};
  const discord={createThread:async()=>{threads++;return {id:thread,guildId:guild,parentId:channel,type:11};},
    notify:async row=>{notices++;assert.equal((await store.get(row.id)).state,'succeeded');return {id:actor};}};
  const service=new TaskCreationService({store,trello,discord,authorize:async()=>{}});
  return {store,cards,trello,discord,service,op:{id,guild,channel,actor,input:structuredClone(input)},counts:()=>({posts,threads,notices})};
}

test('creation picker has no date text input and respects Discord component limits',()=>{
  const draft={actor,lists:[{id:list,name:'待執行'}]};
  const modal=createTaskModal(id,draft).toJSON();
  assert.deepEqual(modal.components.map(c=>c.component.type),[4,4,5,5,3]);
  assert.equal(modal.components[2].component.max_values,5);
  assert.equal(modal.components[3].component.max_values,5);
  assert.equal(modal.components[3].component.default_values[0].id,actor);
  assert.equal(createTaskCommand.toJSON().name,'建立任務');
  for(const month of [2,4,12])for(const year of [2027,2028])for(const page of [0,1]) {
    const cursor=taskDateCursor('due',`${year}-${String(month).padStart(2,'0')}-01`);cursor.page=page;
    const rows=taskDateControls(id,cursor).map(r=>r.toJSON());
    assert.equal(rows.length,4);assert.ok(rows.slice(0,3).every(r=>r.components[0].options.length<=25));
    const days=rows[2].components[0].options;
    assert.equal(Number(days.at(-1).value.slice(-2)),Math.min(page?31:25,new Date(Date.UTC(year,month,0)).getUTCDate()));
    assert.ok(rows[3].components.some(c=>c.label==='清除這個日期'));
  }
  assert.throws(()=>taskDateControls(id,{...taskDateCursor('start',null),month:13}),/create_invalid_date/);
  assert.throws(()=>taskDateControls(id,{...taskDateCursor('start',null),page:-1}),/create_invalid_date/);
});

test('creation validates dates, order, members and reserved description before side effects',async()=>{
  for(const change of [{due:'2026-02-30'},{due:'2026-11-19'},{ids:[]},{assigner:'bad'},{description:'CMSFTC_THREAD_ID=bad'},{title:'a\nb'},{title:''}]) {
    const f=fixture();await assert.rejects(f.service.create({...f.op,input:{...input,...change}}));assert.deepEqual(f.counts(),{posts:0,threads:0,notices:0});
  }
  assert.equal(creationInput({...input,start:null,due:null}).due,null);
});

test('one confirmed creation binds a thread for existing task controls and survives repeat submission',async()=>{
  const f=fixture();await Promise.all([f.service.create(f.op),f.service.create(f.op).catch(e=>assert.match(e.message,/create_pending|create_thread_uncertain/))]);
  const restarted=new TaskCreationService({...f.service});await restarted.create(f.op);
  assert.deepEqual(f.counts(),{posts:1,threads:1,notices:1});
  const card=f.cards[0];assert.equal(card.start,'2026-11-19T16:00:00.000Z');assert.equal(card.due,'2026-11-28T15:59:00.000Z');
  assert.deepEqual(discordOwners(card.desc),[{id:owner,name:'Owner'}]);assert.equal(discordAssigner(card.desc).id,assignee);assert.equal(taskDescription(card.desc),input.description);
  assert.ok(card.desc.includes(`https://discord.com/channels/${guild}/${thread}`));assert.equal(card.idMembers,undefined);
  const tasks=new TaskService({proposalStore:{get:async id=>f.store.bindings.get(id)},trello:f.trello,config:{guildId:guild,forumId:'900000000000000199'}});
  assert.equal((await tasks.context({id:thread,guildId:guild,parentId:channel,type:11},{id:actor,canViewForum:true})).id,cardId);
});

test('lost Trello response is reconciled by readback after restart without another create',async()=>{
  const f=fixture(),create=f.trello.create;f.trello.create=async p=>{await create(p);throw Error('task_trello_unconfirmed');};
  await assert.rejects(f.service.create(f.op));assert.equal((await f.store.get(id)).state,'card_pending');assert.equal(f.counts().notices,0);
  const restarted=new TaskCreationService({...f.service});await restarted.reconcile(id,{guild_id:guild,channel_id:channel,actor_id:actor});
  assert.deepEqual(f.counts(),{posts:1,threads:1,notices:1});
});

test('unconfirmed or conflicting cards cannot announce success or create again',async()=>{
  for(const kind of ['missing','partial','duplicates']) {
    const f=fixture();const create=f.trello.create;
    f.trello.create=async p=>{if(kind==='missing')throw Error('network');const card=await create(p);if(kind==='partial'){f.cards[0].idList='other';card.idList='other';}if(kind==='duplicates')f.cards.push({...card,id:'dddddddddddddddddddddddd'});throw Error('network');};
    await assert.rejects(f.service.create(f.op));await assert.rejects(f.service.reconcile(id,{guild_id:guild,channel_id:channel,actor_id:actor}),/create_pending/);
    assert.equal(f.counts().notices,0);assert.equal(f.counts().threads,1);assert.ok(f.counts().posts<=1);
  }
});

test('uncertain Discord thread creation is never repeated and never creates a card',async()=>{
  const f=fixture();let attempts=0;f.discord.createThread=async()=>{attempts++;throw Error('timeout');};
  await assert.rejects(f.service.create(f.op));await assert.rejects(new TaskCreationService({...f.service}).create(f.op),/create_thread_uncertain/);
  assert.equal(attempts,1);assert.equal(f.counts().posts,0);
});

test('creation receipts cannot be read or reconciled from another actor, guild or channel',async()=>{
  const f=fixture();await f.service.create(f.op);
  for(const patch of [{guild_id:owner},{channel_id:owner},{actor_id:owner}])await assert.rejects(f.service.reconcile(id,{guild_id:guild,channel_id:channel,actor_id:actor,...patch}),/create_forbidden/);
  assert.equal(f.counts().posts,1);
});

test('lost notice response leaves a durable ambiguous receipt and is never pinged twice',async()=>{
  const f=fixture();let attempts=0;f.discord.notify=async()=>{attempts++;throw Error('timeout');};
  const row=await f.service.create(f.op);assert.equal(row.state,'succeeded');assert.equal(row.notification_state,'sending');
  await new TaskCreationService({...f.service}).reconcile(id,{guild_id:guild,channel_id:channel,actor_id:actor});assert.equal(attempts,1);
});

function interactionFixture(assignees=[assignee]) {
  const f=fixture(),members=new Map([actor,owner,assignee,anotherAssignee].map(id=>[id,{user:{id,bot:false},displayName:id===owner?'Owner':'Assignee',roles:{cache:new Map()}}]));
  let handler,result,modal,actorAllowed=true,targetAllowed=true,botAllowed=true;
  const parent={id:channel,guildId:guild,type:0,permissionsFor:member=>({has:()=>member?.id==='bot'?botAllowed:member.user?.id===actor?actorAllowed:targetAllowed}),
    guild:{members:{fetch:async({user})=>members.get(user)}},threads:{create:async()=>{const created=await f.discord.createThread();channels.set(thread,{...created,send:async payload=>{assert.equal((await f.store.get(id)).state,'succeeded');result.notice=payload;return {id:actor};}});return created;}}};
  const channels=new Map([[channel,parent]]),client={user:{id:'bot'},channels:{fetch:async id=>channels.get(id)},on:(event,h)=>{handler=h;}};
  registerTeamTaskCreation(client,{}, {guildId:guild},()=>{}, {store:f.store,trello:f.trello,policy:{enabled:true,mode:'forum',roleIds:[]},now:()=>Date.parse('2026-10-17T12:00:00+08:00')});
  const base={id,guildId:guild,channelId:channel,channel:parent,member:members.get(actor),user:members.get(actor).user,
    isChatInputCommand:()=>false,isButton:()=>false,isStringSelectMenu:()=>false,isModalSubmit:()=>false,
    deferUpdate:async()=>{},deferReply:async payload=>{result.flags=payload.flags;},editReply:async payload=>{result.reply=payload;},update:async payload=>{result.reply=payload;},reply:async payload=>{result.reply=payload;},showModal:async m=>{modal=m.toJSON();}};
  return {...f,parent,members,get result(){return result;},get modal(){return modal;},setActor:v=>{actorAllowed=v;},setTarget:v=>{targetAllowed=v;},setBot:v=>{botAllowed=v;},
    run:async patch=>{result??={};await handler({...base,...patch});return result.reply;},
    command:()=>({commandName:'建立任務',isChatInputCommand:()=>true,options:{getString:()=>null}}),
    button:action=>({customId:'create_task:'+action+':'+id,isButton:()=>true}),select:(action,value)=>({customId:'create_task:'+action+':'+id,isStringSelectMenu:()=>true,values:[value]}),
    details:()=>({customId:'create_task:details:'+id,isModalSubmit:()=>true,fields:{getField:key=>({values:key==='owners'?[owner]:assignees}),getTextInputValue:key=>key==='title'?input.title:input.description,getStringSelectValues:()=>[list]}})};
}

test('multiple assignees survive preview, editing, card creation and a single targeted notice',async()=>{
  const f=interactionFixture([assignee,owner]);await f.run(f.command());await f.run(f.details());
  assert.match(f.result.reply.content,new RegExp('Assignee：<@'+assignee+'> <@'+owner+'>'));
  assert.deepEqual(f.result.reply.allowedMentions,{parse:[]});assert.equal(f.counts().posts,0);
  await f.run(f.button('edit'));
  assert.deepEqual(f.modal.components[3].component.default_values.map(p=>p.id),[assignee,owner]);
  await f.run(f.button('save'));
  assert.deepEqual(discordAssigner(f.cards[0].desc),[{id:assignee,name:'Assignee'},{id:owner,name:'Owner'}]);
  assert.deepEqual(f.result.notice.allowedMentions.users,[owner,assignee]);
  assert.match(f.result.notice.content,new RegExp('Assignee：<@'+assignee+'> <@'+owner+'>'));
  await f.run(f.button('check'));assert.equal(f.counts().posts,1);
});

test('empty, oversized or invalid assignee lists cannot create a thread or card',async()=>{
  for(const assigner of [[],Array.from({length:6},(_,i)=>'90000000000000012'+i),[assignee,'bad'],[assignee,null]]) {
    const f=fixture();await assert.rejects(f.service.create({...f.op,input:{...input,assigner}}));
    assert.deepEqual(f.counts(),{posts:0,threads:0,notices:0});
  }
});

test('each selected assignee must still be human and authorized when confirming creation',async()=>{
  for(const invalid of ['bot','permissions']) {
    const f=interactionFixture([assignee,anotherAssignee]);await f.run(f.command());await f.run(f.details());
    if(invalid==='bot')f.members.get(anotherAssignee).user.bot=true;
    else {const permissions=f.parent.permissionsFor;f.parent.permissionsFor=member=>member?.user?.id===anotherAssignee?{has:()=>false}:permissions(member);}
    await f.run(f.button('save'));assert.match(f.result.reply.content,/人類成員/);
    assert.equal(f.counts().threads,0);assert.equal(f.counts().posts,0);
  }
});

test('a legacy pending single-assignee receipt reconciles without changing its original card payload',async()=>{
  const f=fixture(),row={id,guild_id:guild,channel_id:channel,actor_id:actor,input:structuredClone(input),thread_id:thread,board_id:board};
  await f.store.reserve(row);await f.store.attachThread(id,thread);
  f.cards.push({...creationPayload(row),id:cardId,idBoard:board,closed:false,shortUrl:'https://trello.com/c/example1'});
  assert.equal(discordAssigner(f.cards[0].desc).id,assignee);
  await f.service.reconcile(id,{guild_id:guild,channel_id:channel,actor_id:actor});
  assert.equal((await f.store.get(id)).state,'succeeded');assert.deepEqual(f.counts(),{posts:0,threads:0,notices:1});
});

test('Discord flow selects dates, previews, creates once, and pings only selected people in the task thread',async()=>{
  const f=interactionFixture();await f.run(f.command());assert.equal(f.result.flags,64);await f.run(f.button('open'));
  assert.equal(f.modal.components.length,5);await f.run(f.details());assert.equal(f.counts().posts,0);
  for(const [field,date] of [['due','2026-11-28'],['start','2026-11-20']]) {
    await f.run(f.button(field));await f.run(f.select('month','11'));
    if(date.endsWith('28'))await f.run(f.button('next'));
    await f.run(f.select('day',date));
  }
  assert.ok(f.result.reply.content.includes('2026-11-20'));assert.ok(f.result.reply.content.includes('2026-11-28'));assert.equal(f.counts().posts,0);
  await f.run(f.button('save'));assert.equal(f.counts().posts,1);assert.ok(f.result.reply.content.includes('<#'+thread+'>'));
  assert.deepEqual(f.result.notice.allowedMentions.users,[owner,assignee]);assert.ok(!JSON.stringify(f.result.reply).includes('trello.com'));
  await f.run(f.button('check'));assert.equal(f.counts().posts,1);
});

test('private channel scope and current permissions stop forbidden task creation',async()=>{
  const f=interactionFixture();await f.run({...f.command(),channel:{...f.parent,id:'900000000000000999'}});assert.ok(f.result.reply.content.includes('隊長／幹部'));assert.equal(f.counts().posts,0);
  await f.run(f.command());await f.run(f.details());f.setActor(false);await f.run(f.button('save'));assert.equal(f.counts().posts,0);assert.equal(f.counts().threads,0);
  const g=interactionFixture();await g.run(g.command());g.setTarget(false);await g.run(g.details());assert.ok(g.result.reply.content.includes('人類成員'));assert.equal(g.counts().threads,0);
  const h=interactionFixture();h.setBot(false);await h.run(h.command());assert.ok(h.result.reply.content.includes('Bot 需要'));assert.equal(h.counts().threads,0);
});

test('date clearing and cancellation do not create any task; stale or foreign forms are rejected',async()=>{
  const f=interactionFixture();await f.run(f.command());await f.run(f.details());await f.run(f.button('due'));await f.run(f.select('day','2026-10-20'));
  await f.run(f.button('due'));await f.run(f.button('clear'));assert.ok(f.result.reply.content.includes('截止：未設定'));
  await f.run({...f.button('save'),user:{id:owner,bot:false}});assert.equal(f.counts().posts,0);
  await f.run(f.button('cancel'));assert.equal(f.counts().threads,0);await f.run(f.button('save'));assert.ok(f.result.reply.content.includes('表單已過期'));
});
