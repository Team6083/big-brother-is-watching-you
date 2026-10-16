import {MongoTaskStore} from './tasks.js';

export class MongoDeliveryStore {
  constructor(db) {this.db=db;this.rows=db.collection('pm_deliveries');}
  get(key) {return this.rows.findOne({_id:key});}
  async claim(key,now) {
    try {await this.rows.insertOne({_id:key,delivery_key:key,state:'pending',message_id:null,created_at:now});return true;}
    catch(error){if(error.code===11000)return false;throw error;}
  }
  complete(key,id) {return this.rows.updateOne({_id:key,state:'pending'},{$set:{state:'sent',message_id:id}});}
  owners(guild,ids) {return new MongoTaskStore(this.db).owners(guild,ids);}
  async isBoundTask(guild,parent,thread,card) {
    const row=await this.db.collection('proposals').findOne({_id:thread,guild_id:guild,forum_id:parent,status:'succeeded'});
    try {return JSON.parse(row?.ack).trello_card_id===card;}catch{return false;}
  }
}
