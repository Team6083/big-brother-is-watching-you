CREATE TABLE IF NOT EXISTS proposals (
  thread_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, forum_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','awaiting_confirmation','succeeded','failed')),
  payload TEXT, task_snapshot TEXT, ack TEXT,
  fetch_attempts INTEGER NOT NULL DEFAULT 0, send_attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0, lease_until BIGINT NOT NULL DEFAULT 0, lease_token TEXT,
  last_error TEXT, received_at BIGINT NOT NULL, confirmed_at BIGINT,
  notification_status TEXT NOT NULL DEFAULT 'pending', notification_attempts INTEGER NOT NULL DEFAULT 0,
  notification_message_id TEXT, notification_error TEXT
);
CREATE INDEX IF NOT EXISTS proposals_due ON proposals(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS forum_recovery (
  guild_id TEXT NOT NULL,forum_id TEXT NOT NULL,started_at BIGINT NOT NULL,scanned_at BIGINT NOT NULL,
  PRIMARY KEY(guild_id,forum_id)
);
CREATE TABLE IF NOT EXISTS task_members (
  guild_id TEXT NOT NULL,discord_id TEXT NOT NULL,trello_id TEXT NOT NULL,
  PRIMARY KEY(guild_id,discord_id),UNIQUE(guild_id,trello_id)
);
CREATE TABLE IF NOT EXISTS task_changes (
  interaction_id TEXT PRIMARY KEY,card_id TEXT NOT NULL,actor_id TEXT NOT NULL,kind TEXT NOT NULL,
  payload TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS task_one_pending ON task_changes(card_id) WHERE state='pending';
CREATE TABLE IF NOT EXISTS meetings (
  channel_id TEXT PRIMARY KEY,starts_at BIGINT NOT NULL,remind_at BIGINT NOT NULL,
  actor_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','uncertain','cancelled','missed')),
  message_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,location TEXT NOT NULL DEFAULT '',ends_at BIGINT
);
CREATE TABLE IF NOT EXISTS meeting_records (
  channel_id TEXT NOT NULL,meeting_date TEXT NOT NULL,url TEXT NOT NULL,actor_id TEXT NOT NULL,
  updated_at BIGINT NOT NULL,PRIMARY KEY(channel_id,meeting_date)
);
CREATE TABLE IF NOT EXISTS meeting_dates (
  channel_id TEXT NOT NULL,meeting_date TEXT NOT NULL,PRIMARY KEY(channel_id,meeting_date)
);
CREATE TABLE IF NOT EXISTS pm_deliveries (
  delivery_key TEXT PRIMARY KEY,state TEXT NOT NULL,message_id TEXT,created_at BIGINT NOT NULL
);
