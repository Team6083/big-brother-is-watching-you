import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ChannelType, Collection, Events, GatewayIntentBits, PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import { buildProposal, isTargetThread, initialTask } from '../src/proposal.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { sendProposal, validateAck } from '../src/webhook.js';
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

test('HTTP request includes idempotency key and optional Make API key', async () => {
  let options;
  const result = await sendProposal(proposal(), { webhookUrl: 'https://hook.make.com/test-fixture', webhookApiKey: 'test-only' }, {
    fetchImpl: async (_, request) => { options = request; return new Response(JSON.stringify(ack)); },
  });
  assert.equal(result.trello_card_url, ack.trello_card_url); assert.equal(options.redirect, 'error');
  assert.equal(options.headers['idempotency-key'], id); assert.equal(options.headers['x-make-apikey'], 'test-only');
});

test('Accepted, pending, mismatched IDs and malicious URLs are not successful acknowledgments', async () => {
  for (const body of ['Accepted', JSON.stringify({ status: 'pending', thread_id: id }),
    JSON.stringify({ ...ack, thread_id: 'wrong' }), JSON.stringify({ ...ack, trello_card_url: 'https://trello.com.evil.test/c/Test1234' })]) {
    await assert.rejects(sendProposal(proposal(), {}, { fetchImpl: async () => new Response(body) }), { code: 'make_unconfirmed' });
  }
  assert.equal(validateAck({ ...ack, trello_card_id: '' }, id), false);
  await assert.rejects(sendProposal(proposal(), {}, { fetchImpl: async () => new Response(JSON.stringify(ack), { status: 202 }) }),
    { code: 'make_unconfirmed' });
});

test('Make acceptance without a Trello acknowledgment never triggers a Discord success reply', async t => {
  const h = harness(t, { send: p => sendProposal(p, {}, { fetchImpl: async () => new Response('Accepted') }) });
  h.store.enqueue(id, config);
  for (let n = 0; n < 5; n++) { await h.worker.tick(); h.advance(); }
  assert.equal(h.store.get(id).status, 'failed'); assert.equal(h.store.get(id).last_error, 'make_unconfirmed');
  assert.equal(h.calls.notify, 0);
});

test('HTTP 403 stops retries; HTTP 429 honors Retry-After; oversized bodies are rejected', async () => {
  await assert.rejects(sendProposal(proposal(), {}, { fetchImpl: async () => new Response('secret', { status: 403 }) }),
    e => e.code === 'make_http_403' && !e.retryable && !e.message.includes('secret'));
  await assert.rejects(sendProposal(proposal(), {}, { fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '90' } }) }),
    e => e.retryAfterMs === 90_000);
  await assert.rejects(sendProposal(proposal(), {}, { fetchImpl: async () => new Response('x'.repeat(70_000)) }),
    { code: 'make_response_too_large' });
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

test('Discord adapter checks permissions, prevents mentions and recovers existing confirmation', async () => {
  const { thread } = fixture(); let sent = 0;
  const messages = new Collection();
  thread.permissionsFor = () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]);
  thread.messages = { fetch: async () => messages };
  thread.send = async options => { sent++; assert.equal(options.content, '✅ 此提案已收錄至 Trello。');
    assert.deepEqual(options.allowedMentions, { parse: [] });
    assert.equal(options.enforceNonce, true); return { id: 'sent' }; };
  const adapter = createDiscordAdapter({ user: { id: 'bot' }, channels: { fetch: async () => thread } }, config);
  assert.equal((await adapter.notify(id, ack)).skipped, true); assert.equal(sent, 0);
  thread.permissionsFor = () => new PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.SendMessagesInThreads]);
  await adapter.notify(id, ack); assert.equal(sent, 1);
  messages.set('existing', { id: 'existing', author: { id: 'bot' }, content: `✅ 此提案已收錄至 Trello。\n${ack.trello_card_url}` });
  assert.equal((await adapter.notify(id, ack)).id, 'existing'); assert.equal(sent, 1);
  messages.set('existing', { id: 'existing', author: { id: 'bot' }, content: '✅ 此提案已收錄至 Trello。' });
  assert.equal((await adapter.notify(id, ack)).id, 'existing'); assert.equal(sent, 1);
  messages.set('existing', { id: 'existing', author: { id: 'bot' }, content: '✅ 此提案已收錄至 Legacy Team Trello。' });
  assert.equal((await adapter.notify(id, ack)).id, 'existing'); assert.equal(sent, 1);
});

test('AI PM fields preserve unknowns; no owner, due date or priority is invented', () => {
  const task = initialTask(proposal(), ack);
  assert.equal(task.task_id, `discord:${id}`); assert.deepEqual(task.owner, []);
  for (const field of ['due_date','priority','last_progress_update','updated_at','needs_help','review_status','announcement_status']) {
    assert.equal(task[field], null);
  }
});

test('configuration rejects missing secrets, malformed IDs and non-Make/unsafe URLs without echoing input', () => {
  const env = { DISCORD_BOT_TOKEN: 'synthetic-not-a-token', DISCORD_GUILD_ID: config.guildId,
    DISCORD_FORUM_CHANNEL_ID: config.forumId, MAKE_WEBHOOK_URL: 'https://hook.eu1.make.com/example' };
  assert.equal(loadConfig(env).guildId, config.guildId);
  for (const url of ['http://hook.make.com/secret', 'https://evil.test/secret', 'https://user:secret@hook.make.com/x']) {
    assert.throws(() => loadConfig({ ...env, MAKE_WEBHOOK_URL: url }), { message: 'invalid_MAKE_WEBHOOK_URL' });
  }
  assert.throws(() => loadConfig({ ...env, DISCORD_GUILD_ID: '123' }), /invalid_DISCORD_GUILD_ID/);
  assert.equal(backoff(1, () => 0), 2_000); assert.equal(backoff(5, () => 0), 32_000);
});

async function serverFixture(t, handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { webhookUrl: `http://127.0.0.1:${server.address().port}` };
}

test('real HTTP timeout cannot produce success', async t => {
  const endpoint = await serverFixture(t, () => {});
  await assert.rejects(sendProposal(proposal(), endpoint, { timeoutMs: 30 }), { code: 'make_network_or_timeout' });
});

test('simulated Make creates once, loses first response, and returns existing Trello card on retry', async t => {
  let requests = 0, creations = 0; const records = new Map();
  const endpoint = await serverFixture(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const p = JSON.parse(body); requests++;
    if (!records.has(p.thread_id)) { creations++; records.set(p.thread_id, ack); req.socket.destroy(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(records.get(p.thread_id)));
  });
  const h = harness(t, { send: p => sendProposal(p, endpoint) }); h.store.enqueue(id, config);
  await h.worker.tick(); assert.equal(h.calls.notify, 0); assert.equal(h.store.get(id).status, 'awaiting_confirmation');
  h.advance(); await h.worker.tick();
  assert.equal(requests, 2); assert.equal(creations, 1); assert.equal(h.calls.notify, 1);
});
