const begin='<!-- CMSFTC_DISCORD_OWNERS_BEGIN -->';
const end='<!-- CMSFTC_DISCORD_OWNERS_END -->';
const pattern=/<!-- CMSFTC_DISCORD_OWNERS_BEGIN -->\n([\s\S]*?)\n<!-- CMSFTC_DISCORD_OWNERS_END -->/g;
export function discordOwners(desc='') {
  const matches=[...desc.matchAll(pattern)];
  if(!matches.length)return null;
  if(matches.length!==1)throw new Error('task_invalid_owners');
  try {
    const owners=JSON.parse(matches[0][1]);
    if(!Array.isArray(owners)||owners.length>5||owners.some(o=>!/^\d{17,20}$/.test(o.id)||typeof o.name!=='string'))throw Error();
    return owners;
  } catch {throw new Error('task_invalid_owners');}
}
export function withDiscordOwners(desc,owners) {
  discordOwners(desc);
  const block=begin+'\n'+JSON.stringify(owners)+'\n'+end;
  return desc.match(pattern)?desc.replace(pattern,block):desc+'\n\n'+block;
}

const assignerPattern=/<!-- CMSFTC_DISCORD_ASSIGNER_BEGIN -->\n([\s\S]*?)\n<!-- CMSFTC_DISCORD_ASSIGNER_END -->/g;
export function assigneeIds(value) {
  const ids=[...new Set(Array.isArray(value)?value:[value])];
  if(!ids.length||ids.length>5||ids.some(id=>typeof id!=='string'||!/^\d{17,20}$/.test(id)))throw new Error('task_invalid_assigner');
  return ids;
}
export function discordAssigner(desc='') {
  const matches=[...desc.matchAll(assignerPattern)];if(!matches.length)return null;
  try{
    const person=JSON.parse(matches[0][1]),people=Array.isArray(person)?person:[person];
    if(matches.length!==1||!people.length||people.length>5||people.some(p=>!p||!/^\d{17,20}$/.test(p.id)||typeof p.name!=='string'))throw Error();
    return person;
  }
  catch{throw new Error('task_invalid_assigner');}
}
export function withDiscordAssigner(desc,person) {
  discordAssigner(desc);
  // Keep single-person payloads identical so existing pending receipts still reconcile.
  if(Array.isArray(person)&&person.length===1)person=person[0];
  const block='<!-- CMSFTC_DISCORD_ASSIGNER_BEGIN -->\n'+JSON.stringify(person)+'\n<!-- CMSFTC_DISCORD_ASSIGNER_END -->';
  return desc.match(assignerPattern)?desc.replace(assignerPattern,block):desc+'\n\n'+block;
}
