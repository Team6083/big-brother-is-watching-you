import { DatabaseSync } from 'node:sqlite';

export class TaskStore {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS task_members (
      guild_id TEXT NOT NULL, discord_id TEXT NOT NULL, trello_id TEXT NOT NULL,
      PRIMARY KEY(guild_id,discord_id), UNIQUE(guild_id,trello_id)
    );
    CREATE TABLE IF NOT EXISTS task_changes (
      interaction_id TEXT PRIMARY KEY, card_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      kind TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS task_one_pending ON task_changes(card_id) WHERE state='pending';`);
  }
  member(guild,id) { return this.db.prepare('SELECT trello_id FROM task_members WHERE guild_id=? AND discord_id=?').get(guild,id)?.trello_id; }
  map(guild,discord,trello) {
    this.db.prepare(`INSERT INTO task_members VALUES(?,?,?) ON CONFLICT(guild_id,discord_id) DO UPDATE SET trello_id=excluded.trello_id`).run(guild,discord,trello);
  }
  get(id) { return this.db.prepare('SELECT * FROM task_changes WHERE interaction_id=?').get(id); }
  pending(card) { return this.db.prepare("SELECT * FROM task_changes WHERE card_id=? AND state='pending'").get(card); }
  begin(id,card,actor,kind,payload) {
    this.db.prepare("INSERT INTO task_changes VALUES(?,?,?,?,?,'pending',NULL,?)").run(id,card,actor,kind,JSON.stringify(payload),Date.now());
  }
  finish(id,result) { this.db.prepare("UPDATE task_changes SET state='succeeded',result=? WHERE interaction_id=?").run(JSON.stringify(result),id); }
  fail(id) { this.db.prepare("UPDATE task_changes SET state='failed' WHERE interaction_id=?").run(id); }
}

export function mappedDiscordOwners(db,guild,trelloIds) {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_members'").get()) return [];
  return [...new Set(trelloIds.flatMap(id => db.prepare('SELECT discord_id FROM task_members WHERE guild_id=? AND trello_id=?').all(guild,id).map(r=>r.discord_id)))].filter(id=>/^\d{17,20}$/.test(id));
}

export function progressActionIds(path) {
  let db;
  try {
    db = new DatabaseSync(path,{readOnly:true});
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='task_changes'").get()) return [];
    return db.prepare("SELECT result FROM task_changes WHERE state='succeeded' AND kind='progress'").all()
      .map(r=>JSON.parse(r.result)?.action_id).filter(Boolean);
  } catch (error) {
    if (!db) return [];
    throw error;
  } finally { db?.close(); }
}
