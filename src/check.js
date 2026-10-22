import {loadConfig} from './config.js';
import {openDatabase} from './state/database.js';
import {databaseFailure} from './state/diagnostics.js';
let db;
try {loadConfig();db=await openDatabase();await db.check();console.log(JSON.stringify({event:'configuration_and_database_ok'}));}
catch(error){console.error(JSON.stringify(databaseFailure(error,'configuration_or_database_failed')));process.exitCode=1;}
finally{await db?.close();}
