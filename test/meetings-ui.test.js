import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dateOptions,dateControls,timeModal,selectedTimes,previewControls} from '../src/meetings-ui.js';
import {MeetingStore,meetingEnd,meetingChannelId,meetingCommands,registerMeetings,meetingSummary,MeetingReminder} from '../src/meetings.js';

test('date choices paginate across month and year, only upcoming reminder dates',()=>{
  const now=Date.parse('2026-12-31T16:59:00+08:00');
  const first=dateOptions(now),next=dateOptions(now,1);
  assert.equal(first.length,25);assert.equal(first[0].value,'2027-01-01');assert.equal(next[0].value,'2027-01-26');
  assert.equal(dateOptions(now+60000)[0].value,'2027-01-02');
  assert.throws(()=>dateOptions(now,-1));assert.throws(()=>dateOptions(now,12));
  for(const row of dateControls('id',first,0))row.toJSON();
  for(const row of previewControls('id'))row.toJSON();
});
test('time and location modal has 4 dropdowns and one text field, without typed date formats',()=>{
  const modal=timeModal('id',{start:'19:00',end:'20:30',location:'教室'}).toJSON();
  assert.equal(modal.components.length,5);
  assert.equal(modal.components[0].component.options.length,24);
  assert.equal(modal.components[1].component.options.length,12);
  assert.equal(modal.components[4].component.value,'教室');
  assert.match(modal.components[0].component.options.find(o=>o.value==='04').label,/凌晨/);
  assert.match(modal.components[0].component.options.find(o=>o.value==='16').label,/下午/);
  timeModal('id',{}).toJSON();
});
test('end must be later on the same day and minute choices are validated',()=>{
  for(const end of ['19:00','18:00','24:00','bad'])assert.throws(()=>meetingEnd('2026-10-20','19:00',end));
  assert.equal(meetingEnd('2026-10-20','19:00','20:30'),Date.parse('2026-10-20T20:30:00+08:00'));
  assert.throws(()=>selectedTimes({getStringSelectValues:()=>['99']}));
});
function harness(now=Date.now) {
  const db=new DatabaseSync(':memory:');let handler;
  const channel={guildId:'guild',type:0,permissionsFor:()=>({has:()=>true}),guild:{roles:{fetch:async()=>({mentionable:true})}}};
  registerMeetings({on:(_,fn)=>{handler=fn;},channels:{fetch:async()=>channel},user:{}},{db},{guildId:'guild'},()=>{},{now});
  async function run({command,action,values,fields,user='actor',id='draft'}) {
    let result,modal;
    const i={id,guildId:'guild',channelId:meetingChannelId,channel,user:{id:user},member:{},values,
      commandName:command,customId:action,isChatInputCommand:()=>!!command,isButton:()=>!!action&&!values&&!fields,
      isStringSelectMenu:()=>!!values,isModalSubmit:()=>!!fields,fields,
      deferReply:async()=>{i.deferred=true;},deferUpdate:async()=>{i.deferred=true;},
      editReply:async p=>{result=p;},reply:async p=>{result=p;},update:async p=>{result=p;},showModal:async m=>{modal=m.toJSON();}};
    await handler(i);return {result,modal};
  }
  const fields=(end='20')=>({getStringSelectValues:key=>[{start_hour:'19',start_minute:'00',end_hour:end,end_minute:'30'}[key]],getTextInputValue:()=> '機器人教室'});
  return {db,run,fields};
}
test('complete Discord selection flow saves only after confirmation with both times and location',async()=>{
  const {db,run,fields}=harness();
  const first=await run({command:'會議設定'}),date=first.result.components[0].toJSON().components[0].options[0].value;
  assert.equal(db.prepare('SELECT count(*) n FROM meetings').get().n,0);
  const picked=await run({action:'meeting:date:draft',values:[date]});assert.ok(picked.modal);
  const preview=await run({action:'meeting:times:draft',fields:fields()});
  assert.match(preview.result.content,/尚未儲存/);assert.match(preview.result.content,/19:00.*20:30/);
  assert.equal(db.prepare('SELECT count(*) n FROM meetings').get().n,0);
  await run({action:'meeting:save:draft'});
  const row=db.prepare('SELECT * FROM meetings').get();assert.equal(row.location,'機器人教室');assert.equal(row.ends_at-row.starts_at,90*60000);
  assert.match(meetingSummary(row),/20:30/);
  const again=await run({action:'meeting:save:draft'});assert.match(again.result.content,/重新開啟/);db.close();
});
test('invalid end and another user cannot save; cancelling a draft leaves the real meeting unchanged',async()=>{
  const {db,run,fields}=harness();
  const first=await run({command:'會議設定'}),date=first.result.components[0].toJSON().components[0].options[0].value;
  await run({action:'meeting:date:draft',values:[date]});
  const invalid=await run({action:'meeting:times:draft',fields:fields('18')});assert.match(invalid.result.content,/結束時間必須晚於/);
  const foreign=await run({action:'meeting:date:draft',values:[date],user:'other'});assert.match(foreign.result.content,/不屬於你/);
  await run({action:'meeting:discard:draft'});assert.equal(db.prepare('SELECT count(*) n FROM meetings').get().n,0);db.close();
});
test('both times survive database persistence and appear in the reminder',async()=>{
  const db=new DatabaseSync(':memory:'),store=new MeetingStore(db),now=Date.parse('2026-10-16T10:00:00+08:00');
  store.set(meetingChannelId,'2026-10-18','19:00','actor','教室',now,'20:30');
  let payload;
  const reminder=new MeetingReminder({store,verify:async()=>{},send:async p=>{payload=p;return {id:'m'};},log:()=>{},now:()=>Date.parse('2026-10-17T17:00:00+08:00')});
  await reminder.tick();assert.match(payload.content,/19:00.*20:30/);db.close();
});

test('saved meetings offer editing with the current date, times and location; cancelling keeps the saved meeting',async()=>{
  const now=Date.parse('2026-10-23T10:00:00+08:00'),{db,run}=harness(()=>now),store=new MeetingStore(db);
  const original=store.set(meetingChannelId,'2026-10-26','16:00','actor','Room',now,'17:30');
  const view=await run({command:'會議查看'});
  assert.equal(view.result.components[0].toJSON().components[0].label,'編輯會議');
  const edit=await run({action:'meeting:open_edit',id:'edit'});
  assert.match(edit.result.content,/尚未儲存/);assert.match(edit.result.content,/2026年10月26日/);
  const modal=await run({action:'meeting:edit:edit'});
  assert.equal(modal.modal.components[0].component.options.find(o=>o.default).value,'16');
  assert.equal(modal.modal.components[2].component.options.find(o=>o.default).value,'17');
  assert.equal(modal.modal.components[4].component.value,'Room');
  await run({action:'meeting:discard:edit'});assert.deepEqual(store.get(meetingChannelId),original);db.close();
});

test('meeting edit changes the date with selectors and only saves after confirmation',async()=>{
  const now=Date.parse('2026-10-23T10:00:00+08:00'),{db,run,fields}=harness(()=>now),store=new MeetingStore(db);
  const original=store.set(meetingChannelId,'2026-10-26','16:00','actor','Room',now,'17:30');
  await run({action:'meeting:open_edit',id:'edit'});
  const dates=await run({action:'meeting:change_date:edit'});
  const options=dates.result.components[0].toJSON().components[0].options;
  assert.equal(options.find(o=>o.default).value,'2026-10-26');
  await run({action:'meeting:date:edit',values:['2026-10-27']});
  await run({action:'meeting:times:edit',fields:fields()});
  assert.deepEqual(store.get(meetingChannelId),original);
  const saved=await run({action:'meeting:save:edit'}),row=store.get(meetingChannelId);
  assert.equal(row.starts_at,Date.parse('2026-10-27T19:00:00+08:00'));assert.equal(row.location,'機器人教室');
  assert.equal(row.remind_at,Date.parse('2026-10-26T17:00:00+08:00'));
  assert.equal(saved.result.components[0].toJSON().components[0].label,'編輯會議');
  assert.deepEqual(store.recordDates(meetingChannelId),['2026-10-27']);db.close();
});

test('a stale saved-meeting button cannot edit a cancelled or past meeting',async()=>{
  const now=Date.parse('2026-10-23T10:00:00+08:00'),{db,run}=harness(()=>now),store=new MeetingStore(db);
  store.set(meetingChannelId,'2026-10-26','16:00','actor','Room',now,'17:30');
  await run({action:'meeting:open_edit',id:'stale'});store.cancel(meetingChannelId);
  const result=await run({action:'meeting:open_edit'});assert.match(result.result.content,/請先/);
  assert.equal(store.get(meetingChannelId).status,'cancelled');
  const stale=await run({action:'meeting:save:stale'});assert.match(stale.result.content,/會議資料已變更/);
  assert.equal(store.get(meetingChannelId).status,'cancelled');
  db.prepare("UPDATE meetings SET status='sent',starts_at=?").run(now-60000);
  const past=await run({action:'meeting:open_edit'});assert.match(past.result.content,/請先/);
  assert.equal(store.get(meetingChannelId).starts_at,now-60000);db.close();
});

test('editing an already reminded future meeting preserves its receipt and warns that the original announcement stays unchanged',async()=>{
  const now=Date.parse('2026-10-25T19:00:00+08:00'),{db,run,fields}=harness(()=>now),store=new MeetingStore(db);
  store.set(meetingChannelId,'2026-10-26','16:00','actor','Room',now-3*86400000,'17:30');
  db.prepare("UPDATE meetings SET status='sent',message_id='old_notice'").run();
  await run({action:'meeting:open_edit',id:'edit'});await run({action:'meeting:times:edit',fields:fields()});
  const saved=await run({action:'meeting:save:edit'}),row=store.get(meetingChannelId);
  assert.equal(row.starts_at,Date.parse('2026-10-26T19:00:00+08:00'));assert.equal(row.status,'sent');assert.equal(row.message_id,'old_notice');
  assert.match(saved.result.content,/不會重發或更新原提醒/);db.close();
});

test('meeting setup includes a draft record link and only commits it with the meeting',async()=>{
  const now=Date.parse('2026-10-25T10:00:00+08:00'),{db,run,fields}=harness(()=>now),store=new MeetingStore(db);
  assert.deepEqual(meetingCommands.map(c=>c.name),['會議設定','會議查看','查看會議記錄']);
  await run({command:'會議設定'});await run({action:'meeting:date:draft',values:['2026-10-27']});
  const preview=await run({action:'meeting:times:draft',fields:fields()});
  assert.ok(preview.result.components[0].toJSON().components.some(c=>c.label==='會議記錄連結'));
  const modal=await run({action:'meeting:record_link:draft'});assert.equal(modal.modal.components[0].component.required,false);
  await run({action:'meeting:record_draft:draft',fields:{getTextInputValue:()=> 'https://example.org/notes'}});
  assert.equal(store.record(meetingChannelId,'2026-10-27'),undefined);assert.equal(store.get(meetingChannelId),undefined);
  await run({action:'meeting:save:draft'});assert.equal(store.record(meetingChannelId,'2026-10-27').url,'https://example.org/notes');db.close();
});

test('cancel meeting lives in editing and needs confirmation; cancelling the edit keeps the meeting and record',async()=>{
  const now=Date.parse('2026-10-25T10:00:00+08:00'),{db,run}=harness(()=>now),store=new MeetingStore(db);
  const original=store.set(meetingChannelId,'2026-10-27','16:00','actor','Room',now,'17:30');store.setRecord(meetingChannelId,'2026-10-27','https://example.org/notes','actor');
  const edit=await run({action:'meeting:open_edit',id:'edit'});
  assert.ok(edit.result.components.flatMap(r=>r.toJSON().components).some(c=>c.label==='取消會議'));
  await run({action:'meeting:cancel:edit'});assert.deepEqual(store.get(meetingChannelId),original);
  await run({action:'meeting:keep:edit'});assert.deepEqual(store.get(meetingChannelId),original);
  await run({action:'meeting:cancel:edit'});
  const foreign=await run({action:'meeting:confirm_cancel:edit',user:'other'});assert.match(foreign.result.content,/不屬於你/);
  await run({action:'meeting:confirm_cancel:edit'});assert.equal(store.get(meetingChannelId).status,'cancelled');
  assert.equal(store.record(meetingChannelId,'2026-10-27').url,'https://example.org/notes');db.close();
});

test('combined meeting and record save rolls back both the meeting and date when record write fails',()=>{
  const now=Date.parse('2026-10-25T10:00:00+08:00'),db=new DatabaseSync(':memory:'),store=new MeetingStore(db);
  db.exec("CREATE TRIGGER reject_record BEFORE INSERT ON meeting_records BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(()=>store.set(meetingChannelId,'2026-10-27','16:00','actor','Room',now,'17:30',undefined,'https://example.org/notes'));
  assert.equal(store.get(meetingChannelId),undefined);assert.deepEqual(store.recordDates(meetingChannelId),[]);db.close();
});

test('discarded or invalid record drafts do not write, and an explicit empty link clears only that date',async()=>{
  const now=Date.parse('2026-10-25T10:00:00+08:00'),{db,run}=harness(()=>now),store=new MeetingStore(db);
  store.set(meetingChannelId,'2026-10-27','16:00','actor','Room',now,'17:30');store.setRecord(meetingChannelId,'2026-10-27','https://example.org/old','actor');
  store.setRecord(meetingChannelId,'2026-10-01','https://example.org/history','actor');
  await run({action:'meeting:open_edit',id:'edit'});
  const invalid=await run({action:'meeting:record_draft:edit',fields:{getTextInputValue:()=> 'http://example.org/invalid'}});assert.match(invalid.result.content,/HTTPS/);
  await run({action:'meeting:record_draft:edit',fields:{getTextInputValue:()=> 'https://example.org/discarded'}});
  await run({action:'meeting:discard:edit'});assert.equal(store.record(meetingChannelId,'2026-10-27').url,'https://example.org/old');
  await run({action:'meeting:open_edit',id:'clear'});await run({action:'meeting:record_draft:clear',fields:{getTextInputValue:()=> ''}});await run({action:'meeting:save:clear'});
  assert.equal(store.record(meetingChannelId,'2026-10-27'),undefined);assert.equal(store.record(meetingChannelId,'2026-10-01').url,'https://example.org/history');db.close();
});

test('a stale cancellation form cannot cancel a revised meeting and pending links cannot override separately updated records',async()=>{
  const now=Date.parse('2026-10-25T10:00:00+08:00'),{db,run}=harness(()=>now),store=new MeetingStore(db);
  store.set(meetingChannelId,'2026-10-27','16:00','actor','Room',now,'17:30');store.setRecord(meetingChannelId,'2026-10-27','https://example.org/old','actor');
  await run({action:'meeting:open_edit',id:'edit'});
  store.setRecord(meetingChannelId,'2026-10-27','https://example.org/revised','other');
  await run({action:'meeting:save:edit'});assert.equal(store.record(meetingChannelId,'2026-10-27').url,'https://example.org/revised');
  await run({action:'meeting:open_edit',id:'cancel'});await run({action:'meeting:cancel:cancel'});
  store.set(meetingChannelId,'2026-10-27','18:00','other','New room',now,'19:30');
  const rejected=await run({action:'meeting:confirm_cancel:cancel'});assert.match(rejected.result.content,/資料已變更/);assert.equal(store.get(meetingChannelId).status,'pending');db.close();
});
