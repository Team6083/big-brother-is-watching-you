import {ObjectId} from 'mongodb';

// Keep the existing task/form fields so the Discord workflow does not change.
export const statuses=[
  ['idea','想法收集'],['decision','待討論／決策'],['todo','待執行'],['doing','進行中'],
  ['review','待審核'],['announcement','待公告'],['done','完成'],
];
const snowflake=id=>/^\d{17,20}$/.test(id||'');
const taskId=id=>/^[a-f0-9]{24}$/i.test(id||'');

export class MongoTasks {
  constructor(db,config) {this.db=db;this.rows=db.collection('tasks');this.config=config;}
  async board() {return {id:this.config.guildId,closed:false};}
  async lists() {return statuses.map(([id,name])=>({id,name,idBoard:this.config.guildId,closed:false}));}
  async card(id) {
    if(!taskId(id))throw new Error('task_not_synced');
    const row=await this.rows.findOne({_id:id,guild_id:this.config.guildId});
    if(!row)throw new Error('task_legacy_unavailable');
    return row;
  }
  async create(payload,{threadId,channelId,source='discord',createdAt,proposal}={}) {
    if(!snowflake(threadId)||!snowflake(channelId)||!snowflake(this.config.guildId)||
      !payload.desc?.includes('CMSFTC_THREAD_ID='+threadId))throw new Error('task_invalid_source');
    if(!statuses.some(([id])=>id===payload.idList))throw new Error('task_invalid_status');
    const at=new Date().toISOString(),id=new ObjectId().toHexString();
    const row={...payload,_id:id,id,idBoard:this.config.guildId,idMembers:[],closed:false,dueComplete:payload.idList==='done',
      guild_id:this.config.guildId,channel_id:channelId,thread_id:threadId,source,version:0,
      shortUrl:'https://discord.com/channels/'+this.config.guildId+'/'+threadId,
      created_at:createdAt||at,dateLastActivity:at,completed_at:payload.idList==='done'?at:null,
      ...(proposal?{proposal}:{})};
    try {
      return await this.rows.findOneAndUpdate({guild_id:this.config.guildId,thread_id:threadId},
        {$setOnInsert:row},{upsert:true,returnDocument:'after',includeResultMetadata:false});
    } catch(error) {
      if(error.code!==11000)throw error;
      return await this.rows.findOne({guild_id:this.config.guildId,thread_id:threadId});
    }
  }
  async update(id,patch,{version}={}) {
    if(Object.keys(patch).some(k=>!['name','desc','start','due','idList'].includes(k)))throw new Error('task_invalid_action');
    if(patch.idList!==undefined&&!statuses.some(([status])=>status===patch.idList))throw new Error('task_invalid_status');
    const current=await this.card(id),at=new Date().toISOString(),changes={...patch,dateLastActivity:at};
    version??=current.version;
    if(patch.idList!==undefined)changes.dueComplete=patch.idList==='done';
    if(patch.idList!==undefined&&patch.idList!==current.idList)changes.completed_at=patch.idList==='done'?at:null;
    const row=await this.rows.findOneAndUpdate({_id:id,guild_id:this.config.guildId,closed:false,...(version!==undefined?{version}:{})},
      {$set:changes,$inc:{version:1}},{returnDocument:'after',includeResultMetadata:false});
    if(!row)throw new Error('task_conflict');
    return row;
  }
  cardsForThread(threadId) {return this.rows.find({guild_id:this.config.guildId,thread_id:threadId}).toArray();}
  async members() {return [];}
  async progress(id,text) {
    const action={id:new ObjectId().toHexString(),type:'commentCard',date:new Date().toISOString(),data:{card:{id},text}};
    const result=await this.rows.updateOne({_id:id,guild_id:this.config.guildId,closed:false},{$set:{last_progress:action,dateLastActivity:action.date},$inc:{version:1}});
    if(result.matchedCount!==1)throw new Error('task_conflict');
    return action;
  }
  async comments(id) {const row=await this.card(id);return row.last_progress?[row.last_progress]:[];}
  async proposal(proposal) {
    if(proposal.guild_id!==this.config.guildId||proposal.forum_channel_id!==this.config.forumId)throw new Error('task_invalid_source');
    // Original content, tags and attachments are retained separately in full.
    const desc='CMSFTC_THREAD_ID='+proposal.thread_id+'\n'+proposal.discord_url;
    const card=await this.create({name:proposal.title,desc,
      idList:'idea',start:null,due:null,labels:proposal.tags.map(name=>({name}))},
      {threadId:proposal.thread_id,channelId:proposal.forum_channel_id,source:'forum',createdAt:proposal.created_at,proposal});
    return {status:'succeeded',thread_id:proposal.thread_id,task_id:card.id,task_url:card.shortUrl};
  }
  async snapshot() {
    const rows=await this.rows.find({guild_id:this.config.guildId,closed:false}).toArray(),actions=[];
    const bindings=await this.db.collection('proposals').find({_id:{$in:rows.map(r=>r.thread_id)},guild_id:this.config.guildId,status:'succeeded'}).toArray();
    const cards=rows.filter(card=>bindings.some(row=>{
      try{return row._id===card.thread_id&&row.forum_id===card.channel_id&&JSON.parse(row.ack).task_id===card.id;}catch{return false;}
    }));
    for(const card of cards) {
      actions.push({type:'createCard',date:card.created_at,data:{card:{id:card.id}}});
      if(card.completed_at)actions.push({type:'updateCard',date:card.completed_at,data:{card:{id:card.id},listBefore:{name:'進行中'},listAfter:{name:'完成'}}});
      if(card.last_progress)actions.push(card.last_progress);
    }
    return {source:'mongodb',board:await this.board(),lists:await this.lists(),cards,members:[],actions,fetched_at:new Date().toISOString()};
  }
}
