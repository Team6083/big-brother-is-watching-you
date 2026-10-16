import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {PostgresDatabase,migrate,openDatabase} from '../src/state/database.js';
import {PostgresStore} from '../src/state/queue.js';
import {PostgresTaskStore} from '../src/state/tasks.js';
import {PostgresMeetingStore} from '../src/state/meetings.js';
import {MeetingReminder,meetingChannelId} from '../src/meetings.js';
import {Worker} from '../src/worker.js';
import {Recovery} from '../src/recovery.js';
import {serveHealth} from '../src/health.js';
import {TaskService} from '../src/tasks/service.js';
import {Store} from '../src/store.js';
import {MeetingStore} from '../src/meetings.js';
import {importSqlite} from '../src/state/import-sqlite.js';

test('PostgreSQL storage integration using the PGlite PostgreSQL engine',async t=>{
  const engine=new PGlite();t.after(()=>engine.close());
  const db=new PostgresDatabase(engine);await migrate(db);await migrate(db);
  const queue=new PostgresStore(db),tasks=new PostgresTaskStore(db),meetings=new PostgresMeetingStore(db);
  const guild='900000000000000100',forum='900000000000000101',thread='900000000000000102',actor='900000000000000103';
  const config={guildId:guild,forumId:forum,notify:true};let now=Date.parse('2026-10-16T10:00:00Z');
  await t.test('queue deduplication, leases and token fencing',async()=>{
    assert.equal(await queue.enqueue(thread,config,now),true);assert.equal(await queue.enqueue(thread,config,now),false);
    const row=await queue.claim(config,now);assert.equal(row.thread_id,thread);
    assert.equal(await queue.claim(config,now),undefined);
    await assert.rejects(queue.update({...row,lease_token:'wrong'},{status:'failed'}),/lease_lost/);
    await queue.release(row);
  });
  await t.test('worker awaits durable confirmation before notifying, retries safely',async()=>{
    let calls=0,notified=0;
    const proposal={event_type:'proposal_created',guild_id:guild,forum_channel_id:forum,thread_id:thread,starter_message_id:thread,title:'Synthetic proposal',content:'Synthetic content',author_id:actor,author_name:'Example',created_at:new Date(now).toISOString(),discord_url:`https://discord.com/channels/${guild}/${thread}`,tags:[]};
    const worker=new Worker({store:queue,config,now:()=>now,random:()=>0,log:()=>{},discord:{fetchProposal:async()=>proposal,notify:async()=>{notified++;return {id:actor};}},send:async()=>{calls++;if(calls===1)throw new Error('temporary');return {thread_id:thread,trello_card_id:'a00000000000000000000001',trello_card_url:'https://trello.com/c/example1'};}});
    await worker.tick();assert.equal((await queue.get(thread)).status,'awaiting_confirmation');assert.equal(notified,0);
    now+=120000;await worker.tick();assert.equal((await queue.get(thread)).status,'succeeded');assert.equal(notified,1);assert.equal(calls,2);
    const reopened=new PostgresStore(db);assert.equal(await reopened.enqueue(thread,config,now),false);await worker.tick();assert.equal(calls,2);
  });
  await t.test('task reservations, member mapping and completion are durable',async()=>{
    await tasks.map(guild,actor,'a00000000000000000000001');assert.equal(await tasks.member(guild,actor),'a00000000000000000000001');
    await tasks.begin(thread,'a00000000000000000000002',actor,'status',{idList:'list'});
    await assert.rejects(tasks.begin(actor,'a00000000000000000000002',actor,'status',{}));
    await tasks.finish(thread,{kind:'status'});assert.equal((await tasks.get(thread)).state,'succeeded');
    assert.equal(await tasks.pending('a00000000000000000000002'),undefined);
  });
  await t.test('task service reads confirmed PostgreSQL proposals and awaits updates',async()=>{
    const board='a00000000000000000000003';
    const card={id:'a00000000000000000000001',idBoard:board,idList:'old',idMembers:[],name:'Example',desc:'CMSFTC_THREAD_ID='+thread,closed:false,shortUrl:'https://trello.com/c/example1'};
    const trello={board:async()=>({id:board,closed:false}),card:async()=>({...card}),lists:async()=>[{id:'list',idBoard:board,closed:false}],update:async(_,patch)=>Object.assign(card,patch)};
    const service=new TaskService({store:tasks,proposalStore:queue,trello,config,policy:{mode:'forum'}});
    await service.execute({id:'900000000000000104',thread:{id:thread,guildId:guild,parentId:forum,type:11},actor:{id:actor,canViewForum:true},kind:'status',input:{status:'list'}});
    assert.equal(card.idList,'list');assert.equal((await tasks.get('900000000000000104')).state,'succeeded');
  });
  await t.test('meeting date history, range and record survive fresh store instances',async()=>{
    await meetings.set(meetingChannelId,'2026-10-20','19:00',actor,'Example room',now,'20:30');
    await meetings.setRecord(meetingChannelId,'2026-10-20','https://example.org/notes',actor);
    const reopened=new PostgresMeetingStore(db);assert.deepEqual(await reopened.recordDates(meetingChannelId),['2026-10-20']);
    assert.equal((await reopened.recordForMeeting(await reopened.get(meetingChannelId))).url,'https://example.org/notes');
    let sent=0;const reminder=new MeetingReminder({store:reopened,verify:async()=>{},send:async p=>{sent++;assert.match(p.content,/20:30/);assert.ok(p.content.includes('https://example.org/notes'));return {id:actor};},now:()=>Date.parse('2026-10-19T17:00:00+08:00'),log:()=>{}});
    await reminder.tick();await reminder.tick();assert.equal(sent,1);assert.equal((await reopened.get(meetingChannelId)).status,'sent');
  });
  await t.test('offline recovery checkpoints await writes and survive new instances',async()=>{
    let bounds;
    const recovery=new Recovery({store:queue,config,scan:async(s,u)=>{bounds=[s,u];return [];},log:()=>{},now:()=>now});
    await recovery.tick();assert.deepEqual(bounds,[now,now]);
    now+=300000;await recovery.tick();assert.equal((await db.prepare('SELECT scanned_at FROM forum_recovery WHERE guild_id=? AND forum_id=?').get(guild,forum)).scanned_at,now);
  });
  await t.test('PM delivery SQL is compatible and claims once',async()=>{
    assert.equal((await db.prepare("INSERT OR IGNORE INTO pm_deliveries VALUES(?,'pending',NULL,?)").run('key',now)).changes,1);
    assert.equal((await db.prepare("INSERT OR IGNORE INTO pm_deliveries VALUES(?,'pending',NULL,?)").run('key',now)).changes,0);
    assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_members'").get());
  });
  await t.test('legacy SQLite import preserves dedupe and meeting records, and is safe to repeat',async()=>{
    const legacy=new Store(':memory:');
    try {
      const legacyId='900000000000000290',legacyChannel='900000000000000291';
      legacy.enqueue(legacyId,config,now);
      legacy.db.prepare("UPDATE proposals SET status='succeeded',notification_status='sent' WHERE thread_id=?").run(legacyId);
      const oldMeetings=new MeetingStore(legacy.db);oldMeetings.setRecord(legacyChannel,'2026-10-01','https://example.org/archive',actor);
      await db.exec('BEGIN');const counts=await importSqlite(legacy.db,db);await db.exec('COMMIT');
      assert.equal(counts.proposals,1);assert.equal((await queue.get(legacyId)).notification_status,'sent');
      assert.equal((await meetings.record(legacyChannel,'2026-10-01')).url,'https://example.org/archive');
      const repeated=await importSqlite(legacy.db,db);assert.equal(repeated.proposals,0);assert.equal(repeated.meeting_records,0);
    } finally {legacy.close();}
  });
});

test('health endpoint binds PORT, reports readiness and closes cleanly',async()=>{
  let ready=false;const health=await serveHealth({port:0,host:'127.0.0.1',ready:()=>ready,alive:()=>true});
  try {assert.equal((await fetch(`http://127.0.0.1:${health.port}/healthz`)).status,200);
    assert.equal((await fetch(`http://127.0.0.1:${health.port}/readyz`)).status,503);ready=true;
    assert.equal((await fetch(`http://127.0.0.1:${health.port}/readyz`)).status,200);
  } finally {await health.close();}
});
test('invalid database configuration never echoes connection secrets',async()=>{
  await assert.rejects(openDatabase({DATABASE_URL:'https://user:secret@example.org'}),{message:'invalid_DATABASE_URL'});
});
