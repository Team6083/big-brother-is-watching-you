import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {registerTaskInteractions} from '../src/tasks/interactions.js';

const guild='900000000000000008',parentId='900000000000000011',threadId='900000000000000013',actor='900000000000000006';
const cardId='a00000000000000000000004',boardId='a00000000000000000000007';
function fixture() {
  const db=new DatabaseSync(':memory:'),saved={...process.env},priorFetch=globalThis.fetch;
  Object.assign(process.env,{TASK_CONTROLS_ENABLED:'true',TASK_MANAGEMENT_MODE:'roles',TASK_MANAGER_ROLE_IDS:'900000000000000007',TEAM_CHANNEL_ACCESS_ENABLED:'true',TRELLO_BOARD_ID:'testbrd1',TRELLO_API_KEY:'testKey',TRELLO_WRITE_TOKEN:'testToken'});
  const parent={id:parentId,guildId:guild,type:0,permissionsFor:()=>({has:()=>true})};
  const thread={id:threadId,guildId:guild,type:11,parentId,permissionsFor:()=>({has:()=>true})};
  const binding={status:'succeeded',guild_id:guild,forum_id:parentId,ack:JSON.stringify({trello_card_id:cardId})};
  const card={id:cardId,idBoard:boardId,name:'Bound task',idList:cardId,idMembers:[],desc:'CMSFTC_THREAD_ID='+threadId,closed:false};
  let handler,reply,modal,fetches=0,writes=0,failFetch=false,bound=true;
  globalThis.fetch=()=>assert.fail('task handler must not use HTTP');
  const register=()=>registerTaskInteractions({on:(_,h)=>{handler=h;},channels:{fetch:async(id,options)=>{
    fetches++;assert.notEqual(options?.force,true);if(failFetch)throw Object.assign(Error('unknown channel'),{code:10003});return thread;
  }}},{db,get:id=>bound&&id===threadId?binding:undefined},{guildId:guild,forumId:'900000000000000012'},()=>{},{tasks:{board:async()=>({id:boardId,closed:false}),card:async()=>card,lists:async()=>[{id:cardId,idBoard:boardId,name:'Open'}]}});
  register();
  const run=async patch=>{
    reply=undefined;modal=undefined;
    const i={id:'900000000000000015',channel:parent,guildId:guild,user:{id:actor,bot:false},member:{roles:{cache:{map:()=>[]}}},
      isChatInputCommand:()=>false,isButton:()=>false,isModalSubmit:()=>false,isAutocomplete:()=>false,
      deferReply:async()=>{i.deferred=true;},reply:async p=>{reply=p;},editReply:async p=>{reply=p;},showModal:async m=>{modal=m.toJSON();},...patch};
    await handler(i);return {reply,modal};
  };
  const command=(value,channel=parent)=>run({channel,commandName:'任務',isChatInputCommand:()=>true,options:{getString:()=>value}});
  return {command,run,register,thread,parent,card,binding,get fetches(){return fetches;},get writes(){return writes;},setFailFetch:v=>{failFetch=v;},setBound:v=>{bound=v;},
    close:()=>{globalThis.fetch=priorFetch;for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);db.close();}};
}

test('task links accept Discord stable, PTB, Canary and message links with query strings',async()=>{
 const f=fixture();try {
  for(const value of [threadId,...['discord.com','ptb.discord.com','canary.discord.com'].map(host=>'https://'+host+'/channels/'+guild+'/'+threadId+'/900000000000000016?jump=1#message')]) {
    assert.match((await f.command(value)).reply.content,/Bound task/);
  }
  for(const value of ['task name','https://example.com/channels/'+guild+'/'+threadId,'https://discord.com/channels/'+guild+'/'+threadId+' extra']) {
    assert.match((await f.command(value)).reply.content,/連結或 ID/);
  }
  assert.equal(f.writes,0);
 }finally{f.close();}
});
test('unbound IDs never fetch Discord and missing channels return the task-scope error',async()=>{
 const f=fixture();try {
  assert.match((await f.command('900000000000000099')).reply.content,/指定 Mentor/);assert.equal(f.fetches,0);
  f.setFailFetch(true);assert.match((await f.command(threadId)).reply.content,/指定 Mentor/);assert.equal(f.fetches,1);
 }finally{f.close();}
});
test('team View and Reconcile survive restart and still recheck binding and permissions',async()=>{
 const f=fixture();try {
  const panel=(await f.command(threadId)).reply;
  const buttons=panel.components[0].toJSON().components;
  const view=buttons.find(b=>b.label==='查看任務').custom_id,reconcile=buttons.find(b=>b.label==='核對未確認更新').custom_id;
  f.register();
  assert.equal((await f.run({customId:view,isButton:()=>true})).reply.embeds[0].title,'Bound task');
  assert.match((await f.run({customId:reconcile,isButton:()=>true})).reply.content,/沒有待核對/);
  f.thread.permissionsFor=()=>({has:()=>false});assert.match((await f.run({customId:reconcile,isButton:()=>true})).reply.content,/授權成員/);
  f.thread.permissionsFor=()=>({has:()=>true});f.setBound(false);
  assert.match((await f.run({customId:view,isButton:()=>true})).reply.content,/指定 Mentor/);
  assert.equal(f.writes,0);
 }finally{f.close();}
});
test('task thread commands reject a different target instead of silently ignoring it',async()=>{
 const f=fixture();try {
  assert.match((await f.command('900000000000000099',f.thread)).reply.content,/目前討論串/);
  assert.match((await f.command(threadId,f.thread)).reply.content,/Bound task/);
  assert.equal(f.writes,0);
 }finally{f.close();}
});
