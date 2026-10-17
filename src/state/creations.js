export class MongoCreationStore {
  constructor(db) {this.db=db;this.rows=db.collection('task_creations');}
  get(id) {return this.rows.findOne({_id:id});}
  async reserve(row) {
    try {await this.rows.insertOne({...row,_id:row.id,state:'thread_pending',thread_id:null,notification_state:'pending',created_at:Date.now()});return true;}
    catch(error){if(error.code===11000)return false;throw error;}
  }
  async attachThread(id,thread) {
    const result=await this.rows.updateOne({_id:id,state:'thread_pending',thread_id:null},{$set:{state:'card_pending',thread_id:thread}});
    if(result.modifiedCount!==1)throw new Error('create_pending');
  }
  async finish(id,card) {
    return this.db.transaction(async session=>{
      const row=await this.rows.findOne({_id:id},{session});
      if(row?.state==='succeeded' && row.card_id===card.id)return;
      if(row?.state!=='card_pending')throw new Error('create_pending');
      const ack=JSON.stringify({thread_id:row.thread_id,trello_card_id:card.id,trello_card_url:card.shortUrl});
      const proposals=this.db.collection('proposals'),existing=await proposals.findOne({_id:row.thread_id},{session});
      if(existing && (existing.guild_id!==row.guild_id || existing.forum_id!==row.channel_id || existing.status!=='succeeded' || JSON.parse(existing.ack).trello_card_id!==card.id))throw new Error('create_binding_conflict');
      if(!existing)await proposals.insertOne({_id:row.thread_id,thread_id:row.thread_id,guild_id:row.guild_id,forum_id:row.channel_id,status:'succeeded',ack,
        payload:null,task_snapshot:null,fetch_attempts:0,send_attempts:0,next_attempt_at:0,lease_until:0,lease_token:null,last_error:null,
        received_at:row.created_at,confirmed_at:Date.now(),notification_status:'skipped',notification_attempts:0,notification_message_id:null,notification_error:null},{session});
      await this.rows.updateOne({_id:id,state:'card_pending'},{$set:{state:'succeeded',card_id:card.id,confirmed_at:Date.now()}},{session});
    });
  }
  async claimNotice(id) {return (await this.rows.updateOne({_id:id,state:'succeeded',notification_state:'pending'},{$set:{notification_state:'sending'}})).modifiedCount===1;}
  noticeSent(id,message) {return this.rows.updateOne({_id:id,notification_state:'sending'},{$set:{notification_state:'sent',notification_message_id:message}});}
}
