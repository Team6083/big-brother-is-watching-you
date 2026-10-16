import { ChannelType, Client, Events, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import { buildProposal, isTargetThread } from './proposal.js';
import { SyncError } from './errors.js';

export function createClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [] },
    rest: { timeout: 15_000, retries: 0, rejectOnRateLimit: () => true },
  });
}

export function registerEvents(client, store, config, log) {
  // There is intentionally no messageCreate/threadUpdate/history listener.
  client.on(Events.ThreadCreate, async (thread, newlyCreated) => {
    if (!isTargetThread(thread, newlyCreated, config)) return;
    try {
      if (await store.enqueue(thread.id, config)) log('proposal_queued', { thread_id: thread.id });
    } catch {
      log('queue_write_failed', { thread_id: thread.id, code: 'database_write_failed' });
      // Fail visibly; an operator must enqueue this ID after repairing the disk.
      process.exitCode = 1;
      client.emit('error', new Error('queue_write_failed'));
    }
  });
}

export function createDiscordAdapter(client, config) {
  async function forum() {
    const channel = await client.channels.fetch(config.forumId, { force: true });
    if (channel?.type !== ChannelType.GuildForum || channel.guildId !== config.guildId) {
      throw new SyncError('invalid_target_forum', false);
    }
    const permissions = channel.permissionsFor(client.user);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
      throw new SyncError('discord_permission', false);
    }
    return channel;
  }
  async function thread(id) {
    const channel = await client.channels.fetch(id, { force: true });
    if (!channel || !isTargetThread(channel, true, config)) throw new SyncError('outside_target_forum', false);
    return channel;
  }
  return {
    verify: forum,
    async fetchProposal(id) {
      const parent = await forum();
      const channel = await thread(id);
      return buildProposal(channel, await channel.fetchStarterMessage(), parent);
    },
    async notify(id, ack) {
      const channel = await thread(id);
      const permissions = channel.permissionsFor(client.user);
      if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessagesInThreads]) || channel.archived || channel.locked) {
        return { skipped: true, code: 'notification_permission_or_archived' };
      }
      const content = '✅ 此提案已收錄至 Trello。';
      // Recover a recently sent confirmation if the process stopped before recording it.
      const recent = await channel.messages.fetch({ limit: 100 });
      const existing = recent.find(m => {
        if(m.author.id!==client.user.id)return false;
        const lines=m.content.split('\n');
        return /^✅ 此提案已收錄至 (?:[^\n]{1,40} )?Trello。$/.test(lines[0]) &&
          (lines.length===1 || lines.length===2&&lines[1]===ack.trello_card_url);
      });
      if (existing) return { id: existing.id };
      const message = await channel.send({ content, allowedMentions: { parse: [] }, nonce: id, enforceNonce: true });
      return { id: message.id };
    },
  };
}
