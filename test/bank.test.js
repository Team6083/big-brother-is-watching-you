import test from 'node:test';
import assert from 'node:assert/strict';
import {Collection} from 'discord.js';
import {bankConfig,normalizeMissions,readMissions,missionMessage,missionMarker} from '../src/bank/source.js';
import {BankMonitor,bankDiscord} from '../src/bank/monitor.js';

const env={BANK_ENABLED:'true',BANK_BASE_URL:'https://bank.example.org',BANK_CHANNEL_ID:'900000000000000201',DISCORD_GUILD_ID:'900000000000000200'};
const config=bankConfig(env),now=Date.parse('2026-10-23T12:00:00+08:00'),messageId='900000000000000202';
const raw=(id=1,patch={})=>({id,title:'任務 @everyone',description:'工作內容 <@900000000000000203>',reward:50,status:'進行中',startDate:'2026-10-25',deadline:'2026-10-30',category:'Example',level:1,type:'限時',rewardType:'money',rewardItem:'',...patch});
const tasks=rows=>normalizeMissions(rows,config,now);

test('Bank is disabled by default and validates explicit feature configuration',()=>{
  assert.deepEqual(bankConfig({}),{enabled:false});
  for(const patch of [{BANK_ENABLED:'yes'},{BANK_BASE_URL:'http://bank.example.org'},{BANK_BASE_URL:'https://u:p@bank.example.org'},{BANK_BASE_URL:'https://bank.example.org/path'},{BANK_BASE_URL:'https://bank.example.org/?token=private'},{BANK_CHANNEL_ID:''},{DISCORD_GUILD_ID:'bad'},{BANK_INTERVAL_MS:'1000'}])assert.throws(()=>bankConfig({...env,...patch}),/bank_invalid_config/);
  assert.equal(config.intervalMs,60000);assert.equal(bankConfig({...env,BANK_BASE_URL:'https://bank.example.org/'}).sourceKey,config.sourceKey);
  assert.notEqual(bankConfig({...env,BANK_CHANNEL_ID:'900000000000000204'}).sourceKey,config.sourceKey);
});

test('Bank uses stable IDs, Taiwan deadline dates and open status; future start is still announced',()=>{
  const result=tasks([raw(1),raw(2,{status:'截止'}),raw(3,{deadline:'2026-10-22'}),raw(4,{deadline:'2026-10-23'}),raw(5,{deadline:''}),raw(6,{status:'即將截止'})]);
  assert.deepEqual(result.map(t=>t.active),[true,false,false,true,true,true]);assert.equal(result[0].url,'https://bank.example.org/mission/1');
  for(const rows of [{data:[]},[raw(1),raw(1)],[raw(1,{id:'1'})],[raw(1,{deadline:'2026-02-30'})],[raw(1,{description:null})],[raw(1,{reward:NaN})]])assert.throws(()=>tasks(rows),/bank_invalid_response/);
});

test('Bank GET uses the observed public endpoint without credentials and retries temporary failures finitely',async()=>{
  let count=0;const waits=[];
  const result=await readMissions(config,{now,wait:async ms=>{waits.push(ms);},fetchImpl:async(url,options)=>{
    count++;assert.equal(url,'https://bank.example.org/api/gas-read?type=missionsList');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(options.signal);assert.deepEqual(options.headers,{accept:'application/json'});
    return count<3?new Response('',{status:503}):Response.json([raw()]);
  }});
  assert.equal(result.length,1);assert.equal(count,3);assert.deepEqual(waits,[1000,2000]);
  count=0;await assert.rejects(readMissions(config,{wait:async()=>{},fetchImpl:async()=>{count++;throw Error('private upstream details');}}),/bank_api_unavailable/);assert.equal(count,3);
});

test('Bank rejects private/error pages, malformed or oversized JSON, and aborts without retries',async()=>{
  for(const response of [()=>new Response('private',{status:403}),()=>new Response('not JSON'),()=>Response.json({error:'private'}),()=>new Response('x'.repeat(2*1024*1024+1))]) {
    let count=0;await assert.rejects(readMissions(config,{fetchImpl:async()=>{count++;return response();},wait:async()=>{}}),/bank_api_rejected|bank_invalid_response/);assert.equal(count,1);
  }
  const abort=new AbortController();abort.abort();let attempts=0;
  await assert.rejects(readMissions(config,{signal:abort.signal,fetchImpl:async()=>{attempts++;throw Error('aborted');}}),/bank_stopped/);assert.equal(attempts,1);
});

test('Bank announcements bound text and prevent mention injection while preserving the task link',()=>{
  const task=tasks([raw(1,{description:'@everyone '+ 'x'.repeat(5000),rewardType:'item',rewardItem:'Tool'})])[0],payload=missionMessage(task);
  assert.equal(payload.embeds[0].url,'https://bank.example.org/mission/1');assert.ok(payload.embeds[0].description.length<=3000);
  assert.ok(!payload.embeds[0].title.includes('@everyone'));assert.deepEqual(payload.allowedMentions,{parse:[]});assert.equal(payload.embeds[0].footer.text,missionMarker(task));
  assert.equal(payload.embeds[0].fields.at(-1).value,'Tool');
});

class FakeStore {
  initialized=false;rows=new Map();
  async recordSnapshot(source,tasks,now) {
    const initial=!this.initialized;let queued=0;
    for(const task of tasks)if(!this.rows.has(task.id)){const state=initial||!task.active?'ignored':'pending';this.rows.set(task.id,{_id:source+':'+task.id,task_id:task.id,payload:task,state,attempts:0,next_attempt_at:now});if(state==='pending')queued++;}
    this.initialized=true;return {initial,queued};
  }
  async recover() {}
  async uncertain() {return [...this.rows.values()].filter(r=>r.state==='uncertain');}
  async claim(source,now) {const row=[...this.rows.values()].find(r=>r.state==='pending'&&r.next_attempt_at<=now);if(!row)return null;row.state='sending';row.attempts++;return structuredClone(row);}
  async sent(row,id) {Object.assign(this.rows.get(row.task_id),{state:'sent',message_id:id});}
  async finish(row,state,fields) {Object.assign(this.rows.get(row.task_id),{state,...fields});}
}
function fixture() {
  const store=new FakeStore(),logs=[];let rows=[raw()],time=now,posts=0;
  const options={env,store,now:()=>time,log:(event,fields)=>logs.push({event,...fields}),read:async()=>normalizeMissions(rows,config,time),
    discord:{verify:async()=>{},findSent:async()=>[],send:async()=>{posts++;return {id:messageId};}}};
  return {store,options,logs,rows:value=>{rows=value;},advance:ms=>{time+=ms;},posts:()=>posts,monitor:()=>new BankMonitor(options)};
}

test('first snapshot suppresses history; new tasks send once across edits and monitor restarts',async()=>{
  const f=fixture();await f.monitor().tick();assert.equal(f.posts(),0);
  f.rows([raw(1,{title:'Edited'}),raw(2),raw(3,{status:'截止'}),raw(4,{deadline:'2026-10-01'})]);
  await f.monitor().tick();await f.monitor().tick();assert.equal(f.posts(),1);assert.equal(f.store.rows.get('2').state,'sent');assert.equal(f.store.rows.get('3').state,'ignored');
});

test('a bad API or unavailable channel cannot establish the initial baseline',async()=>{
  const f=fixture(),read=f.options.read;
  f.options.read=async()=>{throw Error('bank_api_unavailable');};await f.monitor().tick();assert.equal(f.store.initialized,false);
  f.options.read=read;f.options.discord.verify=async()=>{throw Error('bank_channel_unavailable');};await f.monitor().tick();assert.equal(f.store.initialized,false);assert.equal(f.posts(),0);
});

test('429 retries are bounded and known permission rejection stays failed',async()=>{
  const f=fixture();await f.monitor().tick();f.rows([raw(),raw(2)]);let attempts=0;
  f.options.discord.send=async()=>{attempts++;throw Object.assign(Error('private'),{status:429});};
  for(let n=0;n<6;n++){await f.monitor().tick();f.advance(3600000);}
  assert.equal(attempts,5);assert.equal(f.store.rows.get('2').state,'failed');
  const g=fixture();await g.monitor().tick();g.rows([raw(),raw(2)]);g.options.discord.send=async()=>{throw Object.assign(Error('private'),{status:403});};await g.monitor().tick();assert.equal(g.store.rows.get('2').state,'failed');
});

test('lost send acknowledgment is only reconciled from history, never sent again',async()=>{
  const f=fixture();await f.monitor().tick();f.rows([raw(),raw(2)]);let attempts=0;
  f.options.discord.send=async()=>{attempts++;throw Error('private timeout');};await f.monitor().tick();await f.monitor().tick();assert.equal(attempts,1);assert.equal(f.store.rows.get('2').state,'uncertain');
  f.options.discord.findSent=async rows=>rows.map(row=>({row,id:messageId}));await f.monitor().tick();assert.equal(attempts,1);assert.equal(f.store.rows.get('2').state,'sent');
});

test('tick never overlaps and stop suppresses subsequent work',async()=>{
  const f=fixture();let release,reads=0;
  f.options.read=async()=>{reads++;return new Promise(resolve=>{release=resolve;});};
  const monitor=f.monitor(),pending=monitor.tick();await monitor.tick();assert.equal(reads,1);assert.equal(monitor.running,true);
  monitor.stop();release(tasks([raw()]));await pending;await monitor.tick();assert.equal(monitor.running,false);assert.equal(f.store.initialized,false);assert.equal(reads,1);
  await new BankMonitor({env:{},log:()=>{throw Error('disabled must not log');}}).tick();
});

test('Discord adapter rejects foreign, non-text or forbidden channels and verifies only its own messages',async()=>{
  let channel={guildId:config.guildId,type:0,permissionsFor:()=>({has:()=>true})};
  const client={user:{id:messageId},channels:{fetch:async()=>channel}},adapter=bankDiscord(client,config);
  for(const patch of [{guildId:'other'},{type:15},{permissionsFor:()=>({has:()=>false})}]){const old=channel;channel={...old,...patch};await assert.rejects(adapter.verify(),/bank_channel_unavailable/);channel=old;}
  const task=tasks([raw()])[0],row={_id:'synthetic:1',payload:task};let sent;
  channel.send=async payload=>{sent=payload;return {id:messageId};};await adapter.send(row,task);assert.equal(sent.enforceNonce,true);assert.equal(sent.nonce.length,24);
  channel.messages={fetch:async()=>new Collection([['wrong',{id:'wrong',author:{id:'other'},embeds:sent.embeds}],['right',{id:messageId,author:{id:messageId},embeds:sent.embeds}]])};
  assert.deepEqual(await adapter.findSent([row]),[{row,id:messageId}]);
});
