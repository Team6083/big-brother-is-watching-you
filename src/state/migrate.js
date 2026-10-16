import {openDatabase,migrate} from './database.js';
let db;
try {db=await openDatabase();await migrate(db);console.log(JSON.stringify({event:'schema_ready'}));}
catch {console.error(JSON.stringify({event:'migration_failed'}));process.exitCode=1;}
finally {await db?.close();}
