import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recovery, listRecoveryThreads } from '../src/recovery.js';
import { Store } from '../src/store.js';
const config={guildId:'900000000000000000',forumId:'900000000000000001'};
const start=Date.parse('2026-10-04T00:00:00Z');
const id=ms=>((BigInt(ms)-1420070400000n)<<22n).toString();
const raw=(ms,extra={})=>({id:id(ms),parent_id:config.forumId,type:11,...extra});
const target=ms=>({id:id(ms),guildId:config.guildId,parentId:config.forumId,type:11});
function harness(t,scan) {
  const store=new Store(':memory:');t.after(()=>store.close());let time=start;
  const logs=[];const recovery=new Recovery({store,config,scan,log:(...args)=>logs.push(args),now:()=>time});
  return {store,recovery,logs,advance:ms=>{time+=ms;},checkpoint:()=>store.db.prepare('SELECT * FROM forum_recovery').get()};
}
test('recovery finds active and archived target posts and excludes old posts, other forums and ordinary threads',async()=>{
  const calls=[];
  const rest={get:async(path)=>{calls.push(path);return path.includes('/guilds/')?
    {threads:[raw(start+1000),raw(start-1000),raw(start+2000,{parent_id:'900000000000000005'}),raw(start+3000,{type:12}),raw(start+4000,{guild_id:'900000000000000005'})]}:
    {threads:[raw(start+5000),raw(start-5000)],has_more:false};}};
  const result=await listRecoveryThreads(rest,config,start,start+10000);
  assert.deepEqual(result.map(x=>x.id),[id(start+1000),id(start+5000)]);
  assert.equal(calls.length,2);
});
test('archived pagination uses archive timestamps and deduplicates active posts',async()=>{
  let pages=0;
  const rest={get:async(path,options)=>{
    if(path.includes('/guilds/'))return {threads:[raw(start+1000)]};
    pages++;
    if(pages===1)return {threads:[raw(start+1000,{thread_metadata:{archive_timestamp:new Date(start+9000).toISOString()}})],has_more:true};
    assert.equal(options.query.get('before'),new Date(start+9000).toISOString());
    return {threads:[raw(start+2000)],has_more:false};
  }};
  assert.equal((await listRecoveryThreads(rest,config,start,start+10000)).length,2);
});
test('archived scan stops once archive cursor precedes activation',async()=>{
  let calls=0;
  const rest={get:async path=>{calls++;return path.includes('/guilds/')?{threads:[]}:
    {threads:[raw(start-1000,{thread_metadata:{archive_timestamp:new Date(start-500).toISOString()}})],has_more:true};}};
  assert.deepEqual(await listRecoveryThreads(rest,config,start,start+10000),[]);assert.equal(calls,2);
});
test('malformed archive pagination fails rather than advancing a partial scan',async()=>{
  const rest={get:async path=>path.includes('/guilds/')?{threads:[raw(start+1000)]}:{threads:[],has_more:true}};
  await assert.rejects(listRecoveryThreads(rest,config,start,start+10000),/recovery_invalid_response/);
});
test('first activation starts now; sleep recovery queues one proposal and live duplicates remain unique',async t=>{
  let bounds;
  const h=harness(t,async(since,until)=>{bounds={since,until};return [target(start+1000),target(start+1000)];});
  h.store.enqueue(id(start+1000),config);h.advance(300000);await h.recovery.tick();
  assert.deepEqual(bounds,{since:start,until:start+300000});assert.equal(h.store.list().length,1);
  assert.equal(h.checkpoint().scanned_at,start+300000);
});
test('failed scan keeps durable checkpoint and safe logs for a later recovery retry',async t=>{
  let fail=true;const h=harness(t,async()=>{if(fail)throw Error('secret URL');return [target(start+1000)];});
  h.advance(300000);await h.recovery.tick();assert.equal(h.checkpoint().scanned_at,start);
  assert.equal(JSON.stringify(h.logs).includes('secret'),false);
  fail=false;h.advance(300000);await h.recovery.tick();assert.equal(h.store.list().length,1);
  assert.equal(h.checkpoint().scanned_at,start+600000);
});
test('recovery survives process restart and never requeues a succeeded proposal',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'cmsftc-recovery-'));t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const path=join(dir,'test.sqlite');let store=new Store(path);
  let recovery=new Recovery({store,config,scan:async()=>[target(start+1000)],log:()=>{},now:()=>start});
  await recovery.tick();store.db.prepare("UPDATE proposals SET status='succeeded' WHERE thread_id=?").run(id(start+1000));store.close();
  store=new Store(path);let bounds;
  recovery=new Recovery({store,config,scan:async(since,until)=>{bounds={since,until};return [target(start+1000),target(start+2000)];},log:()=>{},now:()=>start+86400000});
  await recovery.tick(true);assert.equal(bounds.since,start);assert.equal(store.list().length,2);
  assert.equal(store.get(id(start+1000)).status,'succeeded');
});
test('recovery avoids overlapping scans, checks every five minutes, and can force on reconnect',async t=>{
  let finish,calls=0;const h=harness(t,()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  const first=h.recovery.tick();await h.recovery.tick(true);assert.equal(calls,1);finish([]);await first;
  await h.recovery.tick();assert.equal(calls,1);h.advance(300000);
  const second=h.recovery.tick();await Promise.resolve();assert.equal(calls,2);finish([]);await second;
  const forced=h.recovery.tick(true);await Promise.resolve();assert.equal(calls,3);finish([]);await forced;
});
test('successful scans overlap one minute without scanning before activation',async t=>{
  const ranges=[];const h=harness(t,async(s,u)=>{ranges.push([s,u]);return [];});
  h.advance(300000);await h.recovery.tick();h.advance(300000);await h.recovery.tick();
  assert.deepEqual(ranges,[[start,start+300000],[start+240000,start+600000]]);
});
