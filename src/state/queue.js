import {randomUUID} from 'node:crypto';
import {openDatabase} from './database.js';

export class MongoStore {
  constructor(db) {this.db=db;this.rows=db.collection('proposals');}
  async enqueue(id,config,now=Date.now()) {
    if(![id,config.guildId,config.forumId].every(v=>/^\d{17,20}$/.test(v)))throw new Error('invalid_proposal_identity');
    try {
      await this.rows.insertOne({_id:id,thread_id:id,guild_id:config.guildId,forum_id:config.forumId,status:'pending',payload:null,task_snapshot:null,ack:null,
        fetch_attempts:0,send_attempts:0,next_attempt_at:0,lease_until:0,lease_token:null,last_error:null,received_at:now,confirmed_at:null,
        notification_status:'pending',notification_attempts:0,notification_message_id:null,notification_error:null});return true;
    }catch(error){if(error.code===11000)return false;throw error;}
  }
  async get(id) {return await this.rows.findOne({_id:id})??undefined;}
  list() {return this.rows.find({},{projection:{_id:0,thread_id:1,status:1,fetch_attempts:1,send_attempts:1,last_error:1,notification_status:1,notification_error:1}}).sort({received_at:-1}).limit(100).toArray();}
  async claim(config,now=Date.now()) {
    return await this.rows.findOneAndUpdate({guild_id:config.guildId,forum_id:config.forumId,lease_until:{$lte:now},next_attempt_at:{$lte:now},
      $or:[{status:{$in:['pending','awaiting_confirmation']}},{status:'succeeded',notification_status:'pending'}]},
      {$set:{lease_until:now+120000,lease_token:randomUUID()}},{sort:{next_attempt_at:1,received_at:1},returnDocument:'after',includeResultMetadata:false})??undefined;
  }
  async update(row,fields) {
    const allowed=new Set(['status','payload','task_snapshot','ack','fetch_attempts','send_attempts','next_attempt_at','last_error','confirmed_at','notification_status','notification_attempts','notification_message_id','notification_error']);
    if(!Object.keys(fields).length || Object.keys(fields).some(k=>!allowed.has(k)) || 'status' in fields&&!['pending','awaiting_confirmation','succeeded','failed'].includes(fields.status) ||
      'notification_status' in fields&&!['pending','sent','failed','skipped'].includes(fields.notification_status))throw new Error('invalid_store_update');
    const result=await this.rows.updateOne({_id:row.thread_id,lease_token:row.lease_token},{$set:fields});
    if(result.matchedCount!==1)throw new Error('lease_lost');
    Object.assign(row,fields);
  }
  release(row) {return this.rows.updateOne({_id:row.thread_id,lease_token:row.lease_token},{$set:{lease_until:0,lease_token:null}});}
  async retry(id,notification=false,now=Date.now()) {
    const row=await this.get(id);
    if(!row || row.lease_until>now || (notification?row.status!=='succeeded'||!['failed','skipped'].includes(row.notification_status):row.status!=='failed'))return false;
    const fields=notification?{notification_status:'pending',notification_attempts:0,notification_error:null,next_attempt_at:0}:
      {status:row.payload===null?'pending':'awaiting_confirmation',fetch_attempts:0,send_attempts:0,last_error:null,next_attempt_at:0};
    return (await this.rows.updateOne({_id:id,status:row.status,notification_status:row.notification_status,lease_until:{$lte:now}},{$set:fields})).modifiedCount===1;
  }
  async initializeRecovery(config,now) {
    try {await this.db.collection('forum_recovery').updateOne({_id:config.guildId+':'+config.forumId},{$setOnInsert:{guild_id:config.guildId,forum_id:config.forumId,started_at:now,scanned_at:now}},{upsert:true});}
    catch(error){if(error.code!==11000)throw error;}
  }
  recoveryCheckpoint(config) {return this.db.collection('forum_recovery').findOne({_id:config.guildId+':'+config.forumId});}
  advanceRecovery(config,until) {return this.db.collection('forum_recovery').updateOne({_id:config.guildId+':'+config.forumId},{$max:{scanned_at:until}});}
  close() {return this.db.close();}
}
export async function openStore(env=process.env) {return new MongoStore(await openDatabase(env));}
