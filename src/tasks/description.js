const pattern=/<!-- CMSFTC_TASK_DESCRIPTION_BEGIN -->\n\*\*任務描述\*\*\n([\s\S]*?)\n<!-- CMSFTC_TASK_DESCRIPTION_END -->/g;
export function taskDescription(desc='') {
  const matches=[...desc.matchAll(pattern)];
  if(matches.length>1 || (!matches.length && /CMSFTC_TASK_DESCRIPTION_(BEGIN|END)/.test(desc)))throw new Error('task_invalid_description_block');
  return matches[0]?.[1] || '';
}
export function withTaskDescription(desc,text) {
  if(typeof text!=='string' || text.length>4000 || /CMSFTC_(DISCORD_|THREAD_ID|TASK_DESCRIPTION_|INTERACTION_ID)/.test(text))throw new Error('task_invalid_description');
  taskDescription(desc);
  const block='<!-- CMSFTC_TASK_DESCRIPTION_BEGIN -->\n**任務描述**\n'+text.trim()+'\n<!-- CMSFTC_TASK_DESCRIPTION_END -->';
  return desc.match(pattern)?desc.replace(pattern,()=>block):desc+'\n\n'+block;
}
