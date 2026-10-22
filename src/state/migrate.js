import {openDatabase,migrate} from './database.js';
import {DatabaseFailure,migrationFailure} from './diagnostics.js';
let db,failure;
try {db=await openDatabase();await migrate(db);}
catch(error) {failure=error;}
finally {try {await db?.close();}catch(error){failure??=new DatabaseFailure('mongodb_close_failed',{stage:'close'},error);}}
if(failure) {console.error(JSON.stringify(migrationFailure(failure)));process.exitCode=1;}
else console.log(JSON.stringify({event:'schema_ready'}));
