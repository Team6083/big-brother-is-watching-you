import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { readBoard } from './trello.js';
import { analyze, renderReport } from './report.js';
import { notifyThreads } from './notify.js';
import {openDatabase,acquireProcessLock} from '../state/database.js';
let state,unlock;


const args = process.argv.slice(2);
const option = name => { const index=args.indexOf(name); return index < 0 ? undefined : args[index+1]; };
const mode = option('--mode') || 'daily';
const send = args.includes('--send');
const watch = args.includes('--watch');
const snapshotPath = option('--snapshot');
let stopping = false;
process.once('SIGINT',()=>{stopping=true;});
process.once('SIGTERM',()=>{stopping=true;});
async function run() {
  if (send && (snapshotPath || mode !== 'alerts')) throw new Error('pm_send_requires_live_alerts');
  const snapshot = snapshotPath ? JSON.parse(await readFile(snapshotPath,'utf8')) : await readBoard({
    boardId:process.env.TRELLO_BOARD_ID, key:process.env.TRELLO_API_KEY, token:process.env.TRELLO_READ_TOKEN,
  });
  const report = analyze(snapshot, {ignoredMembers:(process.env.PM_TRELLO_AUTOMATION_MEMBER_IDS || '').split(',').filter(Boolean),
    trustedProgressActions:state?(await state.prepare("SELECT result FROM task_changes WHERE state='succeeded' AND kind='progress'").all()).map(r=>JSON.parse(r.result)?.action_id).filter(Boolean):[]});
  const output = option('--output');
  if (output) {
    await mkdir(dirname(resolve(output)),{recursive:true});
    await writeFile(output,renderReport(report,mode),'utf8');
    console.log('PM preview saved locally.');
  } else if (!send) console.log(renderReport(report,mode));
  if (send) {
    const results = await notifyThreads(report, {
      guildId:process.env.DISCORD_GUILD_ID, forumId:process.env.DISCORD_FORUM_CHANNEL_ID,
      token:process.env.DISCORD_BOT_TOKEN,databaseUrl:process.env.DATABASE_URL,
    });
    console.log(JSON.stringify({event:'pm_scan_completed',results}));
  }
}
try {
  if (!['daily','weekly','alerts'].includes(mode) || (watch && (snapshotPath || !send))) throw new Error('pm_invalid_command');
  if(!snapshotPath){state=await openDatabase();if(send)unlock=await acquireProcessLock(state,'pm:'+process.env.DISCORD_GUILD_ID,()=>{stop();process.exitCode=1;});}
  do {
    try { await run(); }
    catch (error) { console.error(/^pm_[a-z0-9_]+$/.test(error.message)?error.message:'pm_failed'); if(!watch)process.exitCode=1; }
    if (watch && !stopping) {
      // Use wall time so a sleeping computer scans promptly after waking.
      const nextScanAt=Date.now()+60000;
      while (!stopping && Date.now()<nextScanAt) await new Promise(resolve=>setTimeout(resolve,Math.min(1000,nextScanAt-Date.now())));
    }
  } while(watch && !stopping);
} catch(error) { console.error(/^pm_[a-z0-9_]+$/.test(error.message)?error.message:'pm_failed');process.exitCode=1; }

finally {try{await unlock?.();}catch{}await state?.close();clearTimeout(stopTimer);}
