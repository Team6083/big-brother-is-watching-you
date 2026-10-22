import {openDatabase,migrate} from './database.js';
import {DatabaseFailure,databaseFailure} from './diagnostics.js';
let db,failure,closeFailure;
try {db=await openDatabase();await migrate(db);}
catch(error) {failure=error;}
finally {try {await db?.close();}catch(error){closeFailure=new DatabaseFailure('mongodb_close_failed',{stage:'close'},error);}}
// A close error must not mask a migration error; after a successful migration it is
// reported on its own because the schema is already applied.
if(failure) {console.error(JSON.stringify(databaseFailure(failure)));process.exitCode=1;}
else if(closeFailure) {console.error(JSON.stringify(databaseFailure(closeFailure,'migration_close_failed')));process.exitCode=1;}
else console.log(JSON.stringify({event:'schema_ready'}));
