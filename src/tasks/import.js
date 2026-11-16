import {readFile} from 'node:fs/promises';
import {openDatabase} from '../state/database.js';
import {statuses} from './database.js';
import {discordOwners,discordAssigner,withDiscordOwners} from './owners.js';
import {taskDescription} from './description.js';

const aliases=new Map([['想法','idea'],['待討論','decision'],['待辦事項','todo'],['執行中','doing'],['已完成','done'],...statuses.map(([id,name])=>[name,id])]);
const validId=id=>/^[a-f0-9]{24}$/i.test(id||'');
const validDate=value=>value==null||typeof value==='string'&&Number.isFinite(Date.parse(value));

// Accept a Trello board JSON export or the historical readBoard snapshot.
// Only existing, successful Discord bindings are eligible. No network is used.
export async function importTasks(db,snapshot,config,{apply=false}={}) {
  if(!Array.isArray(snapshot?.cards)||!Array.isArray(snapshot.lists))throw new Error('task_import_invalid_export');
  const results={},count=reason=>{results[reason]=(results[reason]||0)+1;};
  const allowed=new Set([config.forumId,...(config.channelIds||[])]);
  const cards=snapshot.cards,seen=new Set();
  for(const card of cards) {
    if(!validId(card.id)||cards.filter(c=>c.id===card.id).length!==1){count('invalid_or_duplicate_id');continue;}
    const markers=[...(card.desc||'').matchAll(/(?:^|\n)CMSFTC_THREAD_ID\s*=\s*(\d{17,20})(?=\s|$)/g)];
    if(markers.length!==1){count('missing_or_ambiguous_thread');continue;}
    const thread=markers[0][1];
    if(seen.has(thread)||cards.some(c=>c!==card&&new RegExp('(?:^|\n)CMSFTC_THREAD_ID\\s*=\\s*'+thread+'(?=\\s|$)').test(c.desc||''))){count('duplicate_thread');continue;}
    seen.add(thread);
    const binding=await db.collection('proposals').findOne({_id:thread,guild_id:config.guildId,status:'succeeded'});
    let ack;try{ack=JSON.parse(binding?.ack);}catch{}
    if(!binding||!allowed.has(binding.forum_id)||ack?.trello_card_id!==card.id){count('unbound_or_already_imported');continue;}
    const list=snapshot.lists.find(l=>l.id===card.idList),status=aliases.get(list?.name);
    if(!status||card.idBoard!==(snapshot.board?.id||snapshot.id)){count('unknown_status_or_board');continue;}
    if(!validDate(card.start)||!validDate(card.due)||!validDate(card.dateLastActivity)||typeof card.name!=='string'||typeof card.desc!=='string'||!Number.isFinite(binding.received_at)){count('invalid_fields');continue;}
    let desc=card.desc;
    try {
      if(!discordOwners(desc)) {
        const members=await db.collection('task_members').find({guild_id:config.guildId,trello_id:{$in:card.idMembers||[]}}).toArray();
        if(members.length)desc=withDiscordOwners(desc,members.map(m=>({id:m.discord_id,name:m.discord_id})));
      }
      discordAssigner(desc);taskDescription(desc);
    }catch{count('invalid_metadata');continue;}
    const now=new Date().toISOString(),url='https://discord.com/channels/'+config.guildId+'/'+thread;
    const row={...card,_id:card.id,idBoard:config.guildId,idList:status,desc,idMembers:[],shortUrl:url,
      guild_id:config.guildId,channel_id:binding.forum_id,thread_id:thread,source:'legacy_import',version:0,
      closed:!!(card.closed||list.closed||snapshot.board?.closed||snapshot.closed),
      created_at:new Date(binding.received_at).toISOString(),dateLastActivity:card.dateLastActivity||now,
      completed_at:null,legacy_card:card,imported_at:now};
    const outcome=await db.transaction(async session=>{
      const current=await db.collection('proposals').findOne({_id:thread,ack:binding.ack},{session});
      if(!current)return 'binding_changed';
      if(await db.collection('tasks').findOne({$or:[{_id:card.id},{guild_id:config.guildId,thread_id:thread}]},{session}))return 'existing_task';
      if(await db.collection('task_changes').findOne({card_id:card.id,state:'pending'},{session}))return 'pending_update';
      if(apply) {
        await db.collection('tasks').insertOne(row,{session});
        await db.collection('proposals').updateOne({_id:thread,ack:binding.ack},{$set:{legacy_ack:binding.ack,ack:JSON.stringify({thread_id:thread,task_id:card.id,task_url:url})}},{session});
      }
      return apply?'imported':'eligible';
    });
    count(outcome);
  }
  return {apply,total:cards.length,results};
}

if(import.meta.main) {
  let db;
  try {
    const args=process.argv.slice(2),path=args.find(a=>!a.startsWith('--'));
    if(!path||args.some(a=>a.startsWith('--')&&a!=='--apply'))throw new Error('task_import_usage');
    const snapshot=JSON.parse(await readFile(path,'utf8'));
    const config={guildId:process.env.DISCORD_GUILD_ID,forumId:process.env.DISCORD_FORUM_CHANNEL_ID,
      channelIds:(process.env.TASK_ALLOWED_CHANNEL_IDS||'').split(',').map(s=>s.trim()).filter(Boolean)};
    if(![config.guildId,config.forumId,...config.channelIds].every(id=>/^\d{17,20}$/.test(id||'')))throw new Error('task_import_invalid_scope');
    db=await openDatabase();await db.check();
    console.log(JSON.stringify(await importTasks(db,snapshot,config,{apply:args.includes('--apply')})));
  }catch(error){console.error(/^task_import_[a-z_]+$/.test(error.message)?error.message:'task_import_failed');process.exitCode=1;}
  finally{await db?.close();}
}
