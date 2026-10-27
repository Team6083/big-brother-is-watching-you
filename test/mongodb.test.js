import test from 'node:test';
import assert from 'node:assert/strict';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import {MongoDatabase,openDatabase,migrate} from '../src/state/database.js';
import {MongoStore} from '../src/state/queue.js';
import {MongoTaskStore} from '../src/state/tasks.js';
import {MongoMeetingStore} from '../src/state/meetings.js';
import {MongoDeliveryStore} from '../src/state/deliveries.js';
import {meetingChannelId,MeetingReminder} from '../src/meetings.js';
import {Worker} from '../src/worker.js';
import {Recovery} from '../src/recovery.js';
import {TaskService} from '../src/tasks/service.js';
import {notifyThreads} from '../src/pm/notify.js';
import {serveHealth} from '../src/health.js';
import {MongoCreationStore} from '../src/state/creations.js';
import {TaskCreationService} from '../src/tasks/create-service.js';
import {migrationFailure} from '../src/state/diagnostics.js';
import {MongoBankStore} from '../src/state/bank.js';
import {BankMonitor} from '../src/bank/monitor.js';
import {bankConfig,normalizeMissions} from '../src/bank/source.js';

test('MongoDB replica-set integration', {timeout:360000},async t=>{
  const replica=await MongoMemoryReplSet.create({binary:{version:process.env.MONGOMS_VERSION||'8.0.17'},instanceOpts:[{launchTimeout:60000}],replSet:{count:1,storageEngine:'wiredTiger',spawn:{windowsHide:true},auth:{enable:true,customRootName:'test_root',customRootPwd:'test-root-password'}}});
  let db;
  t.after(async()=>{await db?.close();await replica.stop();});
  const rootUri=replica.getUri('bot_test').replace('mongodb://','mongodb://test_root:test-root-password@')+'&authSource=admin';
  db=await openDatabase({MONGODB_URI:rootUri});
  assert.equal(db.database.databaseName,'bot_test');
  assert.ok(db instanceof MongoDatabase);await migrate(db);await migrate(db);await db.check();
  const queue=new MongoStore(db),tasks=new MongoTaskStore(db),meetings=new MongoMeetingStore(db);
  const guild='900000000000000100',forum='900000000000000101',thread='900000000000000102',actor='900000000000000103';
  const config={guildId:guild,forumId:forum,notify:true};let now=Date.parse('2026-10-16T10:00:00Z');
  await t.test('database readWrite role can initialize, check and transact without admin privileges',async()=>{
    await db.client.db('limited_test').command({createUser:'test_app',pwd:'test-app-password',roles:[{role:'readWrite',db:'limited_test'}]});
    const uri=replica.getUri('limited_test').replace('mongodb://','mongodb://test_app:test-app-password@')+'&authSource=limited_test';
    const limited=await openDatabase({MONGODB_URI:uri});
    try {
      assert.equal(limited.database.databaseName,'limited_test');
      await migrate(limited);await limited.check();
      await new MongoMeetingStore(limited).set(meetingChannelId,'2026-10-20','19:00',actor,'Room',now,'20:00');
      await assert.rejects(limited.client.db('admin').command({usersInfo:1}),error=>error.code===13);
    }finally{await limited.close();}
  });
  await t.test('real authentication failure reports code 18 without URI or password',async()=>{
    const uri=replica.getUri('bot_test').replace('mongodb://','mongodb://test_root:synthetic_wrong_password@')+'&authSource=admin';
    await assert.rejects(openDatabase({MONGODB_URI:uri}),error=>{
      const output=migrationFailure(error);assert.equal(output.code,'mongodb_unavailable');assert.equal(output.stage,'connect');assert.equal(output.mongo_code,18);assert.equal(output.reason,'authentication_failed');
      assert.ok(!JSON.stringify(output).includes('synthetic_wrong_password'));assert.ok(!JSON.stringify(output).includes('test_root'));return true;
    });
  });
  await t.test('real read-only user migration reports the collection and code 13',async()=>{
    await db.client.db('migration_read_only').command({createUser:'migration_reader',pwd:'synthetic_read_password',roles:[{role:'read',db:'migration_read_only'}]});
    const uri=replica.getUri('migration_read_only').replace('mongodb://','mongodb://migration_reader:synthetic_read_password@')+'&authSource=migration_read_only';
    const limited=await openDatabase({MONGODB_URI:uri});
    try {await assert.rejects(migrate(limited),error=>{
      const output=migrationFailure(error);assert.equal(output.stage,'create_collection');assert.equal(output.collection,'proposals');assert.equal(output.mongo_code,13);assert.equal(output.reason,'authorization_failed');
      assert.ok(!JSON.stringify(output).includes('migration_reader'));assert.ok(!JSON.stringify(output).includes('migration_read_only'));return true;
    });}finally{await limited.close();}
  });
  await t.test('real conflicting index is diagnosed and never dropped',async()=>{
    const uri=replica.getUri('migration_conflict').replace('mongodb://','mongodb://test_root:test-root-password@')+'&authSource=admin';
    const conflict=await openDatabase({MONGODB_URI:uri});
    try {
      await conflict.collection('task_members').createIndex({guild_id:1,trello_id:1},{name:'member_trello_unique'});
      await assert.rejects(migrate(conflict),error=>{
        const output=migrationFailure(error);assert.equal(output.stage,'create_index');assert.equal(output.collection,'task_members');assert.equal(output.index,'member_trello_unique');assert.equal(output.reason,'index_conflict');return true;
      });
      const indexes=await conflict.collection('task_members').listIndexes().toArray();assert.equal(indexes.find(i=>i.name==='member_trello_unique').unique,undefined);
    }finally{await conflict.close();}
  });
  await t.test('real duplicate data prevents a unique index and document values stay private',async()=>{
    const uri=replica.getUri('migration_duplicates').replace('mongodb://','mongodb://test_root:test-root-password@')+'&authSource=admin';
    const duplicates=await openDatabase({MONGODB_URI:uri});
    try {
      await duplicates.collection('task_members').insertMany([{_id:'one',guild_id:'synthetic_guild',trello_id:'private_duplicate_value'},{_id:'two',guild_id:'synthetic_guild',trello_id:'private_duplicate_value'}]);
      await assert.rejects(migrate(duplicates),error=>{
        const output=migrationFailure(error);assert.equal(output.stage,'create_index');assert.equal(output.index,'member_trello_unique');assert.equal(output.mongo_code,11000);assert.equal(output.reason,'duplicate_key');assert.ok(!JSON.stringify(output).includes('private_duplicate_value'));return true;
      });
      assert.equal(await duplicates.collection('task_members').countDocuments(),2);
    }finally{await duplicates.close();}
  });
  await t.test('concurrent enqueue, atomic claim and lease fencing prevent duplicates',async()=>{
    const added=await Promise.all([queue.enqueue(thread,config,now),queue.enqueue(thread,config,now)]);assert.equal(added.filter(Boolean).length,1);
    const claimed=await Promise.all([queue.claim(config,now),queue.claim(config,now)]),row=claimed.find(Boolean);assert.equal(claimed.filter(Boolean).length,1);
    await assert.rejects(queue.update({...row,lease_token:'wrong'},{status:'failed'}),/lease_lost/);
    await assert.rejects(queue.update(row,{status:'invalid'}),/invalid_store_update/);await queue.release(row);
  });
  await t.test('Make retry is durable; only a confirmed card triggers a reply',async()=>{
    let sends=0,replies=0;
    const proposal={event_type:'proposal_created',guild_id:guild,forum_channel_id:forum,thread_id:thread,starter_message_id:thread,title:'Example',content:'Synthetic',author_id:actor,author_name:'Example',created_at:new Date(now).toISOString(),discord_url:`https://discord.com/channels/${guild}/${thread}`,tags:[]};
    const worker=new Worker({store:queue,config,now:()=>now,random:()=>0,log:()=>{},discord:{fetchProposal:async()=>proposal,notify:async()=>{replies++;return {id:actor};}},send:async()=>{sends++;if(sends===1)throw new Error('temporary');return {thread_id:thread,trello_card_id:'aaaaaaaaaaaaaaaaaaaaaaaa',trello_card_url:'https://trello.com/c/example1'};}});
    await worker.tick();assert.equal((await queue.get(thread)).status,'awaiting_confirmation');assert.equal(replies,0);
    now+=120000;await worker.tick();assert.equal((await queue.get(thread)).status,'succeeded');assert.equal(replies,1);
    assert.equal(await new MongoStore(db).enqueue(thread,config,now),false);await worker.tick();assert.equal(sends,2);
  });
  await t.test('partial unique index protects task changes and member mappings',async()=>{
    await tasks.map(guild,actor,'aaaaaaaaaaaaaaaaaaaaaaaa');assert.equal(await tasks.member(guild,actor),'aaaaaaaaaaaaaaaaaaaaaaaa');
    await assert.rejects(tasks.map(guild,'900000000000000104','aaaaaaaaaaaaaaaaaaaaaaaa'),error=>error.code===11000);
    await tasks.begin('one','bbbbbbbbbbbbbbbbbbbbbbbb',actor,'status',{idList:'list'});
    await assert.rejects(tasks.begin('two','bbbbbbbbbbbbbbbbbbbbbbbb',actor,'status',{}),error=>error.code===11000);
    await tasks.finish('one',{kind:'status'});assert.equal(await tasks.pending('bbbbbbbbbbbbbbbbbbbbbbbb'),undefined);
  });
  await t.test('task service confirms updates using MongoDB state',async()=>{
    const board='cccccccccccccccccccccccc',card={id:'aaaaaaaaaaaaaaaaaaaaaaaa',idBoard:board,idList:'old',idMembers:[],name:'Example',desc:'CMSFTC_THREAD_ID='+thread,closed:false,shortUrl:'https://trello.com/c/example1'};
    const trello={board:async()=>({id:board,closed:false}),card:async()=>({...card}),lists:async()=>[{id:'list',idBoard:board,closed:false}],update:async(_,patch)=>Object.assign(card,patch)};
    const service=new TaskService({store:tasks,proposalStore:queue,trello,config,policy:{mode:'forum'}});
    await service.execute({id:'900000000000000105',thread:{id:thread,guildId:guild,parentId:forum,type:11},actor:{id:actor,canViewForum:true},kind:'status',input:{status:'list'}});
    assert.equal(card.idList,'list');assert.equal((await tasks.get('900000000000000105')).state,'succeeded');
  });
  await t.test('meetings use transactions for dates, cancellation, and record history',async()=>{
    await meetings.set(meetingChannelId,'2026-10-20','19:00',actor,'Room',now,'20:30');
    await meetings.setRecord(meetingChannelId,'2026-10-20','https://example.org/notes',actor);
    assert.equal((await new MongoMeetingStore(db).recordForMeeting(await meetings.get(meetingChannelId))).url,'https://example.org/notes');
    await meetings.set(meetingChannelId,'2026-10-22','19:00',actor,'Room',now,'20:30');
    assert.deepEqual(await meetings.recordDates(meetingChannelId),['2026-10-22','2026-10-20']);
    await meetings.cancel(meetingChannelId,now);assert.deepEqual(await meetings.recordDates(meetingChannelId),['2026-10-20']);
    await assert.rejects(db.transaction(async session=>{await db.collection('meeting_dates').insertOne({_id:'rollback',channel_id:meetingChannelId,meeting_date:'2026-10-30'},{session});throw new Error('rollback');}));
    assert.equal(await db.collection('meeting_dates').findOne({_id:'rollback'}),null);
  });
  await t.test('meeting edits after the reminder keep MongoDB receipts and rescheduling updates the date transactionally',async()=>{
    const id='900000000000000188',initial=Date.parse('2026-10-23T10:00:00+08:00'),editAt=Date.parse('2026-10-25T19:00:00+08:00');
    await meetings.set(id,'2026-10-26','16:00',actor,'Room',initial,'17:30');
    const claimed=await meetings.claim(await meetings.get(id));await meetings.markSent(claimed,actor);
    await meetings.set(id,'2026-10-26','19:00',actor,'New room',editAt,'20:30');
    const edited=await new MongoMeetingStore(db).get(id);
    assert.equal(edited.starts_at,Date.parse('2026-10-26T19:00:00+08:00'));assert.equal(edited.status,'sent');assert.equal(edited.message_id,actor);
    assert.deepEqual(await meetings.recordDates(id),['2026-10-26']);
    await assert.rejects(meetings.set(id,'2026-10-26','18:00',actor,'Stale edit',editAt,'20:30',claimed),/會議資料已變更/);
    assert.equal((await meetings.get(id)).location,'New room');
    const moved=await meetings.set(id,'2026-10-27','19:00',actor,'New room',editAt,'20:30');
    assert.equal(moved.status,'pending');assert.equal(moved.message_id,null);assert.equal(moved.remind_at,Date.parse('2026-10-26T17:00:00+08:00'));
    assert.deepEqual(await meetings.recordDates(id),['2026-10-27']);
  });
  await t.test('combined MongoDB meeting and record saves roll back together; cancellation preserves history and rejects stale edits',async()=>{
    const id='900000000000000187',at=Date.parse('2026-10-25T10:00:00+08:00');
    const combined=new MongoMeetingStore(db),row=await combined.set(id,'2026-10-27','16:00',actor,'Room',at,'17:30',undefined,'https://example.org/first');
    assert.equal((await combined.record(id,'2026-10-27')).url,'https://example.org/first');
    const update=combined.records.updateOne;
    combined.records.updateOne=async()=>{throw Error('synthetic record failure');};
    try{await assert.rejects(combined.set(id,'2026-10-28','16:00',actor,'Changed',at,'17:30',row,'https://example.org/new'),/synthetic record failure/);}
    finally{combined.records.updateOne=update;}
    assert.deepEqual(await combined.get(id),row);assert.deepEqual(await combined.recordDates(id),['2026-10-27']);
    assert.equal(await combined.record(id,'2026-10-28'),undefined);
    const moved=await combined.set(id,'2026-10-28','16:00',actor,'Changed',at,'17:30',row,'https://example.org/new');
    await assert.rejects(combined.cancel(id,at,row),/會議資料已變更/);
    await combined.claim(moved);await assert.rejects(combined.cancel(id,at,moved),/提醒正在發送/);
    await combined.recoverSending(id);await combined.cancel(id,at,moved);
    assert.equal((await combined.get(id)).status,'cancelled');assert.deepEqual(await combined.recordDates(id),['2026-10-28','2026-10-27']);
    await combined.setRecord(id,'2026-10-28','',actor);assert.equal(await combined.record(id,'2026-10-28'),undefined);
  });
  await t.test('meeting notices send once; uncertain sends survive reconnect',async()=>{
    await meetings.set(meetingChannelId,'2026-10-20','19:00',actor,'Room',now,'20:30');let sent=0;
    const reminder=new MeetingReminder({store:meetings,verify:async()=>{},send:async p=>{sent++;assert.match(p.content,/20:30/);return {id:actor};},now:()=>Date.parse('2026-10-19T17:00:00+08:00'),log:()=>{}});
    await reminder.tick();await reminder.tick();assert.equal(sent,1);
    await meetings.set(meetingChannelId,'2026-10-23','19:00',actor,'Room',now,'20:00');
    await meetings.claim(await meetings.get(meetingChannelId));
    await assert.rejects(meetings.cancel(meetingChannelId,now),/提醒正在發送/);
    await assert.rejects(meetings.set(meetingChannelId,'2026-10-24','19:00',actor,'Room',now,'20:00'),/提醒正在發送/);
    await meetings.recoverSending(meetingChannelId);assert.equal((await meetings.get(meetingChannelId)).status,'uncertain');
  });
  await t.test('recovery checkpoint survives a fresh store and never moves backwards',async()=>{
    const recovery=new Recovery({store:queue,config,scan:async()=>[],log:()=>{},now:()=>now});await recovery.tick();
    assert.equal((await new MongoStore(db).recoveryCheckpoint(config)).scanned_at,now);
    await queue.advanceRecovery(config,now-1000);assert.equal((await queue.recoveryCheckpoint(config)).scanned_at,now);
  });
  await t.test('recovery retries a transient database failure without losing activation time',async()=>{
    const scope={...config,forumId:'900000000000000199'};let fail=true,scans=0;
    const store={db:db,recoveryCheckpoint:async c=>{if(fail){fail=false;throw new Error('temporary');}return queue.recoveryCheckpoint(c);},initializeRecovery:(...args)=>queue.initializeRecovery(...args),advanceRecovery:(...args)=>queue.advanceRecovery(...args)};
    const recovery=new Recovery({store,config:scope,scan:async()=>{scans++;return [];},log:()=>{},now:()=>now});
    await recovery.tick(true);await recovery.tick(true);assert.equal(scans,1);assert.equal((await queue.recoveryCheckpoint(scope)).started_at,now);
  });
  await t.test('PM delivery claims are atomic and notifications share the same database',async()=>{
    const deliveries=new MongoDeliveryStore(db),claims=await Promise.all([deliveries.claim('same',now),deliveries.claim('same',now)]);assert.equal(claims.filter(Boolean).length,1);
    let posts=0;
    const report={fetched_at:new Date(now).toISOString(),tasks:[{task_id:'aaaaaaaaaaaaaaaaaaaaaaaa',title:'Example',warnings:['已逾期'],discord_thread_id:thread,deadline_phase:'overdue',due_date:new Date(now-1).toISOString(),discord_owner_ids:[actor]}]};
    const fetchImpl=async(_,options)=>{if(options.method==='POST'){posts++;return new Response(JSON.stringify({id:actor}));}return new Response(JSON.stringify({guild_id:guild,parent_id:forum,type:11,thread_metadata:{}}));};
    await notifyThreads(report,{guildId:guild,forumId:forum,token:'test-only'},{state:db,fetchImpl,now});
    await notifyThreads(report,{guildId:guild,forumId:forum,token:'test-only'},{state:db,fetchImpl,now});assert.equal(posts,1);
  });
  await t.test('team creation receipts persist, reconcile lost replies and bind existing task controls and PM',async()=>{
    const creation=new MongoCreationStore(db),parent='900000000000000010',teamThread='900000000000000120',operation='900000000000000121';
    const board='eeeeeeeeeeeeeeeeeeeeeeee',list='ffffffffffffffffffffffff';let writes=0,pings=0,threads=0;const cards=[];
    const trello={board:async()=>({id:board}),lists:async()=>[{id:list,idBoard:board,name:'待執行'}],card:async()=>cards[0],cardsForThread:async()=>cards,
      create:async payload=>{writes++;cards.push({...payload,id:'dddddddddddddddddddddddd',idBoard:board,shortUrl:'https://trello.com/c/example2',closed:false});throw Error('task_trello_unconfirmed');}};
    const discord={createThread:async()=>{threads++;return {id:teamThread,guildId:guild,parentId:parent,type:11};},notify:async()=>{pings++;return {id:actor};}};
    const service=new TaskCreationService({store:creation,trello,discord,authorize:async()=>{}});
    const op={id:operation,guild,channel:parent,actor,input:{title:'Team task',description:'Synthetic',ids:[actor],assigner:[actor,'900000000000000122'],status:list,due:'2026-10-20'}};
    await assert.rejects(service.create(op));assert.equal((await creation.get(operation)).state,'card_pending');assert.equal(pings,0);
    assert.deepEqual((await new MongoCreationStore(db).get(operation)).input.assigner,op.input.assigner);
    const restarted=new TaskCreationService({...service,store:new MongoCreationStore(db)});
    await Promise.all([restarted.reconcile(operation,{guild_id:guild,channel_id:parent,actor_id:actor}),restarted.reconcile(operation,{guild_id:guild,channel_id:parent,actor_id:actor})]);
    assert.equal(writes,1);assert.equal(threads,1);assert.equal(pings,1);
    assert.equal((await queue.get(teamThread)).status,'succeeded');
    const controls=new TaskService({store:tasks,proposalStore:queue,trello,config,policy:{mode:'forum'}});
    assert.equal((await controls.context({id:teamThread,guildId:guild,parentId:parent,type:11},{id:actor,canViewForum:true})).id,cards[0].id);
    assert.equal(await new MongoDeliveryStore(db).isBoundTask(guild,parent,teamThread,cards[0].id),true);
    assert.equal(await new MongoDeliveryStore(db).isBoundTask(guild,forum,teamThread,cards[0].id),false);
    let sends=0,locked=true;
    const report={fetched_at:new Date(now).toISOString(),tasks:[{task_id:cards[0].id,title:'Team task',warnings:['已逾期'],deadline_phase:'overdue',due_date:'2026-10-20T15:59:00Z',discord_thread_id:teamThread,discord_owner_ids:[actor]}]};
    const fetchImpl=async(_,options)=>{if(options.method==='POST'){sends++;return Response.json({id:actor});}return Response.json({guild_id:guild,parent_id:parent,type:11,thread_metadata:{archived:true,locked}});};
    await notifyThreads(report,{guildId:guild,forumId:forum,token:'test-only'},{state:db,now,fetchImpl});assert.equal(sends,0);
    locked=false;await notifyThreads(report,{guildId:guild,forumId:forum,token:'test-only'},{state:db,now,fetchImpl});
    assert.equal(sends,1);
  });
  await t.test('team creation reservation is atomic and failed binding transaction cannot mark success',async()=>{
    const creation=new MongoCreationStore(db),id='900000000000000130',teamThread='900000000000000131';
    const row={id,guild_id:guild,channel_id:'900000000000000010',actor_id:actor,input:{}};
    const results=await Promise.all([creation.reserve(row),new MongoCreationStore(db).reserve(row)]);assert.equal(results.filter(Boolean).length,1);
    await creation.attachThread(id,teamThread);await db.collection('proposals').insertOne({_id:teamThread,guild_id:guild,forum_id:forum,status:'pending'});
    await assert.rejects(creation.finish(id,{id:'dddddddddddddddddddddddd',shortUrl:'https://trello.com/c/example2'}),/create_binding_conflict/);
    assert.equal((await creation.get(id)).state,'card_pending');assert.equal((await queue.get(teamThread)).status,'pending');
  });
  await t.test('Bank baseline, atomic claim and receipts survive store and monitor restarts',async()=>{
    const bank=new MongoBankStore(db),source='synthetic_bank_source',tasks=[{id:'1',active:true,url:'https://bank.example.org/mission/1'}];
    assert.deepEqual(await bank.recordSnapshot(source,tasks,now),{initial:true,queued:0});assert.equal(await bank.claim(source,now),null);
    tasks.push({id:'2',active:true,url:'https://bank.example.org/mission/2'});
    assert.deepEqual(await bank.recordSnapshot(source,tasks,now),{initial:false,queued:1});
    const claims=await Promise.all([bank.claim(source,now),new MongoBankStore(db).claim(source,now)]);assert.equal(claims.filter(Boolean).length,1);
    const row=claims.find(Boolean);await bank.sent(row,actor);assert.equal(await new MongoBankStore(db).claim(source,now),null);
    assert.deepEqual(await bank.recordSnapshot(source,tasks.map(t=>({...t,title:'Updated'})),now),{initial:false,queued:0});
    const env={BANK_ENABLED:'true',BANK_BASE_URL:'https://bank.example.org',BANK_CHANNEL_ID:'900000000000000180',DISCORD_GUILD_ID:guild};
    let current=[tasks[0]],sends=0;
    const options={state:db,env,log:()=>{},now:()=>now,read:async()=>current,discord:{verify:async()=>{},findSent:async()=>[],send:async()=>{sends++;return {id:actor};}}};
    await new BankMonitor(options).tick();assert.equal(sends,0);current=tasks;
    await new BankMonitor(options).tick();await new BankMonitor(options).tick();assert.equal(sends,1);
  });
  await t.test('Bank keeps unready tasks across restart and sends once only after start and open status',async()=>{
    const env={BANK_ENABLED:'true',BANK_BASE_URL:'https://bank.example.org',BANK_CHANNEL_ID:'900000000000000182',DISCORD_GUILD_ID:guild},config=bankConfig(env);
    const raw=id=>({id,title:'Synthetic',description:'Test',category:'Example',type:'限時',status:'',startDate:'2026-10-28',deadline:'2026-10-29',reward:1,rewardType:'money',rewardItem:''});
    let time=Date.parse('2026-10-27T23:59:59+08:00'),rows=[raw(1)],posts=0;
    const options={state:db,env,log:()=>{},now:()=>time,read:async()=>normalizeMissions(rows,config,time),
      discord:{verify:async()=>{},findSent:async()=>[],send:async()=>{posts++;return {id:actor};}}};
    await new BankMonitor(options).tick();rows.push(raw(2));await new BankMonitor(options).tick();
    const taskId='task:'+config.sourceKey+':2',stored=()=>db.collection('bank_notifications').findOne({_id:taskId});
    assert.equal((await stored()).state,'waiting');assert.equal(posts,0);
    rows[1].status='進行中';await new BankMonitor(options).tick();assert.equal((await stored()).state,'waiting');assert.equal(posts,0);
    time=Date.parse('2026-10-28T00:00:00+08:00');rows[1].status='即將開始';
    await new BankMonitor(options).tick();assert.equal(posts,0);
    rows.forEach(row=>{row.status='進行中';});await new BankMonitor(options).tick();await new BankMonitor(options).tick();
    assert.equal(posts,1);assert.equal((await stored()).state,'sent');
    assert.equal((await db.collection('bank_notifications').findOne({_id:'task:'+config.sourceKey+':1'})).state,'ignored');
    rows.push({...raw(3),startDate:'2026-10-29'});await new BankMonitor(options).tick();
    time=Date.parse('2026-10-30T00:00:00+08:00');await new BankMonitor(options).tick();
    assert.equal((await db.collection('bank_notifications').findOne({_id:'task:'+config.sourceKey+':3'})).state,'ignored');assert.equal(posts,1);
    rows[2].status='進行中';rows[2].deadline='2026-10-31';await new BankMonitor(options).tick();assert.equal(posts,1);
  });
  await t.test('Bank recovers legacy unready ignores without replaying baseline, closed or delivery receipts',async()=>{
    const bank=new MongoBankStore(db),source='synthetic_bank_legacy_waiting',started=Date.parse('2026-10-28T00:00:00+08:00');
    const payload=id=>({id:String(id),status:'',startDate:'2026-10-28',deadline:'2026-10-30',active:false});
    await bank.recordSnapshot(source,[payload(1)],now);
    const states=['ignored','ignored','ignored','ignored','sent','uncertain','failed'];
    await db.collection('bank_notifications').insertMany(states.map((state,index)=>({
      _id:'task:'+source+':'+(index+2),kind:'task',source_key:source,task_id:String(index+2),state,
      payload:{...payload(index+2),status:['','未發布','即將開始','截止','','',''][index]},
      attempts:0,next_attempt_at:now,lease_until:0,created_at:now,message_id:null,last_error:null,
    })));
    const open=Array.from({length:8},(_,i)=>({...payload(i+1),status:'進行中',active:true,waiting:false}));
    assert.deepEqual(await bank.recordSnapshot(source,open,started),{initial:false,queued:3});
    assert.deepEqual(await new MongoBankStore(db).recordSnapshot(source,open,started),{initial:false,queued:0});
    for(const [id,state] of [[1,'ignored'],[2,'pending'],[3,'pending'],[4,'pending'],[5,'ignored'],[6,'sent'],[7,'uncertain'],[8,'failed']])
      assert.equal((await db.collection('bank_notifications').findOne({_id:'task:'+source+':'+id})).state,state);
    const claims=await Promise.all([bank.claim(source,started),new MongoBankStore(db).claim(source,started)]);
    assert.equal(new Set(claims.map(row=>row._id)).size,2);
  });
  await t.test('Bank restart reconciles ambiguous sends by history without another POST',async()=>{
    const env={BANK_ENABLED:'true',BANK_BASE_URL:'https://bank.example.org',BANK_CHANNEL_ID:'900000000000000181',DISCORD_GUILD_ID:guild};
    let current=[],posts=0;
    const options={state:db,env,log:()=>{},now:()=>now,read:async()=>current,discord:{verify:async()=>{},findSent:async rows=>rows.map(row=>({row,id:actor})),send:async()=>{posts++;throw Error('lost acknowledgment');}}};
    await new BankMonitor(options).tick();current=[{id:'3',active:true,url:'https://bank.example.org/mission/3'}];
    await new BankMonitor(options).tick();assert.equal(posts,1);
    await new BankMonitor(options).tick();assert.equal(posts,1);
    const rows=await db.collection('bank_notifications').find({task_id:'3',source_key:bankConfig(env).sourceKey}).toArray();assert.equal(rows[0].state,'sent');assert.equal(rows[0].message_id,actor);
  });
  await t.test('Bank interrupted send is recovered only after lease expiry',async()=>{
    const bank=new MongoBankStore(db),source='synthetic_bank_crash';
    await bank.recordSnapshot(source,[],now);await bank.recordSnapshot(source,[{id:'4',active:true}],now);
    const row=await bank.claim(source,now);await bank.recover(source,now+119999);assert.equal((await bank.uncertain(source)).length,0);
    await bank.recover(source,now+120000);assert.equal((await bank.uncertain(source)).length,1);assert.equal(await bank.claim(source,now+120000),null);
    await bank.sent(row,actor);assert.equal((await bank.uncertain(source)).length,0);
  });
});

test('health listener reports readiness and closes cleanly',async()=>{
  let ready=false;const health=await serveHealth({port:0,host:'127.0.0.1',ready:()=>ready,alive:()=>true});
  try {assert.equal((await fetch(`http://127.0.0.1:${health.port}/healthz`)).status,200);assert.equal((await fetch(`http://127.0.0.1:${health.port}/readyz`)).status,503);ready=true;assert.equal((await fetch(`http://127.0.0.1:${health.port}/readyz`)).status,200);}finally{await health.close();}
});
test('invalid MongoDB settings never expose credentials',async()=>{
  for(const uri of [undefined,'https://user:secret@example.org','mongodb://user:secret@','mongodb://localhost/?replicaSet=rs0','mongodb://localhost/test','mongodb+srv://example.org/?authSource=admin','mongodb+srv://example.org/test','mongodb://localhost/bad%20name','mongodb://localhost/'+ 'a'.repeat(64)]) {
    await assert.rejects(openDatabase({MONGODB_URI:uri}),{message:'invalid_mongodb_config'});
  }
});
