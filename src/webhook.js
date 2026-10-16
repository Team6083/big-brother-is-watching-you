import { SyncError } from './errors.js';

export function validateAck(body, threadId) {
  if (body?.status !== 'succeeded' || body.thread_id !== threadId ||
      !/^[a-f\d]{24}$/i.test(body.trello_card_id || '') ||
      typeof body.trello_card_url !== 'string') return false;
  try {
    const url = new URL(body.trello_card_url);
    return url.protocol === 'https:' && url.hostname === 'trello.com' && !url.port &&
      !url.username && !url.password && !url.search && !url.hash &&
      /^\/c\/[a-zA-Z0-9]{8}(?:\/[a-zA-Z0-9_%\-]*)?$/.test(url.pathname);
  } catch { return false; }
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new SyncError('make_unconfirmed');
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65_536) throw new SyncError('make_response_too_large');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new SyncError('make_unconfirmed'); }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function sendProposal(proposal, config, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  try {
    const response = await fetchImpl(config.webhookUrl, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'content-type': 'application/json', 'idempotency-key': proposal.thread_id,
        ...(config.webhookApiKey ? { 'x-make-apikey': config.webhookApiKey } : {}),
      },
      body: JSON.stringify(proposal),
    });
    if (!response.ok) {
      const seconds = Number(response.headers.get('retry-after'));
      await response.body?.cancel();
      throw new SyncError(`make_http_${response.status}`, [408, 429].includes(response.status) || response.status >= 500,
        Number.isFinite(seconds) ? Math.min(3_600_000, Math.max(0, seconds * 1_000)) : 0);
    }
    const ack = await readJson(response);
    if (response.status !== 200 || !validateAck(ack, proposal.thread_id)) throw new SyncError('make_unconfirmed');
    return { status: ack.status, thread_id: ack.thread_id, trello_card_id: ack.trello_card_id, trello_card_url: ack.trello_card_url };
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError('make_network_or_timeout');
  }
}
