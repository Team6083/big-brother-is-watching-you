const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Read only. Credentials remain in headers, never URLs or error messages.
export async function readBoard(config, { fetchImpl = fetch, wait = sleep, now = Date.now() } = {}) {
  if (!/^[a-zA-Z0-9]{8}$|^[a-f0-9]{24}$/i.test(config.boardId || '')) throw new Error('pm_invalid_board');
  if (!/^[a-zA-Z0-9]+$/.test(config.key || '') || !/^[a-zA-Z0-9]+$/.test(config.token || '')) {
    throw new Error('pm_missing_or_invalid_trello_credentials');
  }
  async function get(path, params = {}) {
    const url = new URL(`https://api.trello.com/1/boards/${config.boardId}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetchImpl(url, {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { Authorization: `OAuth oauth_consumer_key="${config.key}", oauth_token="${config.token}"` },
        });
        if (response.ok) return await response.json();
        await response.body?.cancel();
        if (response.status !== 429 && response.status < 500) throw new Error(`pm_trello_http_${response.status}`);
      } catch (error) {
        if (/^pm_trello_http_/.test(error.message)) throw error;
      }
      if (attempt < 2) await wait(1000 * 2 ** attempt);
    }
    throw new Error('pm_trello_unavailable');
  }
  const [board, lists, cards, members] = await Promise.all([
    get('', { fields: 'id,name,url,closed' }),
    get('/lists', { filter: 'all', fields: 'id,name,closed' }),
    get('/cards', { filter: 'all', fields: 'id,name,desc,idList,idMembers,labels,start,due,dueComplete,closed,dateLastActivity,shortUrl' }),
    get('/members', { fields: 'id,fullName,username' }),
  ]);
  if (board.closed || !Array.isArray(lists) || !Array.isArray(cards) || !Array.isArray(members)) throw new Error('pm_invalid_board_data');
  // Bounded history: weekly completions and explicitly marked progress only.
  const actions = [];
  let before;
  const since = new Date(now - 8 * 86400000).toISOString();
  for (let page = 0; page < 20; page++) {
    const batch = await get('/actions', {
      filter: 'commentCard,updateCard:idList,createCard', limit: '1000', since,
      ...(before ? { before } : {}),
    });
    if (!Array.isArray(batch)) throw new Error('pm_invalid_actions');
    actions.push(...batch);
    if (batch.length < 1000) return { board, lists, cards, members, actions, fetched_at: new Date(now).toISOString() };
    const cursor = batch.at(-1)?.id;
    if (!cursor || cursor === before) throw new Error('pm_incomplete_actions');
    before = cursor;
  }
  throw new Error('pm_incomplete_actions');
}
