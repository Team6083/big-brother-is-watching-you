import {ActionRowBuilder,ButtonBuilder,ButtonStyle,LabelBuilder,ModalBuilder,StringSelectMenuBuilder,TextInputBuilder,TextInputStyle} from 'discord.js';

const pad=n=>String(n).padStart(2,'0');
export function dateOptions(now=Date.now(),page=0) {
  if(!Number.isInteger(page)||page<0||page>11)throw new Error('請重新開啟會議設定。');
  const local=new Date(now+8*3600000),base=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate());
  const first=local.getUTCHours()<17?1:2;
  return Array.from({length:25},(_,n)=>{
    const day=new Date(base+(first+page*25+n)*86400000),value=day.toISOString().slice(0,10);
    return {value,label:`${value}（星期${'日一二三四五六'[day.getUTCDay()]}）`};
  });
}
export function dateControls(id,options,page,selected) {
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('meeting:date:'+id)
    .setPlaceholder('選擇會議日期（台灣時間）').addOptions(options.map(o=>({...o,default:o.value===selected})))),new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`meeting:page:${id}:${page-1}`).setLabel('前 25 天').setStyle(ButtonStyle.Secondary).setDisabled(page===0),
    new ButtonBuilder().setCustomId(`meeting:page:${id}:${page+1}`).setLabel('後 25 天').setStyle(ButtonStyle.Secondary).setDisabled(page===11),
    new ButtonBuilder().setCustomId('meeting:discard:'+id).setLabel('取消設定').setStyle(ButtonStyle.Secondary),
  )];
}
export function timeModal(id,draft) {
  const modal=new ModalBuilder().setCustomId('meeting:times:'+id).setTitle('會議時間與地點（台灣時間）');
  const location=new TextInputBuilder().setCustomId('location').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);
  if(draft.location)location.setValue(draft.location);
  const field=(key,label,count,step,value)=>new LabelBuilder().setLabel(label).setStringSelectMenuComponent(
    new StringSelectMenuBuilder().setCustomId(key).setRequired(true).setMinValues(1).setMaxValues(1).addOptions(
      Array.from({length:count},(_,n)=>({label:key.endsWith('_hour')?`${pad(n)}（${n===0?'午夜':n<6?'凌晨':n<12?'上午':n===12?'中午':n<18?'下午':'晚上'}${n%12||12}點）`:pad(n*step),value:pad(n*step),default:pad(n*step)===value}))));
  modal.addLabelComponents(
    field('start_hour','開始：幾點（24 小時制）',24,1,draft.start?.slice(0,2)),
    field('start_minute','開始：幾分',12,5,draft.start?.slice(3)),
    field('end_hour','結束：幾點（同一天）',24,1,draft.end?.slice(0,2)),
    field('end_minute','結束：幾分',12,5,draft.end?.slice(3)),
    new LabelBuilder().setLabel('地點').setTextInputComponent(location),
  );
  return modal;
}
export function selectedTimes(fields) {
  const value=key=>fields.getStringSelectValues(key)[0];
  const start=value('start_hour')+':'+value('start_minute'),end=value('end_hour')+':'+value('end_minute');
  if(![start,end].every(t=>/^([01]\d|2[0-3]):[0-5][05]$/.test(t)))throw new Error('請重新選擇開始與結束時間。');
  return {start,end};
}
export function previewControls(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('meeting:save:'+id).setLabel('確認儲存').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('meeting:change_date:'+id).setLabel('修改日期').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('meeting:edit:'+id).setLabel('修改時間／地點').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('meeting:discard:'+id).setLabel('取消設定').setStyle(ButtonStyle.Secondary),
  )];
}

export function savedMeetingControls(row,now=Date.now()) {
  return row?.starts_at>now&&['pending','sent','uncertain'].includes(row.status)?[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('meeting:open_edit').setLabel('編輯會議').setStyle(ButtonStyle.Primary),
  )]:[];
}

export function recordControls(id,dates,page=0) {
  if(!Number.isInteger(page) || page<0 || page*25>=dates.length)throw new Error('請重新選擇會議日期。');
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('meeting:record_date:'+id)
    .setPlaceholder('選擇已有的會議日期').addOptions(dates.slice(page*25,page*25+25).map(date=>({label:date,value:date})))),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`meeting:record_page:${id}:${page-1}`).setLabel('上一頁').setStyle(ButtonStyle.Secondary).setDisabled(page===0),
      new ButtonBuilder().setCustomId(`meeting:record_page:${id}:${page+1}`).setLabel('下一頁').setStyle(ButtonStyle.Secondary).setDisabled((page+1)*25>=dates.length),
    )];
}

export function recordModal(id,date,url) {
  const input=new TextInputBuilder().setCustomId('url').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1000);
  if(url)input.setValue(url);
  return new ModalBuilder().setCustomId('meeting:record_submit:'+id).setTitle(date+' 會議記錄')
    .addLabelComponents(new LabelBuilder().setLabel('會議記錄連結（HTTPS）').setTextInputComponent(input));
}
