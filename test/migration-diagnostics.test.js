import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseFailure,migrationFailure} from '../src/state/diagnostics.js';
import {openDatabase,migrate} from '../src/state/database.js';

const secret='synthetic-private-value',privateUri=`mongodb://fixture:${secret}@private.invalid/private_database?authSource=private_auth`;
const failure=(name,properties={})=>Object.assign(new Error(privateUri),{name,...properties});
const report=(error,context={stage:'connect'})=>migrationFailure(new DatabaseFailure('mongodb_unavailable',context,error));

test('migration errors distinguish missing URI, invalid syntax, invalid database and default test',async()=>{
  for(const [uri,reason] of [[undefined,'missing_uri'],['','missing_uri'],['https://private.invalid','invalid_uri_scheme'],['mongodb://fixture:secret@','invalid_uri'],['mongodb://localhost/test','default_database_forbidden'],['mongodb://localhost/','default_database_forbidden'],['mongodb://localhost/bad%20name','invalid_database_name']]) {
    await assert.rejects(openDatabase({MONGODB_URI:uri}),error=>{
      const output=migrationFailure(error);assert.equal(error.message,'invalid_mongodb_config');assert.equal(output.stage,'configuration');assert.equal(output.reason,reason);assert.ok(output.hint);return true;
    });
  }
});

test('migration diagnostics identify auth, privileges, conflicting indexes and duplicate keys',()=>{
  for(const [code,reason,name] of [[18,'authentication_failed','AuthenticationFailed'],[13,'authorization_failed','Unauthorized'],[85,'index_conflict','IndexOptionsConflict'],[86,'index_conflict','IndexKeySpecsConflict'],[11000,'duplicate_key','DuplicateKey']]) {
    const output=report(failure('MongoServerError',{code,codeName:secret,keyValue:{secret},command:{privateUri}}));
    assert.equal(output.mongo_code,code);assert.equal(output.mongo_code_name,name);assert.equal(output.reason,reason);assert.equal(output.driver_error,'MongoServerError');
    assert.ok(!JSON.stringify(output).includes(secret));assert.ok(!JSON.stringify(output).includes('private_database'));
  }
});

test('nested topology errors report DNS, connection, TLS and timeout codes without node addresses',()=>{
  for(const [code,reason] of [['ENOTFOUND','dns_failed'],['EAI_AGAIN','dns_failed'],['ECONNREFUSED','connection_refused'],['ECONNRESET','network_failed'],['ETIMEDOUT','timeout'],['CERT_HAS_EXPIRED','tls_failed'],['UNABLE_TO_VERIFY_LEAF_SIGNATURE','tls_failed'],['ENOENT','file_access_failed']]) {
    const root=failure('MongoServerSelectionError',{reason:{type:'ReplicaSetNoPrimary',servers:new Map([['private.invalid:27017',{error:failure('MongoNetworkError',{cause:failure('Error',{code})})}]])}});
    const output=report(root);assert.equal(output.system_code,code);assert.equal(output.reason,reason);assert.equal(output.topology_type,'ReplicaSetNoPrimary');
    assert.ok(!JSON.stringify(output).includes('private.invalid'));assert.ok(!JSON.stringify(output).includes(secret));
  }
});

test('unknown errors retain numeric MongoDB codes but never arbitrary messages, names, string codes or payloads',()=>{
  const error=failure(secret,{code:secret,codeName:secret,stack:privateUri,reason:{type:secret},errorResponse:{code:12345,codeName:secret,errmsg:privateUri}});
  const output=migrationFailure(error);
  assert.equal(output.code,'mongodb_migration_failed');assert.equal(output.stage,'unknown');assert.equal(output.mongo_code,12345);assert.equal(output.reason,'mongodb_error');
  assert.ok(!JSON.stringify(output).includes(secret));assert.equal(output.driver_error,undefined);assert.equal(output.system_code,undefined);
  const cycle=failure('MongoServerSelectionError');cycle.cause=cycle;
  assert.equal(report(cycle).reason,'server_selection_failed');
  assert.equal(report(failure('MongoOperationTimeoutError')).reason,'timeout');
  assert.equal(report(failure('MongoServerError',{code:20})).reason,'unsupported_operation');
});

test('migration failures retain the exact collection operation and index without changing schema behavior',async()=>{
  for(const stage of ['list_collections','create_collection','create_index']) {
    const calls=[];
    const db={database:{listCollections:()=>({toArray:async()=>{if(stage==='list_collections')throw failure('MongoServerError',{code:13});return stage==='create_collection'?[]:[{}];}}),
      createCollection:async()=>{throw failure('MongoServerError',{code:13});}},
      collection:name=>({createIndex:async(fields,options)=>{calls.push({name,fields,options});if(name==='task_members')throw failure('MongoServerError',{code:85});}})};
    await assert.rejects(migrate(db),error=>{
      const output=migrationFailure(error);assert.equal(output.code,'mongodb_migration_failed');assert.equal(output.stage,stage);
      assert.equal(output.collection,stage==='create_index'?'task_members':'proposals');assert.equal(output.index,stage==='create_index'?'member_trello_unique':undefined);
      assert.ok(!JSON.stringify(output).includes(secret));return true;
    });
    if(stage==='create_index')assert.equal(calls[1].options.unique,true);
  }
});

test('NamespaceExists during concurrent collection creation is still ignored',async()=>{
  let indexes=0;
  await migrate({database:{listCollections:()=>({toArray:async()=>[]}),createCollection:async()=>{throw failure('MongoServerError',{code:48});}},collection:()=>({createIndex:async()=>{indexes++;}})});
  assert.equal(indexes,3);
});

test('actual migration CLI returns one safe JSON failure and a nonzero exit status',()=>{
  for(const uri of ['',privateUri.replace('/private_database?','/test?')]) {
    const result=spawnSync(process.execPath,['src/state/migrate.js'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,MONGODB_URI:uri},encoding:'utf8',timeout:15000});
    assert.equal(result.status,1);assert.equal(result.stdout,'');
    const lines=result.stderr.trim().split(/\r?\n/);assert.equal(lines.length,1);
    const output=JSON.parse(lines[0]);assert.equal(output.event,'migration_failed');assert.equal(output.stage,'configuration');assert.ok(output.hint);
    assert.ok(!result.stderr.includes(secret));assert.ok(!result.stderr.includes('private.invalid'));assert.ok(!result.stderr.includes('private_auth'));
  }
});
