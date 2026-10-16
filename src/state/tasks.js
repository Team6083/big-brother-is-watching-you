export class PostgresTaskStore {
  constructor(db){this.db=db;}
  async member(guild,id) { return (await this.db.prepare('SELECT trello_id FROM task_members WHERE guild_id=? AND discord_id=?').get(guild,id))?.trello_id; }
  async map(guild,discord,trello) {
    (await this.db.prepare(`INSERT INTO task_members VALUES(?,?,?) ON CONFLICT(guild_id,discord_id) DO UPDATE SET trello_id=excluded.trello_id`).run(guild,discord,trello));
  }
  async get(id) { return (await this.db.prepare('SELECT * FROM task_changes WHERE interaction_id=?').get(id)); }
  async pending(card) { return (await this.db.prepare("SELECT * FROM task_changes WHERE card_id=? AND state='pending'").get(card)); }
  async begin(id,card,actor,kind,payload) {
    (await this.db.prepare("INSERT INTO task_changes VALUES(?,?,?,?,?,'pending',NULL,?)").run(id,card,actor,kind,JSON.stringify(payload),Date.now()));
  }
  async finish(id,result) { (await this.db.prepare("UPDATE task_changes SET state='succeeded',result=? WHERE interaction_id=?").run(JSON.stringify(result),id)); }
  async fail(id) { (await this.db.prepare("UPDATE task_changes SET state='failed' WHERE interaction_id=?").run(id)); }
}
