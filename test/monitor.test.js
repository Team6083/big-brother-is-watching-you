import test from 'node:test';
import assert from 'node:assert/strict';
import {PmMonitor} from '../src/pm/monitor.js';

const env={PM_ENABLED:'true',TRELLO_BOARD_ID:'example1',TRELLO_API_KEY:'testkey',TRELLO_READ_TOKEN:'testtoken',DISCORD_GUILD_ID:'900000000000000100',DISCORD_FORUM_CHANNEL_ID:'900000000000000101',DISCORD_BOT_TOKEN:'test-only'};
const snapshot=()=>({board:{},lists:[],cards:[],members:[],actions:[],fetched_at:new Date().toISOString()});

test('integrated PM uses the shared state without opening a second bot or database',async()=>{
  const state={},logs=[];let reads=0,sends=0;
  const monitor=new PmMonitor({state,env,read:async()=>{reads++;return snapshot();},progress:async()=>[],notify:async(_,config,options)=>{assert.equal(options.state,state);assert.equal(config.token,env.DISCORD_BOT_TOKEN);sends++;return [{status:'sent'}];},log:(...args)=>logs.push(args)});
  await monitor.tick();assert.equal(reads,1);assert.equal(sends,1);assert.equal(logs[0][0],'pm_scan_completed');
  monitor.stop();await monitor.tick();assert.equal(reads,1);
});
test('PM does not overlap scans, and shutdown can wait for an in-flight scan',async()=>{
  let release,sends=0;
  const monitor=new PmMonitor({state:{},env,read:()=>new Promise(resolve=>{release=()=>resolve(snapshot());}),progress:async()=>[],notify:async()=>{sends++;return [];},log:()=>{}});
  const first=monitor.tick();await monitor.tick();assert.equal(monitor.running,true);
  monitor.stop();release();await first;assert.equal(monitor.running,false);assert.equal(sends,1);await monitor.tick();assert.equal(sends,1);
});
test('disabled PM performs no requests; failures are sanitized and allow the next scan',async()=>{
  const logs=[];const disabled=new PmMonitor({state:{},env:{PM_ENABLED:'false'},read:()=>assert.fail('disabled'),log:()=>{}});await disabled.tick();
  const monitor=new PmMonitor({state:{},env,read:async()=>{throw new Error('sensitive-token-url');},log:(...args)=>logs.push(args)});
  await monitor.tick();assert.equal(monitor.running,false);assert.equal(JSON.stringify(logs).includes('sensitive'),false);await monitor.tick();assert.equal(logs.length,2);
  assert.throws(()=>new PmMonitor({env:{PM_ENABLED:'true'}}),/missing_read_config/);
});
