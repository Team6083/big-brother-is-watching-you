import {meetingTimes,meetingEnd,checkMeetingEdit,recordDate,recordLink} from '../meetings.js';

const dateOf=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);
export class MongoMeetingStore {
  constructor(db) {this.db=db;this.rows=db.collection('meetings');this.dates=db.collection('meeting_dates');this.records=db.collection('meeting_records');}
  async get(id) {return await this.rows.findOne({_id:id})??undefined;}
  async recoverSending(channel) {await this.rows.updateOne({_id:channel,status:'sending'},{$set:{status:'uncertain'}});}
  async set(id,date,time,actor,location,now=Date.now(),endTime,previous,recordUrl) {
    location=location?.trim();
    if(!location || location.length>200 || /[\r\n]/.test(location))throw new Error('請填入會議地點（單行，最多 200 字）。');
    const ends=meetingEnd(date,time,endTime);
    if(recordUrl!==undefined&&recordUrl!=='')recordUrl=recordLink(recordUrl);
    return this.db.transaction(async session=>{
      const old=await this.rows.findOne({_id:id},{session});
      if(old?.status==='sending')throw new Error('提醒正在發送，請稍後再修改。');
      checkMeetingEdit(previous,old);
      const {starts,remind}=meetingTimes(date,time,now,old);
      const same=old?.remind_at===remind&&['pending','sent','uncertain'].includes(old.status);
      const row={_id:id,channel_id:id,starts_at:starts,remind_at:remind,actor_id:actor,location,ends_at:ends,
        status:same?old.status:'pending',message_id:same?old.message_id:null,attempts:same?old.attempts:0};
      await this.rows.replaceOne({_id:id},row,{upsert:true,session});
      if(old && old.starts_at>now && dateOf(old.starts_at)!==date)await this.dates.deleteOne({_id:id+':'+dateOf(old.starts_at)},{session});
      await this.dates.updateOne({_id:id+':'+date},{$setOnInsert:{channel_id:id,meeting_date:date}},{upsert:true,session});
      if(recordUrl==='')await this.records.deleteOne({_id:id+':'+date},{session});
      else if(recordUrl!==undefined)await this.records.updateOne({_id:id+':'+date},{$set:{channel_id:id,meeting_date:date,url:recordUrl,actor_id:actor,updated_at:now}},{upsert:true,session});
      return row;
    });
  }
  async cancel(id,now=Date.now(),previous) {
    return this.db.transaction(async session=>{
      const old=await this.rows.findOne({_id:id},{session});
      checkMeetingEdit(previous,old);
      if(!old)return 0;
      if(old.status==='sending')throw new Error('提醒正在發送，請稍後再操作。');
      if(previous&&old.starts_at<=now)throw new Error('會議時間已過，請重新查看會議。');
      await this.rows.updateOne({_id:id},{$set:{status:'cancelled'}},{session});
      if(old.starts_at>now)await this.dates.deleteOne({_id:id+':'+dateOf(old.starts_at)},{session});
      return 1;
    });
  }
  async recordDates(channel) {
    const [dates,records]=await Promise.all([this.dates.distinct('meeting_date',{channel_id:channel}),this.records.distinct('meeting_date',{channel_id:channel})]);
    return [...new Set([...dates,...records])].sort().reverse();
  }
  async setRecord(channel,date,url,actor) {
    const valid=recordDate(date);
    if(url===''){await this.records.deleteOne({_id:channel+':'+valid});return;}
    const link=recordLink(url);
    await this.records.updateOne({_id:channel+':'+valid},{$set:{channel_id:channel,meeting_date:valid,url:link,actor_id:actor,updated_at:Date.now()}},{upsert:true});
    return this.record(channel,valid);
  }
  async record(channel,date) {return await this.records.findOne({_id:channel+':'+recordDate(date)})??undefined;}
  recordForMeeting(row) {return this.record(row.channel_id,dateOf(row.starts_at));}
  markMissed(row) {return this.rows.updateOne({_id:row.channel_id,starts_at:row.starts_at,status:'pending'},{$set:{status:'missed'}});}
  verificationFailed(row) {
    return this.rows.updateOne({_id:row.channel_id,starts_at:row.starts_at,status:'pending'},[
      {$set:{status:{$cond:[{$gte:['$attempts',4]},'uncertain','pending']},attempts:{$add:['$attempts',1]}}},
    ]);
  }
  async claim(row) {return await this.rows.findOneAndUpdate({_id:row.channel_id,starts_at:row.starts_at,status:'pending'},{$set:{status:'sending'}},{returnDocument:'after',includeResultMetadata:false})??undefined;}
  markSent(row,id) {return this.rows.updateOne({_id:row.channel_id,starts_at:row.starts_at,status:'sending'},{$set:{status:'sent',message_id:id}});}
  markUncertain(row) {return this.rows.updateOne({_id:row.channel_id,starts_at:row.starts_at,status:'sending'},{$set:{status:'uncertain'}});}
}
