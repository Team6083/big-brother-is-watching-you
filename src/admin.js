import {openStore} from './state/queue.js';
import { loadConfig } from './config.js';

let store;
try {
  const [command, id] = process.argv.slice(2);
  if (!['status', 'retry', 'notify', 'enqueue'].includes(command) ||
      (command !== 'status' && !/^\d{17,20}$/.test(id || ''))) {
    console.error('Usage: npm run admin -- status | retry THREAD_ID | notify THREAD_ID | enqueue THREAD_ID');
    process.exitCode = 1;
  } else {
    store = await openStore();
    if (command === 'status') console.table(await store.list());
    else {
      const changed = command === 'enqueue' ? await store.enqueue(id, loadConfig()) : await store.retry(id, command === 'notify');
      console.log(changed ? 'Queued. Bot will process this record.' : 'Unchanged: missing, already recorded, not retryable, or currently leased.');
      if (!changed) process.exitCode = 1;
    }
  }
} catch { console.error('Admin operation failed. Check command, configuration and database access.'); process.exitCode = 1; }
finally { await store?.close(); }
