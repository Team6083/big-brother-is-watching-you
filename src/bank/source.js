import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export function bankConfig(env=process.env) {
  if(env.BANK_ENABLED&&!['true','false'].includes(env.BANK_ENABLED))throw new Error('bank_invalid_config');
  if(env.BANK_ENABLED!=='true')return {enabled:false};
  let url;
  try {url=new URL(env.BANK_BASE_URL);}catch{throw new Error('bank_invalid_config');}
  const guildId=env.DISCORD_GUILD_ID,channelId=env.BANK_CHANNEL_ID;
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/'||
    ![guildId,channelId].every(id=>/^\d{17,20}$/.test(id||'')))throw new Error('bank_invalid_config');
  return {enabled:true,baseUrl:url.origin,guildId,channelId,sourceKey:createHash('sha256').update(JSON.stringify([url.origin,guildId,channelId])).digest('hex')};
}

export function nextBankCheck(now=Date.now()) {
  const hour=3600000;
  return (Math.floor(now/hour)+1)*hour;
}

const validDate=value=>value===''||/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
export function normalizeMissions(rows,config,now=Date.now()) {
  if(!Array.isArray(rows)||rows.length>10000)throw new Error('bank_invalid_response');
  const ids=new Set(),today=new Date(now+8*3600000).toISOString().slice(0,10);
  return rows.map(row=>{
    if(!row||!Number.isSafeInteger(row.id)||row.id<1||ids.has(row.id)||
      !['title','description','status','startDate','deadline','category','type','rewardType','rewardItem'].every(key=>typeof row[key]==='string')||
      !row.title.trim()||!Number.isFinite(row.reward)||row.reward<0||!validDate(row.startDate)||!validDate(row.deadline))throw new Error('bank_invalid_response');
    ids.add(row.id);
    const open=['進行中','即將截止'].includes(row.status),started=!row.startDate||row.startDate<=today,unexpired=!row.deadline||row.deadline>=today;
    return {id:String(row.id),title:row.title.trim(),description:row.description,category:row.category,type:row.type,
      status:row.status,startDate:row.startDate,deadline:row.deadline,reward:row.reward,rewardType:row.rewardType,rewardItem:row.rewardItem,
      url:config.baseUrl+'/mission/'+row.id,active:open&&started&&unexpired,
      waiting:unexpired&&(['','未發布','即將開始'].includes(row.status)||open&&!started)};
  });
}

async function readJson(response) {
  const reader=response.body?.getReader();if(!reader)throw new Error('bank_invalid_response');
  const chunks=[];let size=0;
  try {
    while(true) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024)throw new Error('bank_invalid_response');chunks.push(value);}
    try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('bank_invalid_response');}
  } finally {await reader.cancel().catch(()=>{});}
}

export async function readMissions(config,{fetchImpl=fetch,wait=ms=>delay(ms,undefined,{signal}),signal,now=Date.now()}={}) {
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const response=await fetchImpl(config.baseUrl+'/api/gas-read?type=missionsList',{method:'GET',redirect:'error',
        signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),headers:{accept:'application/json'}});
      if(!response.ok) {await response.body?.cancel();throw new Error(response.status!==429&&response.status<500?'bank_api_rejected':'bank_api_unavailable');}
      return normalizeMissions(await readJson(response),config,now);
    } catch(error) {
      if(signal?.aborted)throw new Error('bank_stopped');
      if(['bank_invalid_response','bank_api_rejected'].includes(error.message))throw error;
      if(attempt===2)throw new Error('bank_api_unavailable');
      await wait(1000*2**attempt);
    }
  }
}

const safe=(value,max)=>String(value||'').replace(/@/g,'＠').replace(/[<>`]/g,' ').slice(0,max)||'未設定';
export const missionMarker=task=>'FTC-Bank 任務 #'+task.id;
export function missionMessage(task) {
  return {content:'【FTC-Bank 新任務】',embeds:[{title:safe(task.title,256),description:safe(task.description,3000),url:task.url,
    fields:[{name:'分類／類型',value:safe(task.category+'／'+task.type,200)},
      {name:'開始日期',value:task.startDate||'未設定',inline:true},{name:'截止日期',value:task.deadline||'未設定',inline:true},
      {name:'任務獎勵（依網站）',value:safe(task.rewardType==='item'?task.rewardItem:String(task.reward),500)}],footer:{text:missionMarker(task)}}],allowedMentions:{parse:[]}};
}
