import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingStore,MeetingReminder,meetingTimes,meetingChannelId,captainRoleId,meetingCommands,registerMeetings,meetingSummary,meetingEnd } from '../src/meetings.js';

const now=Date.parse('2026-10-16T10:00:00+08:00');
test('location is required, persisted and editable without resetting reminder status',()=>{
  const db=new DatabaseSync(':memory:'),store=new MeetingStore(db);
  for(const location of ['', '  ', 'x'.repeat(201),'教室\n其他'])assert.throws(()=>store.set(meetingChannelId,'2026-10-18','14:30','actor',location,now));
  const row=store.set(meetingChannelId,'2026-10-18','14:30','actor',' 機器人教室 ',now);
  assert.equal(row.location,'機器人教室');assert.match(meetingSummary(row),/地點：機器人教室/);
  db.prepare("UPDATE meetings SET status='sent',message_id='old'").run();
  const edited=store.set(meetingChannelId,'2026-10-18','14:30','actor','線上會議',now);
  assert.equal(edited.location,'線上會議');assert.equal(edited.status,'sent');assert.equal(edited.message_id,'old');db.close();
});
test('existing meeting database migrates without losing its reminder',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE meetings(channel_id TEXT PRIMARY KEY,starts_at INTEGER,remind_at INTEGER,actor_id TEXT,status TEXT,message_id TEXT,attempts INTEGER DEFAULT 0)");
  db.prepare("INSERT INTO meetings(channel_id,starts_at,remind_at,actor_id,status) VALUES(?,?,?,'actor','pending')").run(meetingChannelId,1,2);
  const store=new MeetingStore(db),row=store.get(meetingChannelId);
  assert.equal(row.status,'pending');assert.equal(row.starts_at,1);assert.equal(row.location,'');assert.match(meetingSummary(row),/地點：尚未設定/);
  new MeetingStore(db);db.close();
});
function fixture(send=async()=>({id:'notice'})) {
  const db=new DatabaseSync(':memory:'),store=new MeetingStore(db);
  store.set(meetingChannelId,'2026-10-18','14:30','actor','機器人教室',now);
  const reminder=new MeetingReminder({store,send,verify:async()=>{},log:()=>{},now:()=>Date.parse('2026-10-17T17:00:00+08:00')});
  return {db,store,reminder};
}
test('meeting time is Taipei and reminder is preceding day at 17:00',()=>{
  assert.deepEqual(meetingTimes('2026-10-18','14:30',now),{starts:Date.parse('2026-10-18T06:30:00Z'),remind:Date.parse('2026-10-17T09:00:00Z')});
  assert.equal(meetingTimes('2027-01-01','09:00',now).remind,Date.parse('2026-12-31T09:00:00Z'));
});
test('invalid dates, past meetings and elapsed reminder deadlines are rejected',()=>{
  for(const [d,t] of [['2026-02-30','12:00'],['2026-10-18','24:00'],['2026-10-15','10:00'],['2026-10-16','23:00']])assert.throws(()=>meetingTimes(d,t,now));
});
test('only one reminder, captain role only, without Trello or submission deadline',async()=>{
  const sent=[],{db,store,reminder}=fixture(async p=>{sent.push(p);return {id:'m'};});
  await Promise.all([reminder.tick(),reminder.tick()]);await reminder.tick();
  assert.equal(sent.length,1);assert.deepEqual(sent[0].allowedMentions.roles,[captainRoleId]);
  assert.equal(sent[0].allowedMentions.parse.length,0);assert.match(sent[0].content,/準備各組簡報/);assert.match(sent[0].content,/地點：機器人教室/);
  assert.doesNotMatch(sent[0].content,/trello|截止|繳交/i);assert.equal(store.get(meetingChannelId).status,'sent');db.close();
});
test('does not remind early, cancellation prevents reminders',async()=>{
  let count=0;const {db,store,reminder}=fixture(async()=>{count++;return {id:'m'};});
  reminder.now=()=>now;await reminder.tick();assert.equal(count,0);
  store.cancel(meetingChannelId);reminder.now=()=>Date.parse('2026-10-17T17:00:00+08:00');await reminder.tick();assert.equal(count,0);db.close();
});
test('changed meeting replaces prior schedule; submitting same meeting does not reset success',()=>{
  const {db,store}=fixture();store.db.prepare("UPDATE meetings SET status='sent'").run();
  assert.equal(store.set(meetingChannelId,'2026-10-18','14:30','actor','機器人教室',now).status,'sent');
  assert.equal(store.set(meetingChannelId,'2026-10-20','15:00','actor','機器人教室',now).status,'pending');db.close();
});
test('ambiguous Discord failure is persisted and never automatically resent',async()=>{
  let count=0;const {db,store,reminder}=fixture(async()=>{count++;throw new Error('timeout');});
  await reminder.tick();await reminder.tick();assert.equal(count,1);assert.equal(store.get(meetingChannelId).status,'uncertain');db.close();
});
test('permission failure retries finitely without sending',async()=>{
  let checks=0;const {db,store,reminder}=fixture(()=>assert.fail('must not send'));
  reminder.verify=async()=>{checks++;throw new Error('forbidden');};
  for(let n=0;n<8;n++)await reminder.tick();assert.equal(checks,5);assert.equal(store.get(meetingChannelId).status,'uncertain');db.close();
});
test('offline recovery sends before meeting, skips after meeting',async()=>{
  let count=0;const {db,store,reminder}=fixture(async()=>{count++;return {id:'m'};});
  reminder.now=()=>Date.parse('2026-10-18T09:00:00+08:00');await reminder.tick();assert.equal(count,1);
  store.set(meetingChannelId,'2026-10-20','15:00','actor','機器人教室',now);
  reminder.now=()=>Date.parse('2026-10-20T16:00:00+08:00');await reminder.tick();assert.equal(count,1);assert.equal(store.get(meetingChannelId).status,'missed');db.close();
});
test('success survives database reopen; interrupted send becomes uncertain',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cmsftc-meeting-')),path=join(dir,'test.sqlite');
  try {
    let db=new DatabaseSync(path),store=new MeetingStore(db);
    store.set(meetingChannelId,'2026-10-18','14:30','actor','機器人教室',now);db.prepare("UPDATE meetings SET status='sent'").run();db.close();
    db=new DatabaseSync(path);store=new MeetingStore(db);assert.equal(store.get(meetingChannelId).status,'sent');
    db.prepare("UPDATE meetings SET status='sending'").run();db.close();
    db=new DatabaseSync(path);store=new MeetingStore(db);assert.equal(store.get(meetingChannelId).status,'uncertain');db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('meeting commands serialize and reject other private channels',async()=>{
  for(const c of meetingCommands)assert.ok(c.toJSON().name);
  let handler,reply;const db=new DatabaseSync(':memory:');
  registerMeetings({on:(_,fn)=>{handler=fn;}},{db},{guildId:'guild'},()=>{});
  await handler({isChatInputCommand:()=>true,commandName:'會議設定',guildId:'guild',channelId:'900000000000000010',user:{id:'a'},
    deferReply:async()=>{},editReply:async p=>{reply=p;},reply:async p=>{reply=p;}});
  assert.match(reply.content,/隊長頻道/);assert.equal(new MeetingStore(db).get(meetingChannelId),undefined);db.close();
});
