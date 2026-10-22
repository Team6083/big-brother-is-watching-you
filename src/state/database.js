import {MongoClient} from 'mongodb';
import {DatabaseFailure} from './diagnostics.js';

export const collections=['proposals','forum_recovery','task_members','task_changes','task_creations','meetings','meeting_records','meeting_dates','pm_deliveries'];
const transactionOptions={readConcern:{level:'snapshot'},writeConcern:{w:'majority'},readPreference:'primary',maxCommitTimeMS:5000,timeoutMS:15000};

export class MongoDatabase {
  constructor(client) {this.client=client;this.database=client.db();this.mongo=true;}
  collection(name) {
    if(!collections.includes(name))throw new Error('invalid_collection');
    return this.database.collection(name);
  }
  async transaction(callback) {
    const session=this.client.startSession();
    try {return await session.withTransaction(()=>callback(session),transactionOptions);}
    finally {await session.endSession();}
  }
  async check() {
    const hello=await this.database.command({hello:1});
    if(!hello.setName && hello.msg!=='isdbgrid')throw new DatabaseFailure('mongodb_check_failed',{stage:'check',reason:'replica_set_required'});
    for(const [name,index] of [['proposals','_id_'],['task_creations','_id_'],['task_changes','task_one_pending'],['task_members','member_trello_unique'],['meetings','_id_'],['pm_deliveries','_id_']]) {
      const indexes=await this.collection(name).listIndexes().toArray(),found=indexes.find(i=>i.name===index);
      if(!found || (index!=='_id_'&&!found.unique) || index==='task_one_pending'&&found.partialFilterExpression?.state!=='pending')throw new DatabaseFailure('mongodb_check_failed',{stage:'check',reason:'indexes_missing'});
    }
  }
  close() {return this.client.close();}
}

export async function openDatabase(env=process.env) {
  if(typeof env.MONGODB_URI!=='string'||!env.MONGODB_URI.trim())throw new DatabaseFailure('invalid_mongodb_config',{stage:'configuration',reason:'missing_uri'});
  if(!/^mongodb(?:\+srv)?:\/\//.test(env.MONGODB_URI))throw new DatabaseFailure('invalid_mongodb_config',{stage:'configuration',reason:'invalid_uri_scheme'});
  let client;
  try {
    client=new MongoClient(env.MONGODB_URI,{maxPoolSize:8,serverSelectionTimeoutMS:5000,connectTimeoutMS:5000,socketTimeoutMS:15000,timeoutMS:10000,writeConcern:{w:'majority'}});
    if(client.options.dbName==='test')throw new DatabaseFailure('invalid_mongodb_config',{stage:'configuration',reason:'default_database_forbidden'});
    if(!/^[a-zA-Z0-9_-]{1,63}$/.test(client.options.dbName||''))throw new DatabaseFailure('invalid_mongodb_config',{stage:'configuration',reason:'invalid_database_name'});
  } catch(error) {
    await client?.close().catch(()=>{});
    throw error instanceof DatabaseFailure?error:new DatabaseFailure('invalid_mongodb_config',{stage:'configuration',reason:'invalid_uri'},error);
  }
  let stage='connect';
  try {
    await client.connect();
    const state=new MongoDatabase(client);
    stage='ping';await state.database.command({ping:1});
    return state;
  } catch(error) {await client?.close().catch(()=>{});throw new DatabaseFailure('mongodb_unavailable',{stage},error);}
}

export async function migrate(db) {
  // The supplied database readWrite role can create these collections/indexes.
  // No admin command, collection validator, TTL or destructive migration is used.
  const progress={stage:'list_collections'};
  const step=(stage,collection,index,run)=>{Object.assign(progress,{stage,collection,index});return run();};
  try {
    for(const name of collections) {
      if(!(await step('list_collections',name,undefined,()=>db.database.listCollections({name},{nameOnly:true}).toArray())).length) {
        await step('create_collection',name,undefined,async()=>{try {await db.database.createCollection(name);}catch(error){if(error.code!==48)throw error;}});
      }
    }
    for(const [name,fields,options] of [
      ['proposals',{guild_id:1,forum_id:1,next_attempt_at:1,received_at:1},{name:'proposals_due'}],
      ['task_members',{guild_id:1,trello_id:1},{name:'member_trello_unique',unique:true}],
      ['task_changes',{card_id:1},{name:'task_one_pending',unique:true,partialFilterExpression:{state:'pending'}}],
    ]) await step('create_index',name,options.name,()=>db.collection(name).createIndex(fields,options));
  } catch(error) {throw new DatabaseFailure('mongodb_migration_failed',{...progress},error);}
}
