// Only allow controlled identifiers/codes. Never log exceptions, payloads or URLs.
export function log(event, { thread_id, code, status, attempts, queued } = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, thread_id, code, status, attempts, queued }));
}
