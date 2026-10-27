import {ActionRowBuilder,ButtonBuilder,ButtonStyle,LabelBuilder,ModalBuilder,SlashCommandBuilder,StringSelectMenuBuilder,TextInputBuilder,TextInputStyle,UserSelectMenuBuilder} from 'discord.js';
import {assigneeIds} from './owners.js';

export const createTaskCommand=new SlashCommandBuilder().setName('建立任務').setDescription('在隊長／幹部頻道建立任務；人員、日期與狀態用選的')
  .addStringOption(o=>o.setName('核對編號').setDescription('僅核對先前結果不明的建立操作，不會再次建卡').setRequired(false));
export const safeTaskText=value=>String(value||'').replace(/@/g,'＠').replace(/[<>`]/g,' ');
export const taskTemplate='工作內容：\n\n完成標準：\n\n參考資料／連結（沒有可填「無」）：\n';
const button=(action,id,label,style=ButtonStyle.Secondary)=>new ButtonBuilder().setCustomId(`create_task:${action}:${id}`).setLabel(label).setStyle(style);
const row=(...components)=>new ActionRowBuilder().addComponents(...components);

export function createTaskModal(id,draft) {
  const text=(key,label,max,style,value)=>new LabelBuilder().setLabel(label).setTextInputComponent(
    new TextInputBuilder().setCustomId(key).setStyle(style).setRequired(true).setMaxLength(max).setValue(value));
  const owners=new UserSelectMenuBuilder().setCustomId('owners').setMinValues(1).setMaxValues(5).setRequired(true);
  if(draft.input?.ids?.length)owners.setDefaultUsers(draft.input.ids);
  return new ModalBuilder().setCustomId('create_task:details:'+id).setTitle('建立任務').addLabelComponents(
    text('title','任務名稱',100,TextInputStyle.Short,draft.input?.title||'新任務'),
    text('description','任務描述：工作內容、完成標準、參考資料',4000,TextInputStyle.Paragraph,draft.input?.description||taskTemplate),
    new LabelBuilder().setLabel('Owner（任務負責人，最多 5 位）').setUserSelectMenuComponent(owners),
    new LabelBuilder().setLabel('Assignee（被指派的人，最多 5 位）').setUserSelectMenuComponent(new UserSelectMenuBuilder().setCustomId('assignee').setMinValues(1).setMaxValues(5).setRequired(true).setDefaultUsers(assigneeIds(draft.input?.assigner||draft.actor))),
    new LabelBuilder().setLabel('狀態').setStringSelectMenuComponent(new StringSelectMenuBuilder().setCustomId('status').setMinValues(1).setMaxValues(1).setRequired(true)
      .addOptions(draft.lists.map(l=>({label:l.name.slice(0,100),value:l.id,default:l.id===draft.input?.status})))),
  );
}

export function createTaskPreview(id,draft) {
  const input=draft.input;
  return {content:'【建立任務預覽｜尚未建立】\n'+safeTaskText(input.title)+'\nOwner：'+input.ids.map(v=>'<@'+v+'>').join(' ')+
    '\nAssignee：'+assigneeIds(input.assigner).map(v=>'<@'+v+'>').join(' ')+'\n開始：'+(input.start||'未設定')+'｜截止：'+(input.due||'未設定')+
    '\n狀態：'+safeTaskText(draft.lists.find(l=>l.id===input.status)?.name)+'\n日期採台灣時間；截止為當日 23:59。',
    embeds:[{description:safeTaskText(input.description)}],components:[row(
      button('start',id,'選擇開始日期'),button('due',id,'選擇截止日期'),button('edit',id,'修改內容／人員／狀態'),
      button('save',id,'確認建立',ButtonStyle.Success),button('cancel',id,'取消'),
    )],allowedMentions:{parse:[]}};
}

export function taskDateCursor(field,value,now=Date.now()) {
  if(!['start','due'].includes(field))throw new Error('create_invalid_date');
  const date=new Date(value?value+'T00:00:00Z':now+8*3600000),year=date.getUTCFullYear();
  return {field,year,month:date.getUTCMonth()+1,page:date.getUTCDate()>25?1:0,firstYear:year-2};
}

export function taskDateControls(id,cursor) {
  const {year,month,page,firstYear}=cursor;
  if(!Number.isInteger(year)||year<firstYear||year>firstYear+24||!Number.isInteger(month)||month<1||month>12||![0,1].includes(page))throw new Error('create_invalid_date');
  const count=new Date(Date.UTC(year,month,0)).getUTCDate();
  if(page*25>=count)throw new Error('create_invalid_date');
  const select=(key,placeholder,options)=>row(new StringSelectMenuBuilder().setCustomId(`create_task:${key}:${id}`).setPlaceholder(placeholder).addOptions(options));
  return [
    select('year','選擇年',Array.from({length:25},(_,n)=>({label:String(firstYear+n)+' 年',value:String(firstYear+n),default:firstYear+n===year}))),
    select('month','選擇月',Array.from({length:12},(_,n)=>({label:String(n+1)+' 月',value:String(n+1),default:n+1===month}))),
    select('day',`${year} 年 ${month} 月：選擇日`,Array.from({length:Math.min(25,count-page*25)},(_,n)=>{
      const day=page*25+n+1,value=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      return {label:`${day} 日（星期${'日一二三四五六'[new Date(value+'T00:00:00Z').getUTCDay()]}）`,value};
    })),
    row(button('previous',id,'1–25 日').setDisabled(page===0),button('next',id,'26 日以後').setDisabled(page===1||count<=25),button('clear',id,'清除這個日期'),button('back',id,'返回預覽')),
  ];
}

export function creationCheckControls(id) {return [row(button('check',id,'核對建立結果',ButtonStyle.Primary))];}
