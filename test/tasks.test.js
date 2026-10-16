import {taskDescription,withTaskDescription} from '../src/tasks/description.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore, mappedDiscordOwners } from '../src/tasks/store.js';
import { TaskService, parseDate } from '../src/tasks/service.js';
import { trelloTasks, taskConfig } from '../src/tasks/trello.js';
import { controls, taskModal, editModal, descriptionModal, statusModal, taskView, parseDates, descriptionTemplate, taskCommands, registerTaskInteractions } from '../src/tasks/interactions.js';
import { discordOwners,withDiscordOwners,discordAssigner } from '../src/tasks/owners.js';
import { analyze } from '../src/pm/report.js';

const guild='900000000000000008',forum='900000000000000012',threadId='900000000000000013';
const person='900000000000000006',other='900000000000000007';
const cardId='a00000000000000000000004',memberId='a00000000000000000000005',member2='a00000000000000000000006',boardId='a00000000000000000000007',actionId='a00000000000000000000008';
const operation='900000000000000015';
function fixture(){
  const db=new DatabaseSync(':memory:');const store=new TaskStore(db);store.map(guild,person,memberId);
  const card={id:cardId,idBoard:boardId,idMembers:[memberId],desc:`內容\nCMSFTC_THREAD_ID=${threadId}`,start:null,due:null,shortUrl:'https://trello.com/c/example1',closed:false};
  const thread={id:threadId,guildId:guild,parentId:forum,type:11,archived:false,locked:false};
  const actor={id:person,bot:false,canViewForum:true,roles:[]};
  const writes=[];const comments=[];
  const trello={board:async()=>({id:boardId,closed:false}),card:async()=>structuredClone(card),
    members:async()=>[{id:memberId},{id:member2}],
    update:async(id,patch)=>{writes.push(patch);Object.assign(card,patch);return structuredClone(card);},
    progress:async(id,text)=>{const action={id:actionId,data:{card:{id},text}};comments.push(action);writes.push({text});return action;},
    comments:async()=>comments};
  const config={guildId:guild,forumId:forum};const policy={mode:'forum',roleIds:[]};
  const proposalStore={get:()=>({status:'succeeded',ack:JSON.stringify({trello_card_id:cardId})})};
  const service=new TaskService({store,proposalStore,trello,config,policy});
  return {db,store,card,thread,actor,writes,comments,trello,service,policy,proposalStore};
}
test('task dates use Taipei timezone, valid calendar dates and explicit clearing',()=>{
  assert.equal(parseDate('2026-10-04'),'2026-10-03T16:00:00.000Z');
  assert.equal(parseDate('2026-10-04',true),'2026-10-04T15:59:00.000Z');assert.equal(parseDate('-'),null);
  assert.throws(()=>parseDate('2026-02-30'),/task_invalid_date/);assert.throws(()=>parseDate('明天'),/task_invalid_date/);
});
test('forum manager changes only entered dates and rejects due before start',async()=>{
  const f=fixture();try{
    f.card.due='2026-10-10T15:59:00.000Z';
    await f.service.execute({id:operation,thread:f.thread,actor:f.actor,kind:'dates',input:{start:'2026-10-04',due:''}});
    assert.deepEqual(f.writes,[{start:'2026-10-03T16:00:00.000Z'}]);assert.equal(f.card.due,'2026-10-10T15:59:00.000Z');
    await assert.rejects(f.service.execute({id:'900000000000000016',thread:f.thread,actor:f.actor,kind:'dates',input:{due:'2026-10-01'}}),/task_date_order/);
  }finally{f.db.close();}
});
test('scope verifies thread guild, forum, public type, synced card, board and source marker',async()=>{
  const f=fixture();try{
    for(const patch of [{guildId:'other'},{parentId:'other'},{type:12},{archived:true}])await assert.rejects(f.service.context({...f.thread,...patch},f.actor),/task_outside_forum/);
    f.card.idBoard='other';await assert.rejects(f.service.context(f.thread,f.actor),/task_card_mismatch/);
    f.card.idBoard=boardId;f.card.desc='CMSFTC_THREAD_ID=900000000000000014';await assert.rejects(f.service.context(f.thread,f.actor),/task_card_mismatch/);
    f.proposalStore.get=()=>({status:'pending'});await assert.rejects(f.service.context(f.thread,f.actor),/task_not_synced/);
    assert.equal(f.writes.length,0);
  }finally{f.db.close();}
});
test('dates and assignment require forum view or configured manager roles',async()=>{
  const f=fixture();try{
    await assert.rejects(f.service.execute({id:operation,thread:f.thread,actor:{...f.actor,canViewForum:false},kind:'dates',input:{due:'2026-10-10'}}),/task_outside_forum/);
    f.policy.mode='roles';f.policy.roleIds=[other];
    await assert.rejects(f.service.execute({id:operation,thread:f.thread,actor:f.actor,kind:'dates',input:{due:'2026-10-10'}}),/task_forbidden/);
    await f.service.execute({id:operation,thread:f.thread,actor:{...f.actor,roles:[other]},kind:'dates',input:{due:'2026-10-10'}});
    assert.equal(f.writes.length,1);
  }finally{f.db.close();}
});
test('progress is owner-only even when all forum members may manage dates',async()=>{
  const f=fixture();try{
    await assert.rejects(f.service.execute({id:operation,thread:f.thread,actor:{...f.actor,id:other},kind:'progress',input:{text:'進度'}}),/task_forbidden/);
    const result=await f.service.execute({id:operation,thread:f.thread,actor:f.actor,kind:'progress',input:{text:'已完成設計'}});
    assert.equal(result.action_id,actionId);assert.ok(f.writes[0].text.includes(`CMSFTC_INTERACTION_ID=${operation}`));assert.ok(f.writes[0].text.startsWith('[進度]'));
  }finally{f.db.close();}
});
test('member mapping is explicit, one-to-one, validated against real board members',async()=>{
  const f=fixture();try{
    await assert.rejects(f.service.mapMember(f.actor,other,memberId),/task_mapping_conflict/);
    await assert.rejects(f.service.mapMember(f.actor,other,'a00000000000000000000009'),/task_member_not_on_board/);
    await f.service.mapMember(f.actor,other,member2);assert.equal(f.store.member(guild,other),member2);
    assert.deepEqual(mappedDiscordOwners(f.db,guild,[memberId,member2]),[person,other]);
  }finally{f.db.close();}
});
test('Discord assignment needs no Trello account and preserves native members and proposal text',async()=>{
  const f=fixture();try{
    await f.service.execute({id:operation,thread:f.thread,actor:f.actor,kind:'owners',input:{ids:[other],names:{[other]:'Mentor'}}});
    assert.deepEqual(discordOwners(f.card.desc),[{id:other,name:'Mentor'}]);assert.deepEqual(f.card.idMembers,[memberId]);
    assert.ok(f.card.desc.startsWith('內容\nCMSFTC_THREAD_ID='+threadId));assert.deepEqual(Object.keys(f.writes[0]),['desc']);
    await assert.rejects(f.service.execute({id:'900000000000000016',thread:f.thread,actor:f.actor,kind:'progress',input:{text:'不是負責人'}}),/task_forbidden/);
    await f.service.execute({id:'900000000000000017',thread:f.thread,actor:{...f.actor,id:other},kind:'progress',input:{text:'完成設計'}});
    assert.equal(f.writes.length,2);
  }finally{f.db.close();}
});
test('same interaction receipt survives service restart and progress is not posted twice',async()=>{
  const f=fixture();try{
    const op={id:operation,thread:f.thread,actor:f.actor,kind:'progress',input:{text:'設計完成'}};
    await f.service.execute(op);
    const restarted=new TaskService({...f.service,store:new TaskStore(f.db)});
    await restarted.execute(op);assert.equal(f.writes.length,1);
  }finally{f.db.close();}
});
test('lost Trello reply reserves card until readback reconciles applied date',async()=>{
  const f=fixture();try{
    f.trello.update=async(id,patch)=>{f.writes.push(patch);Object.assign(f.card,patch);throw new Error('task_trello_unconfirmed');};
    await assert.rejects(f.service.execute({id:operation,thread:f.thread,actor:f.actor,kind:'dates',input:{due:'2026-10-10'}}),/task_trello_unconfirmed/);
    await assert.rejects(f.service.execute({id:'900000000000000016',thread:f.thread,actor:f.actor,kind:'dates',input:{due:'2026-10-11'}}),/task_pending_review/);
    await f.service.reconcile(f.thread,f.actor);assert.equal(f.store.get(operation).state,'succeeded');assert.equal(f.writes.length,1);
  }finally{f.db.close();}
});
test('failed progress confirmation is reconciled by exact recorded comment; never posted again',async()=>{
  const f=fixture();try{
    const original=f.trello.progress;f.trello.progress=async(id,text)=>{await original(id,text);throw new Error('task_trello_unconfirmed');};
    await assert.rejects(f.service.execute({id:operation,thread:f.thread,actor:f.actor,kind:'progress',input:{text:'測試'}}),/task_trello_unconfirmed/);
    await f.service.reconcile(f.thread,f.actor);assert.equal(f.store.get(operation).state,'succeeded');assert.equal(f.writes.length,1);
  }finally{f.db.close();}
});
test('definite Trello rejection allows a new operation and never reports success',async()=>{
  const f=fixture();try{
    f.trello.update=async()=>{throw new Error('task_trello_rejected');};
    await assert.rejects(f.service.execute({id:operation,thread:f.thread,actor:f.actor,kind:'dates',input:{due:'2026-10-10'}}),/task_trello_rejected/);
    assert.equal(f.store.get(operation).state,'failed');assert.equal(f.store.pending(cardId),undefined);
  }finally{f.db.close();}
});
test('pending card reservation across SQLite stores prevents concurrent mutations',()=>{
  const f=fixture();try{
    f.store.begin(operation,cardId,person,'dates',{due:null});const otherStore=new TaskStore(f.db);
    assert.throws(()=>otherStore.begin('900000000000000016',cardId,person,'dates',{due:null}));assert.equal(otherStore.pending(cardId).interaction_id,operation);
  }finally{f.db.close();}
});
test('Trello adapter uses separate write header, only bounded intended methods and no write retry',async()=>{
  let count=0;
  const api=trelloTasks({boardId:'testbrd1',key:'fixtureKey',token:'fixtureWriteToken'},{fetchImpl:async(url,options)=>{
    count++;assert.ok(!url.href.includes('fixtureWriteToken'));assert.ok(options.headers.Authorization.includes('fixtureWriteToken'));assert.equal(options.method,'PUT');return new Response('',{status:503});
  }});
  await assert.rejects(api.update(cardId,{due:null}),/task_trello_unconfirmed/);assert.equal(count,1);
});
test('UI uses current label modals, bounded owner select and valid guild command schemas',()=>{
  assert.equal(taskModal('dates').toJSON().components.length,2);assert.throws(()=>taskModal('progress'),/task_progress_retired/);
  assert.equal(controls()[0].toJSON().components.length,4);assert.equal(taskCommands.length,1);assert.ok(taskCommands.every(c=>c.toJSON().name));
  assert.equal(taskConfig({}).enabled,false);assert.throws(()=>taskConfig({TASK_MANAGEMENT_MODE:'roles'}),/task_invalid_management_policy/);
});
test('PM recognizes only confirmed Discord progress receipts even when automation author is excluded',()=>{
  const s={board:{},fetched_at:'2026-10-04T10:00:00Z',lists:[{id:'list',name:'進行中'}],members:[],
    cards:[{id:cardId,name:'任務',idList:'list',idMembers:[],labels:[]}],
    actions:[{id:actionId,type:'commentCard',idMemberCreator:memberId,date:'2026-10-04T09:00:00Z',data:{card:{id:cardId},text:'[進度] 人類更新'}}]};
  const now=Date.parse(s.fetched_at);
  assert.equal(analyze(s,{now,ignoredMembers:[memberId]}).tasks[0].last_progress_update,null);
  assert.equal(analyze(s,{now,trustedProgressActions:[actionId],ignoredMembers:[memberId]}).tasks[0].last_progress_update,'2026-10-04T09:00:00Z');
});
test('interaction handler refuses arbitrary forums before opening forms or writing',async()=>{
  const prior={enabled:process.env.TASK_CONTROLS_ENABLED,mode:process.env.TASK_MANAGEMENT_MODE,board:process.env.TRELLO_BOARD_ID,key:process.env.TRELLO_API_KEY,token:process.env.TRELLO_WRITE_TOKEN};
  Object.assign(process.env,{TASK_CONTROLS_ENABLED:'true',TASK_MANAGEMENT_MODE:'forum',TRELLO_BOARD_ID:'testbrd1',TRELLO_API_KEY:'testKey',TRELLO_WRITE_TOKEN:'testToken'});
  const f=fixture();let handler;let reply;
  try{
    registerTaskInteractions({on:(event,h)=>{handler=h;}},{db:f.db,get:()=>null},{guildId:guild,forumId:forum},()=>{});
    await handler({isChatInputCommand:()=>true,isAutocomplete:()=>false,commandName:'任務',channel:{guildId:guild,parentId:'other',type:11},user:{bot:false},reply:async r=>{reply=r;}});
    assert.ok(reply.content.includes('指定 Mentor'));assert.equal(reply.flags,64);
  }finally{
    for(const [key,value] of Object.entries({TASK_CONTROLS_ENABLED:prior.enabled,TASK_MANAGEMENT_MODE:prior.mode,TRELLO_BOARD_ID:prior.board,TRELLO_API_KEY:prior.key,TRELLO_WRITE_TOKEN:prior.token})){if(value===undefined)delete process.env[key];else process.env[key]=value;}f.db.close();
  }
});

test('Discord owner assignment survives lost response and is reconciled without a second write',async()=>{
 const f=fixture();try{
  f.trello.update=async(id,patch)=>{f.writes.push(patch);Object.assign(f.card,patch);throw Error('task_trello_unconfirmed');};
  await assert.rejects(f.service.execute({id:operation,thread:f.thread,actor:f.actor,kind:'owners',input:{ids:[other]}}),/task_trello_unconfirmed/);
  await f.service.reconcile(f.thread,f.actor);assert.equal(f.store.get(operation).state,'succeeded');assert.equal(f.writes.length,1);
 }finally{f.db.close();}
});
test('Discord owner blocks replace once and reject malformed or duplicate records',()=>{
 const one=withDiscordOwners('original',[{id:person,name:'Mentor'}]);const two=withDiscordOwners(one,[{id:other,name:'Other'}]);
 assert.equal((two.match(/CMSFTC_DISCORD_OWNERS_BEGIN/g)||[]).length,1);assert.deepEqual(discordOwners(two),[{id:other,name:'Other'}]);
 assert.throws(()=>discordOwners(one+'\n'+one),/task_invalid_owners/);
 assert.throws(()=>discordOwners('<!-- CMSFTC_DISCORD_OWNERS_BEGIN -->\ninvalid\n<!-- CMSFTC_DISCORD_OWNERS_END -->'),/task_invalid_owners/);
});
test('PM treats Discord-only assignment as owned and keeps IDs for mentions',()=>{
 const desc=withDiscordOwners('CMSFTC_THREAD_ID='+threadId,[{id:other,name:'Mentor'}]);
 const r=analyze({board:{id:boardId},fetched_at:'2026-10-04T10:00:00Z',lists:[{id:'doing',name:'進行中'}],members:[],actions:[],cards:[{id:cardId,idList:'doing',desc,idMembers:[],name:'Task'}]});
 assert.equal(r.noOwner.length,0);assert.deepEqual(r.tasks[0].discord_owner_ids,[other]);
});

function fullEdit(f){
 const list='a0000000000000000000000a';f.card.idList=list;
 const lists=[{id:list,idBoard:boardId,name:'進行中',closed:false}];f.trello.lists=async()=>lists;
 return {id:operation,thread:f.thread,actor:f.actor,kind:'edit',input:{ids:[other],assigner:person,names:{[person]:'指派者',[other]:'執行者'},start:'2026-10-04',due:'2026-10-10',description:'工作內容與完成標準',status:list}};
}
test('combined form saves owner, assigner, dates and status in one confirmed card update',async()=>{
 const f=fixture();try{
  const op=fullEdit(f);await f.service.execute(op);assert.equal(f.writes.length,1);
  assert.equal(f.card.start,'2026-10-03T16:00:00.000Z');assert.equal(f.card.due,'2026-10-10T15:59:00.000Z');
  assert.equal(taskDescription(f.card.desc),'工作內容與完成標準');assert.deepEqual(discordOwners(f.card.desc),[{id:other,name:'執行者'}]);assert.deepEqual(discordAssigner(f.card.desc),{id:person,name:'指派者'});
  assert.deepEqual(f.card.idMembers,[memberId]);assert.equal(f.card.idList,op.input.status);
  assert.ok(f.card.desc.startsWith('內容\nCMSFTC_THREAD_ID='+threadId));
  await assert.rejects(f.service.execute({...op,id:'900000000000000016',kind:'progress',input:{text:'指派者並非負責人'}}),/task_forbidden/);
  await f.service.execute(op);assert.equal(f.writes.length,1);
 }finally{f.db.close();}
});
test('combined form rejects invalid dates or foreign, archived and missing status before any write',async()=>{
 for(const variant of ['date','order','foreign','closed','missing']) {
  const f=fixture();try{const op=fullEdit(f);
   if(variant==='date')op.input.start='2026-02-30';if(variant==='order')op.input.due='2026-10-01';
   if(variant==='foreign')f.trello.lists=async()=>[{id:op.input.status,idBoard:'other',closed:false}];
   if(variant==='closed')f.trello.lists=async()=>[{id:op.input.status,idBoard:boardId,closed:true}];
   if(variant==='missing')op.input.status='missing';
   await assert.rejects(f.service.execute(op));assert.equal(f.writes.length,0);assert.equal(f.store.pending(cardId),undefined);
  }finally{f.db.close();}
 }
});
test('combined update lost reply is reconciled across service restart without sending again',async()=>{
 const f=fixture();try{const op=fullEdit(f);
  f.trello.update=async(id,patch)=>{f.writes.push(patch);Object.assign(f.card,patch);throw Error('task_trello_unconfirmed');};
  await assert.rejects(f.service.execute(op),/task_trello_unconfirmed/);
  const restarted=new TaskService({...f.service,store:new TaskStore(f.db)});await restarted.reconcile(f.thread,f.actor);
  assert.equal(f.store.get(operation).state,'succeeded');assert.equal(f.writes.length,1);
 }finally{f.db.close();}
});
test('combined update cannot claim success after partial or mismatched acknowledgment',async()=>{
 const f=fixture();try{const op=fullEdit(f);
  f.trello.update=async(id,patch)=>{f.writes.push(patch);f.card.desc=patch.desc;return structuredClone(f.card);};
  await assert.rejects(f.service.execute(op),/task_trello_unconfirmed/);
  await assert.rejects(f.service.reconcile(f.thread,f.actor),/task_pending_review/);
  assert.equal(f.store.get(operation).state,'pending');assert.equal(f.writes.length,1);
 }finally{f.db.close();}
});
test('combined editor refreshes description after reservation and preserves intervening changes',async()=>{
 const f=fixture();try{const op=fullEdit(f);let reads=0;
  f.trello.card=async()=>{if(++reads===2)f.card.desc='最新內容\nCMSFTC_THREAD_ID='+threadId;return structuredClone(f.card);};
  await f.service.execute(op);assert.ok(f.card.desc.startsWith('最新內容\n'));assert.equal(f.writes.length,1);
 }finally{f.db.close();}
});
test('unified Discord modal has five labeled fields, two user pickers, prefilled dates and existing status choices',()=>{
 const f=fixture();try{fullEdit(f);f.card.start='2026-10-03T16:00:00.000Z';
  const lists=[{id:f.card.idList,idBoard:boardId,name:'進行中',closed:false},{id:'a0000000000000000000000b',idBoard:boardId,name:'完成',closed:false},{id:'closed',idBoard:boardId,name:'封存',closed:true}];
  const modal=editModal(f.card,lists,person,operation).toJSON();assert.equal(modal.components.length,5);
  assert.deepEqual(modal.components.map(c=>c.component.type),[5,5,4,3,4]);
  assert.equal(modal.components[1].component.default_values[0].id,person);
  assert.equal(modal.components[2].component.value,'開始：2026-10-04\n截止：');
  assert.equal(modal.components[4].component.value,descriptionTemplate);
  assert.equal(modal.components[3].component.options.length,2);assert.equal(modal.components[3].component.options[0].default,true);
 }finally{f.db.close();}
});

test('command opens unified modal and submit confirms one update before targeted owner notification',async()=>{
 const saved={...process.env},priorFetch=globalThis.fetch,f=fixture();const op=fullEdit(f);let handler,panel,modal,confirmation,puts=0;
 Object.assign(process.env,{TASK_CONTROLS_ENABLED:'true',TASK_MANAGEMENT_MODE:'forum',TRELLO_BOARD_ID:'testbrd1',TRELLO_API_KEY:'testKey',TRELLO_WRITE_TOKEN:'testToken'});
 globalThis.fetch=async(url,options)=>{
  const path=new URL(url).pathname;
  if(options.method==='PUT'){puts++;Object.assign(f.card,JSON.parse(options.body));return Response.json(f.card);}
  if(path.endsWith('/lists'))return Response.json(await f.trello.lists());
  if(path.includes('/cards/'))return Response.json(f.card);
  return Response.json({id:boardId,closed:false});
 };
 try{
  registerTaskInteractions({on:(event,h)=>{handler=h;}},{db:f.db,get:f.proposalStore.get},{guildId:guild,forumId:forum},()=>{});
  const channel={...f.thread,permissionsFor:()=>({has:()=>true}),guild:{members:{fetch:async({user})=>({user:{id:user,bot:false},displayName:user===person?'指派者':'執行者'})}}};
  const base={channel,user:{id:person,bot:false},member:{roles:{cache:{map:()=>[]}}},isAutocomplete:()=>false,isUserSelectMenu:()=>false};
  await handler({...base,id:operation,commandName:'任務',isChatInputCommand:()=>true,isButton:()=>false,deferReply:async()=>{},editReply:async p=>{panel=p;}});
  assert.ok(!panel.content.includes('https://trello.com'));assert.ok(panel.content.includes('負責人：尚未設定'));
  const custom=panel.components[0].toJSON().components.find(c=>c.custom_id.startsWith('task:edit:')).custom_id;
  await handler({...base,customId:custom,isChatInputCommand:()=>false,isButton:()=>true,showModal:async m=>{modal=m.toJSON();}});
  assert.equal(modal.components.length,5);assert.equal(puts,0);
  await handler({...base,id:'900000000000000019',customId:modal.custom_id,isChatInputCommand:()=>false,isButton:()=>false,isModalSubmit:()=>true,
   fields:{getField:key=>({values:key==='owners'?[other]:[person]}),getTextInputValue:key=>key==='dates'?'開始：'+op.input.start+'\n截止：'+op.input.due:op.input.description,getStringSelectValues:()=>[op.input.status]},
   deferReply:async()=>{},editReply:async p=>{confirmation=p;}});
  assert.equal(puts,1);assert.equal(confirmation.content,'✅ 任務人員、日期、狀態與描述已更新至 Trello。\nOwner：<@'+other+'>｜Assignee：指派者');assert.deepEqual(confirmation.allowedMentions.users,[other]);
  let viewed,privateFlag;
  await handler({...base,customId:'task:view',isChatInputCommand:()=>false,isButton:()=>true,
   deferReply:async p=>{privateFlag=p.flags;},editReply:async p=>{viewed=p;}});
  assert.ok(!JSON.stringify(viewed).includes('https://trello.com'));
  assert.equal(puts,1);assert.equal(privateFlag,64);assert.equal(viewed.embeds[0].description,'工作內容與完成標準');assert.deepEqual(viewed.allowedMentions,{parse:[]});
  f.card.desc=withDiscordOwners(f.card.desc,[{id:other,name:'執行者'},{id:person,name:'協作 Mentor'}]);
  await handler({...base,id:'900000000000000018',commandName:'任務',isChatInputCommand:()=>true,isButton:()=>false,deferReply:async()=>{},editReply:async p=>{panel=p;}});
  assert.ok(panel.content.includes('負責人：執行者、協作 Mentor'));assert.deepEqual(panel.allowedMentions,{parse:[]});assert.equal(puts,1);

 }finally{globalThis.fetch=priorFetch;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);f.db.close();}
});

test('description updates preserve original proposal, owners, assigner, dates and native members',async()=>{
 const f=fixture();try{const edit=fullEdit(f);await f.service.execute(edit);const before=structuredClone(f.card);
  await f.service.execute({id:'900000000000000016',thread:f.thread,actor:f.actor,kind:'description',input:{text:'工作內容：製作教學\n完成標準：影片與講義\n參考：https://example.com'}});
  assert.ok(f.card.desc.startsWith('內容\nCMSFTC_THREAD_ID='+threadId));assert.deepEqual(discordOwners(f.card.desc),discordOwners(before.desc));assert.deepEqual(discordAssigner(f.card.desc),discordAssigner(before.desc));
  for(const key of ['idMembers','start','due','idList'])assert.deepEqual(f.card[key],before[key]);
  assert.deepEqual(Object.keys(f.writes[1]),['desc']);assert.ok(taskDescription(f.card.desc).includes('完成標準'));
 }finally{f.db.close();}
});
test('description replacement preserves literal dollar text and clearing affects only the description block',()=>{
 const one=withTaskDescription('原始提案','第一次');const two=withTaskDescription(one,'$& $1 更新');
 assert.equal(taskDescription(two),'$& $1 更新');assert.equal((two.match(/CMSFTC_TASK_DESCRIPTION_BEGIN/g)||[]).length,1);
 assert.equal(taskDescription(withTaskDescription(two,'')),'');assert.ok(withTaskDescription(two,'').startsWith('原始提案'));
 assert.throws(()=>taskDescription(one+one),/task_invalid_description_block/);
});
test('invalid or reserved description content never sends a card update',async()=>{
 for(const text of ['a'.repeat(4001),'CMSFTC_THREAD_ID=900000000000000014','<!-- CMSFTC_DISCORD_OWNERS_BEGIN -->']){
  const f=fixture();try{await assert.rejects(f.service.execute({id:operation,thread:f.thread,actor:f.actor,kind:'description',input:{text}}),/task_invalid_description/);assert.equal(f.writes.length,0);}finally{f.db.close();}
 }
});
test('description permission follows forum management policy and rechecks current proposal text',async()=>{
 const f=fixture();try{f.policy.mode='roles';f.policy.roleIds=[other];
 const op={id:operation,thread:f.thread,actor:f.actor,kind:'description',input:{text:'新描述'}};
 await assert.rejects(f.service.execute(op),/task_forbidden/);f.policy.mode='forum';let reads=0;
 f.trello.card=async()=>{if(++reads===2)f.card.desc='修改後原文\nCMSFTC_THREAD_ID='+threadId;return structuredClone(f.card);};
 await f.service.execute(op);assert.ok(f.card.desc.startsWith('修改後原文\n'));
 }finally{f.db.close();}
});
test('description lost response survives restart and reconciles without duplicating update',async()=>{
 const f=fixture();try{const op={id:operation,thread:f.thread,actor:f.actor,kind:'description',input:{text:'測試描述'}};
 f.trello.update=async(id,patch)=>{f.writes.push(patch);Object.assign(f.card,patch);throw Error('task_trello_unconfirmed');};
 await assert.rejects(f.service.execute(op),/task_trello_unconfirmed/);
 const restarted=new TaskService({...f.service,store:new TaskStore(f.db)});await restarted.reconcile(f.thread,f.actor);await restarted.execute(op);
 assert.equal(f.writes.length,1);assert.equal(f.store.get(operation).state,'succeeded');
 }finally{f.db.close();}
});
test('description cannot report success without exact card acknowledgment',async()=>{
 const f=fixture();try{f.trello.update=async()=>structuredClone(f.card);
 await assert.rejects(f.service.execute({id:operation,thread:f.thread,actor:f.actor,kind:'description',input:{text:'測試描述'}}),/task_trello_unconfirmed/);
 assert.equal(f.store.get(operation).state,'pending');await assert.rejects(f.service.reconcile(f.thread,f.actor),/task_pending_review/);
 }finally{f.db.close();}
});
test('description modal uses one prefilled multiline field and supports explicit clearing',()=>{
 const modal=descriptionModal({desc:withTaskDescription('原文','既有描述')},operation).toJSON();
 assert.equal(modal.components.length,1);assert.equal(modal.components[0].component.value,'既有描述');assert.equal(modal.components[0].component.required,false);assert.equal(modal.components[0].component.max_length,4000);
 assert.ok(!controls(operation)[0].toJSON().components.some(c=>c.label==='編輯任務描述'));
});

test('new description form prefills a usable template without changing proposal text',()=>{
 const card={desc:'原始提案'};const modal=descriptionModal(card,operation).toJSON();
 assert.equal(modal.components[0].component.value,descriptionTemplate);assert.ok(descriptionTemplate.includes('工作內容：'));assert.ok(descriptionTemplate.includes('完成標準：'));assert.ok(descriptionTemplate.includes('參考資料／連結'));assert.equal(card.desc,'原始提案');
});
test('explicitly cleared description stays empty rather than being replaced with a template',()=>{
 const modal=descriptionModal({desc:withTaskDescription('原文','')},operation).toJSON();assert.equal(modal.components[0].component.value,undefined);
});

test('status-only update changes one field without requiring owners, dates or progress',async()=>{
 const f=fixture();try{const op=fullEdit(f);f.card.idMembers=[];const before=structuredClone(f.card);
 await f.service.execute({...op,kind:'status',input:{status:op.input.status}});assert.deepEqual(f.writes,[{idList:op.input.status}]);
 for(const key of ['desc','start','due','idMembers'])assert.deepEqual(f.card[key],before[key]);
 }finally{f.db.close();}
});
test('invalid status-only selection cannot write and ambiguous status update is reconciled safely',async()=>{
 const f=fixture();try{const edit=fullEdit(f);const op={...edit,kind:'status',input:{status:edit.input.status}};
 await assert.rejects(f.service.execute({...op,input:{status:'unknown'}}),/task_invalid_status/);assert.equal(f.writes.length,0);
 f.trello.update=async(id,patch)=>{f.writes.push(patch);Object.assign(f.card,patch);throw Error('task_trello_unconfirmed');};
 await assert.rejects(f.service.execute(op),/task_trello_unconfirmed/);await f.service.reconcile(f.thread,f.actor);assert.equal(f.writes.length,1);
 }finally{f.db.close();}
});
test('status modal is a single existing-list selector and task panel no longer offers progress input',()=>{
 const f=fixture();try{fullEdit(f);const modal=statusModal(f.card,[{id:f.card.idList,idBoard:boardId,name:'進行中'}],operation).toJSON();
 assert.equal(modal.components.length,1);assert.equal(modal.components[0].component.type,3);
 const buttons=controls(operation)[0].toJSON().components;assert.ok(buttons.some(c=>c.label==='更新狀態'));assert.ok(!buttons.some(c=>c.label==='更新進度'));
 }finally{f.db.close();}
});
test('retired progress buttons direct users to status updates without accessing Trello',async()=>{
 const saved={...process.env},f=fixture();let handler,reply;
 Object.assign(process.env,{TASK_CONTROLS_ENABLED:'true',TASK_MANAGEMENT_MODE:'forum',TRELLO_BOARD_ID:'testbrd1',TRELLO_API_KEY:'testKey',TRELLO_WRITE_TOKEN:'testToken'});
 try{registerTaskInteractions({on:(event,h)=>{handler=h;}},{db:f.db,get:()=>{throw Error('must not read proposal');}},{guildId:guild,forumId:forum},()=>{});
 await handler({customId:'task:progress',isChatInputCommand:()=>false,isButton:()=>true,isAutocomplete:()=>false,
 channel:{...f.thread,permissionsFor:()=>({has:()=>true})},user:{id:person,bot:false},member:{roles:{cache:{map:()=>[]}}},reply:async p=>{reply=p;}});
 assert.ok(reply.content.includes('更新狀態'));assert.equal(f.writes.length,0);
 }finally{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);f.db.close();}
});

test('task view shows complete description, people, dates and latest status without unsafe mentions',()=>{
 const f=fixture();try{fullEdit(f);f.card.name='任務';f.card.start='2026-10-03T16:00:00Z';f.card.due='2026-10-05T15:59:00Z';
 const desc='工作內容：\n'+ 'a'.repeat(3800)+'\n@everyone';f.card.desc=withTaskDescription(f.card.desc,desc);
 const view=taskView(f.card,[{id:f.card.idList,name:'進行中'}]);assert.ok(view.description.includes('a'.repeat(3800)));assert.ok(!view.description.includes('@everyone'));assert.ok(view.fields.some(field=>field.value==='進行中'));assert.ok(view.fields[2].value.includes('2026'));assert.equal(view.title,'任務');
 assert.ok(controls(operation)[0].toJSON().components.some(c=>c.label==='查看任務'));
 }finally{f.db.close();}
});

test('combined date field accepts prefilled or empty values and rejects malformed or duplicate labels',()=>{
 assert.deepEqual(parseDates('開始：2026-10-04\n截止：2026-10-10'),{start:'2026-10-04',due:'2026-10-10'});
 assert.deepEqual(parseDates('開始日期: -\n截止：'),{start:'-',due:''});assert.deepEqual(parseDates(''),{});
 assert.throws(()=>parseDates('2026-10-04'),/task_invalid_date_format/);assert.throws(()=>parseDates('開始：\n開始：'),/task_invalid_date_format/);
});

test('invalid description in task settings prevents all personnel, date and status changes',async()=>{
 const f=fixture();try{const op=fullEdit(f);op.input.description='x'.repeat(4001);await assert.rejects(f.service.execute(op),/task_invalid_description/);assert.equal(f.writes.length,0);assert.equal(f.store.pending(cardId),undefined);}finally{f.db.close();}
});
