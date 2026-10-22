// One-off previews only. Scheduled notifications run inside npm start.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {openDatabase} from '../state/database.js';
import {DatabaseFailure,databaseFailure} from '../state/diagnostics.js';
import {collectReport} from './monitor.js';
import {analyze,renderReport} from './report.js';

const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
let state;
try {
  if(args.includes('--watch')||args.includes('--send'))throw new Error('pm_notifications_run_in_main_bot');
  const mode=option('--mode')||'daily';
  if(!['daily','weekly','alerts'].includes(mode))throw new Error('pm_invalid_command');
  const snapshot=option('--snapshot');
  const report=snapshot?analyze(JSON.parse(await readFile(snapshot,'utf8'))):await collectReport(state=await openDatabase());
  const output=option('--output'),text=renderReport(report,mode);
  if(output){await mkdir(dirname(resolve(output)),{recursive:true});await writeFile(output,text,'utf8');console.log('PM preview saved locally.');}
  else console.log(text);
} catch(error){console.error(/^pm_[a-z_]+$/.test(error.message)?error.message:'pm_preview_failed');if(error instanceof DatabaseFailure)console.error(JSON.stringify(databaseFailure(error,'pm_preview_database_failed')));process.exitCode=1;}
finally {await state?.close();}
