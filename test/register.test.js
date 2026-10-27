import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {registerCommands} from '../src/tasks/register.js';

test('command registration removes retired meeting commands, preserves unrelated commands and retains record lookup',async()=>{
  const deleted=[],posted=[],rest={
    get:async()=>[{id:'old_cancel',name:'會議取消'},{id:'old_record',name:'會議記錄設定'},{id:'unrelated',name:'其他功能'}],
    delete:async path=>{deleted.push(path);},post:async(path,{body})=>{posted.push(body.name);},
  };
  await registerCommands(rest,'application','guild',{MEETING_CHANNEL_ID:'channel',MEETING_ROLE_ID:'role'});
  assert.deepEqual(deleted,['/applications/application/guilds/guild/commands/old_cancel','/applications/application/guilds/guild/commands/old_record']);
  assert.deepEqual(posted,['會議設定','會議查看','查看會議記錄']);
});

test('registration CLI still runs directly and fails closed before making requests when configuration is missing',()=>{
  const result=spawnSync(process.execPath,['src/tasks/register.js'],{env:{...process.env,DISCORD_BOT_TOKEN:'',DISCORD_GUILD_ID:''},encoding:'utf8',windowsHide:true});
  assert.equal(result.status,1);assert.match(result.stderr,/task_command_registration_failed/);
});
