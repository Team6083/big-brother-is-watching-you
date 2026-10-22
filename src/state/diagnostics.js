// Select controlled metadata only. Driver messages/stacks can contain credentials,
// server addresses, database names, commands and duplicate document values.
export class DatabaseFailure extends Error {
  constructor(code,context,cause) {super(code,{cause});this.context=Object.freeze({...context});}
}

const hints={
  missing_uri:'請注入 MONGODB_URI 環境變數。',
  invalid_uri_scheme:'MONGODB_URI 必須以 mongodb:// 或 mongodb+srv:// 開頭。',
  invalid_uri:'請私下核對連線字串語法、帳密的 URI 編碼與連線選項。',
  invalid_database_name:'URI 路徑的 database 名稱須為 1–63 個英數字、底線或連字號。',
  default_database_forbidden:'請在 URI 路徑填入專用 database 名稱；不可省略或使用 test。',
  authentication_failed:'請私下核對帳密、authSource 與認證方式；不需公開連線字串。',
  authorization_failed:'請確認帳號對 URI 指定的 database 具有 readWrite 權限，並核對 authSource。',
  unsupported_operation:'此操作不被目前環境允許；請核對 MongoDB 版本、部署模式與目標 database。',
  index_conflict:'既有索引與程式定義不一致；請管理員比對規格，本程式不會自動刪除索引。',
  duplicate_key:'唯一索引遇到既有重複資料；請管理員私下核對資料，不會自動刪除或修改。',
  dns_failed:'請從 Bot 容器檢查 DNS／SRV 解析及 DNS 網路政策。',
  connection_refused:'請檢查 MongoDB 服務、連接埠及容器至資料庫的網路路徑。',
  network_failed:'請檢查容器的網路政策、防火牆及所有 replica set 節點的可達性。',
  timeout:'請檢查網路、資料庫負載及 primary 狀態；目前連線／操作已逾時。',
  tls_failed:'請檢查 TLS、CA 掛載、憑證效期與主機名稱；不要關閉憑證驗證。',
  file_access_failed:'請檢查程序的檔案／網路存取權限，以及掛載的 CA 檔案。',
  server_selection_failed:'請檢查 replicaSet 名稱、primary 狀態，以及容器能否連上各節點公布的位址。',
  replica_set_required:'MongoDB 必須是 replica set 或 sharded cluster，才支援交易。',
  indexes_missing:'必要索引缺漏或規格不符；請先執行 npm run migrate。',
  unexpected_error:'非資料庫驅動錯誤；請檢查其他環境設定（例如 Discord 設定），此輸出不含原始訊息。',
  mongodb_error:'請依失敗步驟與 MongoDB 錯誤碼核對資料庫權限、版本及設定。',
};
const mongoCodes=new Map([
  [13,['Unauthorized','authorization_failed']],[18,['AuthenticationFailed','authentication_failed']],
  [20,['IllegalOperation','unsupported_operation']],[50,['MaxTimeMSExpired','timeout']],
  [85,['IndexOptionsConflict','index_conflict']],[86,['IndexKeySpecsConflict','index_conflict']],
  [11000,['DuplicateKey','duplicate_key']],
]);
const systemCodes=new Map([
  ['ENOTFOUND','dns_failed'],['EAI_AGAIN','dns_failed'],['ECONNREFUSED','connection_refused'],
  ['ETIMEDOUT','timeout'],['ETIMEOUT','timeout'],['ECONNRESET','network_failed'],['EHOSTUNREACH','network_failed'],['ENETUNREACH','network_failed'],
  ['ENOENT','file_access_failed'],['EACCES','file_access_failed'],
  ...['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','ERR_TLS_CERT_ALTNAME_INVALID','ERR_TLS_HANDSHAKE_TIMEOUT','ERR_SSL_WRONG_VERSION_NUMBER','ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR'].map(code=>[code,'tls_failed']),
]);
const driverNames=new Set(['MongoServerError','MongoServerSelectionError','MongoNetworkError','MongoNetworkTimeoutError','MongoOperationTimeoutError','MongoParseError','MongoInvalidArgumentError','MongoAPIError','MongoRuntimeError','MongoCompatibilityError','MongoMissingCredentialsError','MongoTopologyClosedError','MongoServerClosedError']);
const stages=new Set(['configuration','connect','ping','list_collections','create_collection','create_index','check','close']);
const topologies=new Set(['Unknown','Single','ReplicaSetNoPrimary','ReplicaSetWithPrimary','Sharded','LoadBalanced']);

export function databaseFailure(error,event='migration_failed') {
  const context=error instanceof DatabaseFailure?error.context:{};
  const nodes=[],pending=[error],seen=new Set(),responses=new Set();
  while(pending.length&&nodes.length<32) {
    const node=pending.shift();
    if(!node||typeof node!=='object'||seen.has(node))continue;
    seen.add(node);nodes.push(node);
    pending.push(node.cause,node.errorResponse,node.reason);
    if(node.errorResponse&&typeof node.errorResponse==='object')responses.add(node.errorResponse);
    if(node.reason?.servers instanceof Map)for(const server of [...node.reason.servers.values()].slice(0,8))pending.push(server.error);
    if(Array.isArray(node.errors))pending.push(...node.errors.slice(0,8));
  }
  // Only server replies carry MongoDB numeric codes; other `code` fields are unrelated.
  const mongo=nodes.find(n=>Number.isInteger(n.code)&&n.code>=0&&n.code<=2147483647&&(n.name==='MongoServerError'||responses.has(n))),system=nodes.find(n=>systemCodes.has(n.code));
  const driver=nodes.find(n=>driverNames.has(n.name)),topology=nodes.find(n=>topologies.has(n.type));
  const known=mongoCodes.get(mongo?.code);
  const reason=Object.hasOwn(hints,context.reason)?context.reason:known?.[1]||systemCodes.get(system?.code)||
    (driver?.name==='MongoServerSelectionError'?'server_selection_failed':/Timeout/.test(driver?.name||'')?'timeout':driver||mongo?'mongodb_error':'unexpected_error');
  return {event,code:error instanceof DatabaseFailure?error.message:driver||mongo?'mongodb_error':'unexpected_error',
    stage:stages.has(context.stage)?context.stage:'unknown',
    ...(context.collection?{collection:context.collection}:{}),...(context.index?{index:context.index}:{}),reason,
    ...(driver?{driver_error:driver.name}:{}),...(mongo?{mongo_code:mongo.code}:{}),...(known?{mongo_code_name:known[0]}:{}),
    ...(system?{system_code:system.code}:{}),...(topology?{topology_type:topology.type}:{}),hint:hints[reason]};
}
export const migrationFailure=error=>databaseFailure(error);
