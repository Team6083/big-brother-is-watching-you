export class MongoTaskStore {
  constructor(db) {this.db=db;this.members=db.collection('task_members');this.changes=db.collection('task_changes');}
  async member(guild,id) {return (await this.members.findOne({_id:guild+':'+id}))?.trello_id;}
  map(guild,discord,trello) {return this.members.updateOne({_id:guild+':'+discord},{$set:{guild_id:guild,discord_id:discord,trello_id:trello}},{upsert:true});}
  async get(id) {return await this.changes.findOne({_id:id})??undefined;}
  async pending(card) {return await this.changes.findOne({card_id:card,state:'pending'})??undefined;}
  begin(id,card,actor,kind,payload) {
    if(!['dates','owners','progress','edit','description','status'].includes(kind))throw new Error('task_invalid_action');
    return this.changes.insertOne({_id:id,interaction_id:id,card_id:card,actor_id:actor,kind,payload:JSON.stringify(payload),state:'pending',result:null,created_at:Date.now()});
  }
  finish(id,result) {return this.changes.updateOne({_id:id,state:'pending'},{$set:{state:'succeeded',result:JSON.stringify(result)}});}
  fail(id) {return this.changes.updateOne({_id:id,state:'pending'},{$set:{state:'failed'}});}
  savePayload(id,payload) {return this.changes.updateOne({_id:id,state:'pending'},{$set:{payload:JSON.stringify(payload)}});}
  async owners(guild,ids) {
    const rows=await this.members.find({guild_id:guild,trello_id:{$in:ids}}).toArray();
    return [...new Set(rows.map(r=>r.discord_id))].filter(id=>/^\d{17,20}$/.test(id));
  }
  async progressActionIds() {
    const rows=await this.changes.find({state:'succeeded',kind:'progress'},{projection:{result:1}}).toArray();
    return rows.map(r=>JSON.parse(r.result)?.action_id).filter(Boolean);
  }
}
