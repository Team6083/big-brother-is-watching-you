export function taskConfig(env=process.env) {
  const mode=env.TASK_MANAGEMENT_MODE || '';
  const roleIds=(env.TASK_MANAGER_ROLE_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (!['','forum','roles'].includes(mode) || roleIds.some(id=>!/^\d{17,20}$/.test(id)) || (mode==='roles' && !roleIds.length)) throw new Error('task_invalid_management_policy');
  return {enabled:env.TASK_CONTROLS_ENABLED==='true',mode,roleIds,
    boardId:env.TRELLO_BOARD_ID,key:env.TRELLO_API_KEY,token:env.TRELLO_WRITE_TOKEN};
}

export function trelloTasks(config,{fetchImpl=fetch}={}) {
  if (!/^[a-zA-Z0-9]{8}$|^[a-f0-9]{24}$/i.test(config.boardId || '') ||
      !/^[a-zA-Z0-9]+$/.test(config.key || '') || !/^[a-zA-Z0-9]+$/.test(config.token || '')) throw new Error('task_missing_write_config');
  async function request(path,method='GET',data,timeoutMs=15000) {
    const url=new URL(`https://api.trello.com/1${path}`);
    let response;
    try {
      response=await fetchImpl(url,{method,redirect:'error',signal:AbortSignal.timeout(timeoutMs),
        headers:{Authorization:`OAuth oauth_consumer_key="${config.key}", oauth_token="${config.token}"`,'content-type':'application/json'},
        ...(data?{body:JSON.stringify(data)}:{})});
    } catch { throw new Error('task_trello_unconfirmed'); }
    if(!response.ok) { await response.body?.cancel();throw new Error(response.status>=400&&response.status<500?'task_trello_rejected':'task_trello_unconfirmed'); }
    try{return await response.json();}catch{throw new Error('task_trello_unconfirmed');}
  }
  return {
    board:()=>request(`/boards/${config.boardId}?fields=id,closed`),
    lists:()=>request(`/boards/${config.boardId}/lists?fields=id,idBoard,name,closed`),
    members:({timeoutMs=15000}={})=>request(`/boards/${config.boardId}/members?fields=id,fullName,username`,'GET',undefined,timeoutMs),
    card:id=>request(`/cards/${id}?fields=id,idBoard,idList,idMembers,name,desc,start,due,shortUrl,closed`),
    update:(id,patch)=>request(`/cards/${id}`,'PUT',patch),
    create:payload=>request('/cards','POST',payload),
    async cardsForThread(threadId) {
      const cards=await request(`/boards/${config.boardId}/cards/all?fields=id,idBoard,idList,idMembers,name,desc,start,due,shortUrl,closed`);
      if(!Array.isArray(cards))throw new Error('task_trello_unconfirmed');
      return cards.filter(card=>new RegExp(`(?:^|\\n)CMSFTC_THREAD_ID\\s*=\\s*${threadId}(?:\\s|$)`).test(card.desc||''));
    },
    progress:(id,text)=>request(`/cards/${id}/actions/comments`,'POST',{text}),
    async comments(id,since) {
      const actions=[];let before;
      for(let page=0;page<20;page++) {
        const params=new URLSearchParams({filter:'commentCard',since,limit:'1000',...(before?{before}:{})});
        const batch=await request(`/cards/${id}/actions?${params}`);
        if(!Array.isArray(batch))throw new Error('task_trello_unconfirmed');
        actions.push(...batch);if(batch.length<1000)return actions;
        const cursor=batch.at(-1)?.id;if(!cursor||cursor===before)throw new Error('task_trello_unconfirmed');before=cursor;
      }
      throw new Error('task_trello_unconfirmed');
    },
  };
}
