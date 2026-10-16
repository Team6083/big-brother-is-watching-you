import {loadConfig} from './config.js';
import {openDatabase} from './state/database.js';
let db;
try {loadConfig();db=await openDatabase();await db.prepare('SELECT thread_id FROM proposals LIMIT 1').all();console.log(JSON.stringify({event:'configuration_and_database_ok'}));}
catch{console.error(JSON.stringify({event:'configuration_or_database_failed'}));process.exitCode=1;}
finally{await db?.close();}
