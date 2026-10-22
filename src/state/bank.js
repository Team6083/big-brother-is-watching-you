export class MongoBankStore {
  constructor(db) {this.db=db;this.rows=db.collection('bank_notifications');}
  async recordSnapshot(source,tasks,now) {
    return this.db.transaction(async session=>{
      const initial=!await this.rows.findOne({_id:'source:'+source},{session});
      let queued=0;
      if(tasks.length) {
        const keys=tasks.map(task=>'task:'+source+':'+task.id);
        const known=new Set((await this.rows.find({_id:{$in:keys}},{session,projection:{_id:1}}).toArray()).map(row=>row._id));
        for(const task of tasks) {
          const id='task:'+source+':'+task.id;if(known.has(id))continue;
          const result=await this.rows.updateOne({_id:id},{$setOnInsert:{kind:'task',source_key:source,task_id:task.id,
            state:initial||!task.active?'ignored':'pending',payload:initial?null:task,attempts:0,next_attempt_at:now,lease_until:0,
            created_at:now,message_id:null,last_error:null}},{session,upsert:true});
          if(!initial&&task.active)queued+=result.upsertedCount;
        }
      }
      if(initial)await this.rows.insertOne({_id:'source:'+source,kind:'source',source_key:source,initialized_at:now},{session});
      return {initial,queued};
    });
  }
  recover(source,now) {return this.rows.updateMany({kind:'task',source_key:source,state:'sending',lease_until:{$lte:now}},{$set:{state:'uncertain',last_error:'bank_send_uncertain'}});}
  claim(source,now) {
    return this.rows.findOneAndUpdate({kind:'task',source_key:source,state:'pending',next_attempt_at:{$lte:now}},
      {$set:{state:'sending',lease_until:now+120000,send_started_at:now},$inc:{attempts:1}},
      {sort:{created_at:1,_id:1},returnDocument:'after',includeResultMetadata:false});
  }
  finish(row,state,fields={}) {return this.rows.updateOne({_id:row._id,state:'sending'},{$set:{state,lease_until:0,...fields}});}
  uncertain(source) {return this.rows.find({kind:'task',source_key:source,state:'uncertain'}).sort({created_at:-1}).limit(100).toArray();}
  sent(row,id) {return this.rows.updateOne({_id:row._id,state:{$in:['sending','uncertain']}},{$set:{state:'sent',message_id:id,lease_until:0,last_error:null}});}
}
