import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, renderReport, messageChunks } from '../src/pm/report.js';
import { readBoard } from '../src/pm/trello.js';
import { notifyThreads } from '../src/pm/notify.js';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { TaskStore } from '../src/tasks/store.js';

const now=Date.parse('2026-10-04T10:00:00Z');
const guild='900000000000000008',forum='900000000000000012',thread='900000000000000013';
function sample(){return {board:{id:'board'},fetched_at:new Date(now).toISOString(),
  lists:[{id:'idea',name:'想法'},{id:'doing',name:'進行中'},{id:'review',name:'待審核'},{id:'announcement',name:'待公告'},{id:'decision',name:'待討論'},{id:'done',name:'完成'}],
  members:[{id:'human',fullName:'Mentor'},{id:'automation',fullName:'Automation'}],actions:[],
  cards:[{id:'task',name:'任務',idList:'doing',idMembers:[],labels:[],due:'2026-10-03T10:00:00Z',shortUrl:'https://trello.com/c/abcdefgh',desc:`CMSFTC_THREAD_ID=${thread}`}],};}
test('PM excludes ideas, archived cards and completed due dates from overdue/unassigned warnings',()=>{
  const s=sample();s.cards.push({...s.cards[0],id:'ideaCard',idList:'idea'},{...s.cards[0],id:'closed',closed:true},{...s.cards[0],id:'deadlineDone',dueComplete:true,idMembers:['human']});
  const r=analyze(s,{now});assert.equal(r.overdue.length,1);assert.equal(r.noOwner.length,1);assert.equal(r.unknownProgress.length,2);
});
test('PM does not equate last activity with progress; marked human progress excludes automation',()=>{
  const s=sample();s.cards[0].dateLastActivity='2026-10-04T09:00:00Z';
  s.actions=[{type:'commentCard',idMemberCreator:'human',date:'2026-09-30T10:00:00Z',data:{card:{id:'task'},text:'[進度] 已完成設計'}},{type:'commentCard',idMemberCreator:'automation',date:'2026-10-04T09:00:00Z',data:{card:{id:'task'},text:'[進度] 自動提醒'}}];
  const r=analyze(s,{now,ignoredMembers:['automation']});assert.ok(!r.tasks[0].warnings.some(w=>w.includes('未更新進度')));assert.equal(r.tasks[0].last_progress_update,'2026-09-30T10:00:00Z');
});
test('PM classifies deadline, help, decision, review and announcement using formal data',()=>{
  const s=sample();s.cards[0].due='2026-10-05T10:00:00Z';s.cards[0].idList='announcement';s.cards[0].labels=[{name:'需要協助'}];s.cards.push({...s.cards[0],id:'review',idList:'review'},{...s.cards[0],id:'decision',idList:'decision'});
  const r=analyze(s,{now});assert.equal(r.dueSoon.length,2);assert.equal(r.decision.length,1);assert.equal(r.review.length,1);assert.equal(r.announcement.length,1);assert.ok(r.tasks[0].needs_help);
});
test('weekly completion uses movement time, not last activity or presence in completed list',()=>{
  const s=sample();s.cards[0].idList='done';s.cards[0].dateLastActivity=new Date(now).toISOString();assert.equal(analyze(s,{now}).weeklyDone.length,0);
  s.actions=[{type:'updateCard',date:'2026-10-03T10:00:00Z',data:{card:{id:'task'},listBefore:{name:'進行中'},listAfter:{name:'完成'}}}];assert.equal(analyze(s,{now}).weeklyDone.length,1);
});
test('new proposals need recorded creation action, not arbitrary current cards',()=>{
  const s=sample();assert.equal(analyze(s,{now}).newProposals.length,0);s.actions=[{type:'createCard',date:new Date(now).toISOString(),data:{card:{id:'task'}}}];assert.equal(analyze(s,{now}).newProposals.length,1);
});
test('report preserves unknowns, removes title mentions and bounds Discord chunks',()=>{
  const s=sample();s.cards[0].name='@everyone <@123>\n任務';const r=analyze(s,{now});assert.equal(r.tasks[0].priority,null);const text=renderReport(r,'weekly');assert.ok(!text.includes('https://trello.com'));assert.ok(text.includes('建議下次 Mentor'));assert.ok(!text.includes('@everyone'));assert.ok(messageChunks((text+'\n').repeat(10)).every(c=>c.length<=1800));
});
test('Trello reader uses only GET, header credentials, retries and paginated actions',async()=>{
  let retries=0,pages=0;const s=sample();
  const fetchImpl=async(url,options)=>{assert.equal(options.method,'GET');assert.ok(!url.href.includes('secret'));assert.ok(options.headers.Authorization.includes('secret'));
    const path=url.pathname;if(path.endsWith('/actions')){pages++;return Response.json(pages===1?Array.from({length:1000},(_,i)=>({id:String(i)})):[]);}if(path.endsWith('/cards')){if(!retries++){return new Response('',{status:503});}return Response.json(s.cards);}if(path.endsWith('/lists'))return Response.json(s.lists);if(path.endsWith('/members'))return Response.json(s.members);return Response.json(s.board);};
  const result=await readBoard({boardId:'abcdefgh',key:'secretKey',token:'secretToken'},{fetchImpl,wait:async()=>{},now});assert.equal(result.actions.length,1000);assert.equal(pages,2);assert.equal(retries,2);
});
test('Trello permission failure stops read without exposing response body',async()=>{
  await assert.rejects(readBoard({boardId:'abcdefgh',key:'key',token:'token'},{fetchImpl:async()=>new Response('SECRET',{status:403})}),/pm_trello_http_403/);
});
function config(path){return {guildId:guild,forumId:forum,token:'localTestToken',databasePath:path};}
test('thread reminder sends only to matching forum, suppresses mentions and persists dedupe across restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cmsftc-pm-'));let sends=0;const report=analyze(sample(),{now});
  const fetchImpl=async(url,options)=>{if(options.method==='POST'){sends++;const body=JSON.parse(options.body);assert.ok(!body.content.includes('https://trello.com'));assert.deepEqual(body.allowed_mentions,{parse:[]});return Response.json({id:'900000000000000014'});}return Response.json({guild_id:guild,parent_id:forum,type:11,thread_metadata:{archived:false,locked:false}});};
  try{assert.equal((await notifyThreads(report,config(join(dir,'pm.sqlite')),{fetchImpl,now}))[0].status,'sent');assert.equal((await notifyThreads(report,config(join(dir,'pm.sqlite')),{fetchImpl,now}))[0].status,'sent');assert.equal(sends,1);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('wrong forum and archived threads never receive reminders',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cmsftc-pm-'));const report=analyze(sample(),{now});let sends=0;
  try{const result=await notifyThreads(report,config(join(dir,'pm.sqlite')),{now,fetchImpl:async(url,options)=>{if(options.method==='POST')sends++;return Response.json({guild_id:guild,parent_id:'other',type:11});}});assert.equal(result[0].status,'outside_forum_or_archived');assert.equal(sends,0);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('lost Discord response leaves durable pending review and is not sent again',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cmsftc-pm-'));let sends=0;const report=analyze(sample(),{now});
  const fetchImpl=async(url,options)=>{if(options.method==='POST'){sends++;throw new Error('secret transport detail');}return Response.json({guild_id:guild,parent_id:forum,type:11});};
  try{assert.equal((await notifyThreads(report,config(join(dir,'pm.sqlite')),{fetchImpl,now}))[0].status,'pending_review');assert.equal((await notifyThreads(report,config(join(dir,'pm.sqlite')),{fetchImpl,now}))[0].status,'pending');assert.equal(sends,1);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('reminders mention only explicitly mapped current Trello owners and ignore injected title mentions',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cmsftc-pm-'));const path=join(dir,'pm.sqlite');
  const db=new DatabaseSync(path);const store=new TaskStore(db);const discord='900000000000000006';store.map(guild,discord,'human');db.close();
  const s=sample();s.cards[0].idMembers=['human'];s.cards[0].name='@everyone <@900000000000000020>';const report=analyze(s,{now});let payload;
  try{
    await notifyThreads(report,config(path),{now,fetchImpl:async(url,options)=>{
      if(options.method==='POST'){payload=JSON.parse(options.body);return Response.json({id:'900000000000000014'});}return Response.json({guild_id:guild,parent_id:forum,type:11});
    }});
    assert.deepEqual(payload.allowed_mentions,{parse:[],users:[discord]});assert.ok(payload.content.includes(`<@${discord}>`));assert.ok(!payload.content.includes('@everyone'));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('upgrade preserves legacy help reminder dedupe when no mapped owner exists',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'cmsftc-pm-'));const path=join(dir,'pm.sqlite');const snapshot=sample();snapshot.cards[0].due=null;snapshot.cards[0].labels=[{name:'需要協助'}];const report=analyze(snapshot,{now});const task=report.tasks[0];
  const key=createHash('sha256').update([task.task_id,task.discord_thread_id,'2026-10-04',task.warnings.join('|')].join(':')).digest('hex');
  const db=new DatabaseSync(path);db.exec('CREATE TABLE pm_deliveries(delivery_key TEXT PRIMARY KEY,state TEXT NOT NULL,message_id TEXT,created_at INTEGER NOT NULL)');
  db.prepare("INSERT INTO pm_deliveries VALUES(?,'sent',NULL,?)").run(key,now);db.close();
  try{const result=await notifyThreads(report,config(path),{now,fetchImpl:async()=>{throw Error('must not resend');}});assert.equal(result[0].status,'sent');}finally{rmSync(dir,{recursive:true,force:true});}
});

test('Discord-only owners receive targeted reminders without Trello membership mapping',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cmsftc-pm-'));const report=analyze(sample(),{now});const discord='900000000000000006';report.tasks[0].discord_owner_ids=[discord];let payload;
 try{await notifyThreads(report,config(join(dir,'pm.sqlite')),{now,fetchImpl:async(url,options)=>{
 if(options.method==='POST'){payload=JSON.parse(options.body);return Response.json({id:'900000000000000014'});}return Response.json({guild_id:guild,parent_id:forum,type:11});
 }});assert.deepEqual(payload.allowed_mentions,{parse:[],users:[discord]});assert.ok(payload.content.includes('<@'+discord+'>'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('status-based workflow does not request progress reports and completed tasks stop deadline alerts',()=>{
 const s=sample();s.actions=[{type:'commentCard',idMemberCreator:'human',date:'2026-09-01T10:00:00Z',data:{card:{id:'task'},text:'[進度] 舊紀錄'}}];
 let r=analyze(s,{now});assert.ok(!r.tasks[0].warnings.some(w=>w.includes('未更新')));assert.ok(!renderReport(r).includes('進度更新時間未知'));
 s.cards[0].idList='done';r=analyze(s,{now});assert.equal(r.tasks[0].warnings.length,0);assert.equal(r.overdue.length,0);
});

test('deadline stages honor exact 24 hour, one hour and due boundaries',()=>{
 const s=sample();s.cards[0].due=new Date(now).toISOString();
 for(const [remaining,phase] of [[86400001,null],[86400000,'24h'],[3600001,'24h'],[3600000,'1h'],[1,'1h'],[0,'overdue'],[-1,'overdue']]) {
  const r=analyze(s,{now:now-remaining});assert.equal(r.tasks[0].deadline_phase,phase);
  assert.equal(r.dueSoon.length,phase==='24h'||phase==='1h'?1:0);
 }
 for(const due of [null,'invalid']){s.cards[0].due=due;assert.equal(analyze(s,{now}).tasks[0].deadline_phase,null);}
});

test('deadline sends only three notifications across days and restarts; owner and title edits do not resend',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cmsftc-deadline-'));const path=join(dir,'pm.sqlite');let sends=0;const s=sample();s.cards[0].due=new Date(now+86400000).toISOString();
 const fetchImpl=async(url,options)=>{if(options.method==='POST'){sends++;const p=JSON.parse(options.body);assert.ok(!p.content.includes('https://trello.com'));return Response.json({id:'900000000000000014'});}return Response.json({guild_id:guild,parent_id:forum,type:11});};
 const check=async(time)=>notifyThreads(analyze(s,{now:time}),config(path),{now:time,fetchImpl});
 try{
  await check(now-1);assert.equal(sends,0);
  await check(now);await check(now+60000);assert.equal(sends,1);
  s.cards[0].name='改名';s.cards[0].desc+='\n<!-- CMSFTC_DISCORD_OWNERS_BEGIN -->\n'+JSON.stringify([{id:'900000000000000006',name:'新負責人'}])+'\n<!-- CMSFTC_DISCORD_OWNERS_END -->';
  await check(now+3600000);assert.equal(sends,1);
  await check(now+82800000);await check(now+82860000);assert.equal(sends,2);
  await check(now+86400000);await check(now+3*86400000);assert.equal(sends,3);
  const db=new DatabaseSync(path);assert.equal(db.prepare("SELECT count(*) n FROM pm_deliveries WHERE state='sent'").get().n,3);db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('deadline changes create a fresh reminder schedule and completion suppresses later alerts',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cmsftc-deadline-change-'));const path=join(dir,'pm.sqlite');let sends=0;const s=sample();s.cards[0].due=new Date(now+7200000).toISOString();
 const fetchImpl=async(url,options)=>{if(options.method==='POST'){sends++;return Response.json({id:'900000000000000014'});}return Response.json({guild_id:guild,parent_id:forum,type:11});};
 const check=async()=>notifyThreads(analyze(s,{now}),config(path),{now,fetchImpl});
 try{
  await check();assert.equal(sends,1);s.cards[0].due=new Date(now+10800000).toISOString();await check();assert.equal(sends,2);
  s.cards[0].idList='done';await check();assert.equal(sends,2);s.cards[0].idList='doing';s.cards[0].dueComplete=true;await check();assert.equal(sends,2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('waking after deadline sends only the final stage, without obsolete reminders or daily repeats',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cmsftc-deadline-wake-'));const path=join(dir,'pm.sqlite');const s=sample();let sends=0;
 const fetchImpl=async(url,options)=>{if(options.method==='POST'){sends++;assert.ok(JSON.parse(options.body).content.includes('已逾期'));return Response.json({id:'900000000000000014'});}return Response.json({guild_id:guild,parent_id:forum,type:11});};
 try{
  for(const time of [now,now+86400000])await notifyThreads(analyze(s,{now:time}),config(path),{now:time,fetchImpl});
  assert.equal(sends,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
