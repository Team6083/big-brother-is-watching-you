import { ChannelType } from 'discord.js';
import { SyncError } from './errors.js';

export function isTargetThread(thread, newlyCreated, config) {
  return newlyCreated === true && thread.guildId === config.guildId &&
    thread.parentId === config.forumId && thread.type === ChannelType.PublicThread &&
    (!thread.parent || thread.parent.type === ChannelType.GuildForum);
}

export function buildProposal(thread, starter, forum) {
  if (!starter || starter.id !== thread.id || starter.channelId !== thread.id || !starter.author) {
    throw new SyncError('starter_not_ready');
  }
  const attachments = [...starter.attachments.values()].map(a => ({
    id: a.id, filename: a.name, url: a.url, content_type: a.contentType ?? null,
    size: a.size, width: a.width ?? null, height: a.height ?? null,
  }));
  if (!starter.content && !attachments.length) throw new SyncError('starter_content_unavailable');
  const names = new Map(forum.availableTags.map(tag => [tag.id, tag.name]));
  if (thread.appliedTags.some(id => !names.has(id))) throw new SyncError('forum_tag_unavailable');
  return {
    event_type: 'proposal_created', guild_id: thread.guildId, forum_channel_id: forum.id,
    thread_id: thread.id, starter_message_id: starter.id, title: thread.name,
    content: starter.content, author_id: starter.author.id,
    author_name: starter.member?.displayName || starter.author.globalName || starter.author.username,
    created_at: new Date(thread.createdTimestamp).toISOString(),
    discord_url: `https://discord.com/channels/${thread.guildId}/${thread.id}`,
    tags: thread.appliedTags.map(id => names.get(id)), attachments,
  };
}

// A proposal is not yet an assigned task. This snapshot is not a Trello state cache.
export function initialTask(proposal, ack) {
  return {
    task_id: `discord:${proposal.thread_id}`, title: proposal.title, category: proposal.tags,
    status: '想法收集', owner: [], start_date: null, due_date: null, created_at: proposal.created_at,
    updated_at: null, last_progress_update: null,
    discord_thread_id: proposal.thread_id, discord_url: proposal.discord_url,
    trello_card_id: ack.trello_card_id, trello_url: ack.trello_card_url,
    priority: null, needs_help: null, review_status: null, announcement_status: null,
  };
}
