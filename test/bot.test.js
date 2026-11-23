import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType, Collection, Events, GatewayIntentBits, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { buildProposal, isTargetThread, initialTask } from '../src/proposal.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { createClient, createDiscordAdapter, registerEvents } from '../src/discord.js';
import { loadConfig } from '../src/config.js';
import { SyncError, backoff, discordError } from '../src/errors.js';

// Synthetic fixtures only; no account identifiers or credentials.
const config = { guildId: '900000000000000000', forumId: '900000000000000001', notify: true };
const id = '900000000000000002';
function fixture() {
  const forum = { id: config.forumId, guildId: config.guildId, type: ChannelType.GuildForum,
    availableTags: [{ id: '900000000000000003', name: '網站／系統' }] };
  const thread = { id, guildId: config.guildId, parentId: config.forumId, type: ChannelType.PublicThread,
    parent: forum, name: '建立教學資源', createdTimestamp: Date.parse('2026-10-03T01:00:00.000Z'),
    appliedTags: ['900000000000000003'] };
  const starter = { id, channelId: id, content: '完整內容\n第二行 @everyone',
    author: { id: '900000000000000004', username: 'test-mentor', globalName: '測試 Mentor' },
    attachments: new Collection() };
  return { forum, thread, starter };
}
function proposal() { const { thread, starter, forum } = fixture(); return buildProposal(thread, starter, forum); }
const ack = { status: 'succeeded', thread_id: id, trello_card_id: 'a00000000000000000000000',
  trello_card_url: 'https://trello.com/c/Test1234' };
function harness(t, options = {}) {
  const store = options.store || new Store(':memory:');
  if (!options.store) t.after(() => store.close());
  let now = 10_000;
  const calls = { fetch: 0, send: 0, notify: 0, logs: [] };
  const worker = new Worker({ store, config, log: (...x) => calls.logs.push(x), now: () => now, random: () => 0,
    discord: {
      fetchProposal: async () => { calls.fetch++; return proposal(); },
      notify: async () => { calls.notify++; assert.equal(store.get(id).status, 'succeeded'); return { id: 'notification' }; },
    }, send: async () => { calls.send++; return ack; }, ...options });
  return { store, worker, calls, advance: (ms = 180_000) => { now += ms; } };
}

test('new forum proposal preserves title, full content, author, UTC timestamp, tags and source URL', () => {
  const p = proposal();
  assert.equal(p.event_type, 'proposal_created');
  assert.equal(p.title, '建立教學資源');
  assert.equal(p.content, '完整內容\n第二行 @everyone');
  assert.equal(p.author_name, '測試 Mentor');
  assert.equal(p.created_at, '2026-10-03T01:00:00.000Z');
  assert.equal(p.discord_url, `https://discord.com/channels/${config.guildId}/${id}`);
  assert.deepEqual(p.tags, ['網站／系統']);
  assert.equal(p.starter_message_id, id);
});

test('attachment-only proposals preserve metadata without downloading files', () => {
  const f = fixture(); f.starter.content = '';
  f.starter.attachments.set('file', { id: 'file', name: 'plan.pdf', url: 'https://cdn.discordapp.com/test-only', size: 1024,
    contentType: 'application/pdf' });
  const p = buildProposal(f.thread, f.starter, f.forum);
  assert.equal(p.attachments[0].filename, 'plan.pdf');
  assert.equal(p.attachments[0].size, 1024);
  assert.equal(p.content, '');
});

test('ordinary messages, replies and updates do not enqueue; only new target forum thread does', t => {
  const { store } = harness(t);
  const client = new EventEmitter(); registerEvents(client, store, config, () => {});
  const { thread } = fixture();
  client.emit(Events.MessageCreate, { channelId: id, content: 'reply' });
  client.emit(Events.ThreadUpdate, thread, thread);
  client.emit(Events.ThreadCreate, thread, false);
  assert.equal(store.list().length, 0);
  client.emit(Events.ThreadCreate, thread, true);
  client.emit(Events.ThreadCreate, thread, true);
  assert.equal(store.list().length, 1);
  assert.equal(client.listenerCount(Events.MessageCreate), 0);
});

test('wrong guild, wrong forum, text-channel threads and private threads are ignored', () => {
  const { thread } = fixture();
  for (const changes of [{ guildId: 'other' }, { parentId: 'other' }, { type: ChannelType.PrivateThread },
    { parent: { type: ChannelType.GuildText } }, { type: ChannelType.GuildText }]) {
    assert.equal(isTargetThread({ ...thread, ...changes }, true, config), false);
  }
});

test('only Guilds and MessageContent Gateway intents are requested', async () => {
  const client = createClient();
  assert.equal(client.options.intents.bitfield, GatewayIntentBits.Guilds | GatewayIntentBits.MessageContent);
  await client.destroy();
});

test('duplicate event syncs once; confirmation happens after durable success', async t => {
  const { store, worker, calls } = harness(t);
  assert.equal(store.enqueue(id, config), true); assert.equal(store.enqueue(id, config), false);
  await Promise.all([worker.tick(), worker.tick()]);
  await worker.tick();
  assert.equal(calls.send, 1); assert.equal(calls.notify, 1);
  assert.equal(store.get(id).notification_status, 'sent');
});

test('restart preserves succeeded records and prevents duplicate sends', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cmsftc-test-')); const path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new Store(path);
  try {
    const h = harness(t, { store: first }); first.enqueue(id, config); await h.worker.tick();
  } finally { first.close(); }
  const second = new Store(path);
  try {
    const h = harness(t, { store: second }); assert.equal(second.enqueue(id, config), false);
    await h.worker.tick(); assert.equal(h.calls.send, 0); assert.equal(second.get(id).status, 'succeeded');
  } finally { second.close(); }
});

test('a crashed awaiting-confirmation lease is recovered after restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cmsftc-test-')); const path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = new Store(path);
  first.enqueue(id, config, 1);
  const row = first.claim(config, 1);
  first.update(row, { status: 'awaiting_confirmation', payload: JSON.stringify(proposal()), send_attempts: 1 });
  first.close();
  const second = new Store(path);
  try {
    const h = harness(t, { store: second }); await h.worker.tick(); assert.equal(h.calls.send, 0);
    h.advance(); await h.worker.tick();
    assert.equal(h.calls.send, 1); assert.equal(h.calls.fetch, 0);
    assert.equal(second.get(id).send_attempts, 2);
  } finally { second.close(); }
});

test('two SQLite connections cannot claim the same row concurrently', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cmsftc-test-')); const path = join(dir, 'db.sqlite');
  const a = new Store(path), b = new Store(path);
  t.after(() => { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); });
  a.enqueue(id, config, 1); const row = a.claim(config, 1);
  assert.ok(row); assert.equal(b.claim(config, 1), undefined);
  const next = b.claim(config, 120_002); assert.ok(next);
  assert.throws(() => a.update(row, { status: 'succeeded' }), /lease_lost/);
  a.release(row); assert.equal(b.claim(config, 120_002), undefined);
});

test('starter-message failures use bounded persistent retries before any webhook call', async t => {
  const h = harness(t); h.store.enqueue(id, config);
  let fetches = 0;
  h.worker.discord.fetchProposal = async () => { if (++fetches < 3) throw new SyncError('starter_not_ready'); return proposal(); };
  await h.worker.tick(); assert.equal(h.calls.send, 0); assert.equal(h.store.get(id).status, 'pending');
  h.advance(); await h.worker.tick(); h.advance(); await h.worker.tick();
  assert.equal(h.calls.send, 1); assert.equal(fetches, 3);
});

test('starter fetch retries stop at five; missing permission fails immediately', async t => {
  const h = harness(t); h.store.enqueue(id, config);
  h.worker.discord.fetchProposal = async () => { throw new SyncError('starter_not_ready'); };
  for (let n = 0; n < 7; n++) { await h.worker.tick(); h.advance(); }
  assert.equal(h.store.get(id).fetch_attempts, 5); assert.equal(h.store.get(id).status, 'failed');
  assert.equal(h.calls.send, 0);
  h.store.retry(id, false, 9_999_999);
  h.worker.discord.fetchProposal = async () => { throw { code: 50013 }; };
  await h.worker.tick();
  assert.equal(h.store.get(id).last_error, 'discord_permission'); assert.equal(h.store.get(id).fetch_attempts, 1);
});

test('Discord rate limits persist the server wait before retrying', async t => {
  const h = harness(t); h.store.enqueue(id, config);
  h.worker.discord.fetchProposal = async () => { throw { name: 'RateLimitError', timeToReset: 90_000 }; };
  await h.worker.tick(); assert.equal(h.store.get(id).next_attempt_at, 100_000);
  h.advance(10_000); await h.worker.tick(); assert.equal(h.store.get(id).fetch_attempts, 1);
  assert.equal(discordError({ name: 'RateLimitError', timeToReset: 'bad' }).retryAfterMs, 0);
});

test('temporary Make failure retries the identical proposal and never notifies early', async t => {
  const h = harness(t); const bodies = []; h.store.enqueue(id, config);
  h.worker.send = async p => { bodies.push(JSON.stringify(p)); if (bodies.length === 1) throw new SyncError('make_http_503'); return ack; };
  await h.worker.tick(); assert.equal(h.store.get(id).status, 'awaiting_confirmation'); assert.equal(h.calls.notify, 0);
  await h.worker.tick(); assert.equal(bodies.length, 1);
  h.advance(); await h.worker.tick();
  assert.equal(bodies[0], bodies[1]); assert.equal(h.calls.notify, 1);
});

test('retry exhaustion is durable and requires explicit admin retry', async t => {
  const h = harness(t); h.store.enqueue(id, config); h.worker.send = async () => { throw new SyncError('make_http_503'); };
  for (let n = 0; n < 7; n++) { await h.worker.tick(); h.advance(); }
  assert.equal(h.store.get(id).status, 'failed'); assert.equal(h.store.get(id).send_attempts, 5);
  assert.equal(h.calls.notify, 0); assert.equal(h.store.retry(id, false, 9_999_999), true);
  h.worker.send = async () => ack; await h.worker.tick(); assert.equal(h.store.get(id).status, 'succeeded');
  assert.equal(h.store.retry(id, false, 9_999_999), false);
});

test('missing send permission skips Discord reply without undoing successful sync', async t => {
  const h = harness(t); h.store.enqueue(id, config);
  h.worker.discord.notify = async () => ({ skipped: true, code: 'notification_permission_or_archived' });
  await h.worker.tick(); assert.equal(h.store.get(id).status, 'succeeded');
  assert.equal(h.store.get(id).notification_status, 'skipped'); assert.equal(h.calls.send, 1);
});

test('notification can be disabled without disabling proposal sync', async t => {
  const h = harness(t, { config: { ...config, notify: false } }); h.store.enqueue(id, config);
  await h.worker.tick(); assert.equal(h.calls.send, 1); assert.equal(h.calls.notify, 0);
  assert.equal(h.store.get(id).notification_error, 'notification_disabled');
});

test('manual enqueue outside the configured forum cannot be fetched or forwarded', async () => {
  const f = fixture(); f.forum.permissionsFor = () => new PermissionsBitField([
    PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
  const wrong = { ...f.thread, parentId: 'wrong-forum' };
  const adapter = createDiscordAdapter({ user: { id: 'bot' },
    channels: { fetch: async requested => requested === config.forumId ? f.forum : wrong } }, config);
  await assert.rejects(adapter.fetchProposal(id), { code: 'outside_target_forum' });
});

test('notification failure retries only the reply, never resends the proposal', async t => {
  const h = harness(t); h.store.enqueue(id, config);
  h.worker.discord.notify = async () => { throw new Error('sensitive raw error'); };
  await h.worker.tick(); h.advance(); await h.worker.tick(); h.advance(); await h.worker.tick();
  assert.equal(h.store.get(id).status, 'succeeded'); assert.equal(h.calls.send, 1);
  assert.equal(h.store.get(id).notification_status, 'failed');
  assert.equal(JSON.stringify(h.calls.logs).includes('sensitive'), false);
});

test('Discord adapter confirms native tasks once and skips unimported legacy records', async () => {
  const {thread}=fixture(),messages=new Collection();let sent=0;
  const nativeAck={task_id:'aaaaaaaaaaaaaaaaaaaaaaaa',task_url:'https://discord.com/channels/'+config.guildId+'/'+id};
  const content='✅ 此提案已收錄為任務，可使用 /任務 查看與設定。';
  thread.permissionsFor=()=>new PermissionsBitField([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory]);
  thread.messages={fetch:async()=>messages};
  thread.send=async options=>{sent++;assert.equal(options.content,content);assert.deepEqual(options.allowedMentions,{parse:[]});assert.equal(options.enforceNonce,true);return {id:'sent'};};
  const adapter=createDiscordAdapter({user:{id:'bot'},channels:{fetch:async()=>thread}},config);
  assert.equal((await adapter.notify(id,nativeAck)).skipped,true);
  thread.permissionsFor=()=>new PermissionsBitField([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.SendMessagesInThreads]);
  assert.equal((await adapter.notify(id,ack)).code,'legacy_task_not_imported');
  await adapter.notify(id,nativeAck);assert.equal(sent,1);
  messages.set('existing',{id:'existing',author:{id:'bot'},content});
  assert.equal((await adapter.notify(id,nativeAck)).id,'existing');assert.equal(sent,1);
});

test('AI PM fields preserve unknowns; no owner, due date or priority is invented', () => {
  const task = initialTask(proposal(), ack);
  assert.equal(task.task_id, `discord:${id}`); assert.deepEqual(task.owner, []);
  for (const field of ['due_date','priority','last_progress_update','updated_at','needs_help','review_status','announcement_status']) {
    assert.equal(task[field], null);
  }
});

test('configuration needs Discord but no Make or Trello credentials',()=>{
  const env={DISCORD_BOT_TOKEN:'synthetic-not-a-token',DISCORD_GUILD_ID:config.guildId,DISCORD_FORUM_CHANNEL_ID:config.forumId};
  assert.equal(loadConfig(env).guildId,config.guildId);
  assert.equal(loadConfig({...env,MAKE_WEBHOOK_URL:'unused'}).webhookUrl,undefined);
  assert.throws(()=>loadConfig({...env,DISCORD_BOT_TOKEN:''}),/missing_DISCORD_BOT_TOKEN/);
  assert.throws(()=>loadConfig({...env,TEAM_CHANNEL_ACCESS_ENABLED:'yes'}),/invalid_TEAM_CHANNEL_ACCESS_ENABLED/);
  assert.throws(()=>loadConfig({...env,DISCORD_GUILD_ID:'123'}),/invalid_DISCORD_GUILD_ID/);
  assert.equal(backoff(1,()=>0),2000);assert.equal(backoff(5,()=>0),32000);
});
