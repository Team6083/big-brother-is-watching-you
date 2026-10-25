import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MeetingStore,MeetingReminder,meetingChannelId,recordDate,recordLink,registerMeetings} from '../src/meetings.js';

const link='https://docs.google.com/document/d/example/edit';
test('records accept calendar dates and HTTPS URLs without fetching them',()=>{
  assert.equal(recordDate('2024-02-29'),'2024-02-29');assert.equal(recordLink(link),link);
  for(const date of ['2026-02-29','2026-13-01','2026-1-2','not-a-date'])assert.throws(()=>recordDate(date));
  for(const url of ['javascript:alert(1)','http://example.com','https://user:password@example.com','https://example.com\n@everyone','<https://example.com>','https://example.com/'+ '中'.repeat(200)])assert.throws(()=>recordLink(url));
});
test('records survive restart; changing a date does not overwrite previous meetings',()=>{
  const dir=mkdtempSync(join(tmpdir(),'cmsftc-records-')),file=join(dir,'test.sqlite');let db;
  try {
    db=new DatabaseSync(file);let store=new MeetingStore(db);
    store.setRecord(meetingChannelId,'2026-10-01',link,'actor');
    store.setRecord(meetingChannelId,'2026-10-15','https://example.com/second','actor');
    store.setRecord(meetingChannelId,'2026-10-15','https://example.com/revised','actor');db.close();
    db=new DatabaseSync(file);store=new MeetingStore(db);
    assert.equal(store.record(meetingChannelId,'2026-10-01').url,link);
    assert.equal(store.record(meetingChannelId,'2026-10-15').url,'https://example.com/revised');
    assert.equal(store.record(meetingChannelId,'2026-10-02'),undefined);
    assert.equal(store.record('other','2026-10-01'),undefined);
  } finally {db?.close();rmSync(dir,{recursive:true,force:true});}
});
test('record is included in the scheduled reminder and retained after cancellation',async()=>{
  const db=new DatabaseSync(':memory:'),store=new MeetingStore(db);
  store.set(meetingChannelId,'2026-10-18','19:00','actor','教室',Date.parse('2026-10-16T10:00:00+08:00'),'20:00');
  store.setRecord(meetingChannelId,'2026-10-18',link,'actor');let sent;
  const reminder=new MeetingReminder({store,verify:async()=>{},send:async p=>{sent=p;return {id:'m'};},log:()=>{},now:()=>Date.parse('2026-10-17T17:00:00+08:00')});
  await reminder.tick();assert.ok(sent.content.includes(link));
  store.cancel(meetingChannelId);assert.equal(store.record(meetingChannelId,'2026-10-18').url,link);db.close();
});
test('Discord records use only existing dates, keep results private and reject forged choices',async()=>{
  const db=new DatabaseSync(':memory:');let handler;
  const verifiedChannel={guildId:'guild',type:0,permissionsFor:()=>({has:()=>true}),guild:{roles:{fetch:async()=>({mentionable:true})}}};
  registerMeetings({on:(_,fn)=>{handler=fn;},channels:{fetch:async()=>verifiedChannel},user:{}},{db},{guildId:'guild'},()=>{});
  async function run({command,action,values,fields,channel=meetingChannelId,id='draft',actor='actor'}) {
    let result,modal;const i={id,isChatInputCommand:()=>!!command,commandName:command,customId:action,guildId:'guild',channelId:channel,user:{id:actor},values,fields,
      isButton:()=>!!action&&!values&&!fields,isStringSelectMenu:()=>!!values,isModalSubmit:()=>!!fields,
      channel:{permissionsFor:()=>({has:()=>true})},deferUpdate:async()=>{i.deferred=true;},
      deferReply:async p=>{assert.equal(p.flags,64);i.deferred=true;},editReply:async p=>{result=p;},reply:async p=>{result=p;},update:async p=>{result=p;},showModal:async m=>{modal=m.toJSON();}};
    await handler(i);return {result,modal};
  }
  assert.match((await run({command:'查看會議記錄'})).result.content,/沒有可選/);
  db.prepare('INSERT INTO meeting_dates VALUES(?,?)').run(meetingChannelId,'2026-10-01');
  const picker=await run({command:'查看會議記錄'});
  assert.deepEqual(picker.result.components[0].toJSON().components[0].options.map(o=>o.value),['2026-10-01']);
  assert.match((await run({action:'meeting:record_date:draft',values:['2026-10-01']})).result.content,/尚未登錄/);
  assert.match((await run({action:'meeting:record_date:draft',values:['2026-10-02']})).result.content,/重新選擇/);
  assert.match((await run({action:'meeting:record_date:draft',values:['2026-10-01'],actor:'other'})).result.content,/不屬於你/);
  await run({command:'會議設定',id:'set'});
  await run({action:'meeting:record_history:set'});
  assert.ok((await run({action:'meeting:record_date:set',values:['2026-10-01']})).modal);
  assert.ok((await run({action:'meeting:record_submit:set',fields:{getTextInputValue:()=>link}})).result.content.includes(link));
  await run({command:'查看會議記錄'});
  const found=(await run({action:'meeting:record_date:draft',values:['2026-10-01']})).result;
  assert.ok(found.content.includes(link));assert.deepEqual(found.allowedMentions,{parse:[]});
  const denied=(await run({command:'查看會議記錄',channel:'other'})).result;assert.match(denied.content,/隊長頻道/);assert.ok(!denied.content.includes(link));db.close();
});

test('scheduled dates remain in history after next meeting; rescheduled future dates disappear',()=>{
  const db=new DatabaseSync(':memory:'),store=new MeetingStore(db);
  const before=Date.parse('2026-10-01T10:00:00+08:00');
  store.set(meetingChannelId,'2026-10-10','19:00','actor','教室',before,'20:00');
  store.set(meetingChannelId,'2026-10-20','19:00','actor','教室',Date.parse('2026-10-15T10:00:00+08:00'),'20:00');
  store.set(meetingChannelId,'2026-10-22','19:00','actor','教室',Date.parse('2026-10-15T10:00:00+08:00'),'20:00');
  assert.deepEqual(store.recordDates(meetingChannelId),['2026-10-22','2026-10-10']);
  store.setRecord(meetingChannelId,'2026-09-01',link,'actor');
  assert.deepEqual(store.recordDates(meetingChannelId),['2026-10-22','2026-10-10','2026-09-01']);
  db.close();
});

test('existing dates paginate without generating non-meeting dates',async()=>{
  const {recordControls}=await import('../src/meetings-ui.js');
  const dates=Array.from({length:26},(_,i)=>'2026-10-'+String(i+1).padStart(2,'0'));
  const first=recordControls('id',dates,0),last=recordControls('id',dates,1);
  assert.equal(first[0].toJSON().components[0].options.length,25);
  assert.equal(last[0].toJSON().components[0].options[0].value,'2026-10-26');
  assert.equal(last[1].toJSON().components[1].disabled,true);
  assert.throws(()=>recordControls('id',dates,2));assert.throws(()=>recordControls('id',[],0));
});
