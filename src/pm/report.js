import { discordOwners, discordAssigner } from '../tasks/owners.js';
const DAY = 86400000;
const stages = new Map([
  ['想法', 'idea'], ['想法收集', 'idea'], ['待討論', 'decision'], ['待討論／決策', 'decision'],
  ['待辦事項', 'todo'], ['待執行', 'todo'], ['進行中', 'doing'], ['執行中', 'doing'],
  ['待審核', 'review'], ['待公告', 'announcement'], ['完成', 'done'], ['已完成', 'done'],
]);
const time = value => value ? Date.parse(value) : NaN;
const clean = value => String(value || '').replace(/[\r\n`*<>\[\]]/g, ' ').replace(/@/g, '＠');
// A malformed Discord metadata block on one card must not fail the whole scan.
const metadata = (read, desc) => { try { return read(desc); } catch { return null; } };
const cardUrl = value => /^https:\/\/trello\.com\/c\/[a-zA-Z0-9]{8}(?:\/[^\s]*)?$/.test(value || '') ? value : '';

export function analyze(snapshot, { now = Date.now(), ignoredMembers = [], trustedProgressActions = [] } = {}) {
  if (!snapshot?.board || !Array.isArray(snapshot.cards) || !Array.isArray(snapshot.lists) ||
      !Array.isArray(snapshot.members) || !Array.isArray(snapshot.actions) || !Number.isFinite(time(snapshot.fetched_at))) {
    throw new Error('pm_invalid_snapshot');
  }
  const lists = new Map(snapshot.lists.map(l => [l.id, l]));
  const members = new Map(snapshot.members.map(m => [m.id, m.fullName || m.username]));
  const tasks = snapshot.cards.filter(c => !c.closed && !lists.get(c.idList)?.closed).map(c => {
    const list = lists.get(c.idList);
    if (!list) throw new Error('pm_unknown_list');
    const actions = snapshot.actions.filter(a => a.data?.card?.id === c.id && time(a.date) <= now);
    const latest = filtered => filtered.sort((a,b) => time(b.date) - time(a.date))[0]?.date || null;
    const progress = latest(actions.filter(a => a.type === 'commentCard' &&
      /^\[進度\]/.test(a.data?.text || '') && (trustedProgressActions.includes(a.id) ||
        (members.has(a.idMemberCreator) && !ignoredMembers.includes(a.idMemberCreator)))));
    const completed = latest(actions.filter(a => a.type === 'updateCard' &&
      stages.get(a.data?.listAfter?.name) === 'done' && stages.get(a.data?.listBefore?.name) !== 'done'));
    const created = latest(actions.filter(a => a.type === 'createCard'));
    const stage = stages.get(list.name) || 'unknown';
    const labels = (c.labels || []).map(l => l.name).filter(Boolean);
    const active = ['todo','doing','review','announcement'].includes(stage);
    const due = time(c.due);
    const warnings = [];
    const remaining = due - now;
    const deadlinePhase = active && !c.dueComplete && Number.isFinite(due)
      ? remaining <= 0 ? 'overdue' : remaining <= 3600000 ? '1h' : remaining <= DAY ? '24h' : null
      : null;
    if (deadlinePhase === 'overdue') warnings.push('已逾期');
    if (deadlinePhase === '1h') warnings.push('1 小時內到期');
    if (deadlinePhase === '24h') warnings.push('24 小時內到期');
    if (active && labels.includes('需要協助')) warnings.push('需要協助');
    const owners = metadata(discordOwners, c.desc);
    const threadId = /CMSFTC_THREAD_ID\s*=\s*(\d{17,20})/.exec(c.desc || '')?.[1] || null;
    return {
      task_id: c.id, title: c.name, category: labels, status: list.name, stage,
      owner: owners || (c.idMembers || []).map(id => ({ id, name: members.get(id) || '尚未取得名稱' })),
      discord_owner_ids: owners?.map(o=>o.id) || [],
      assigner: metadata(discordAssigner, c.desc),
      start_date: c.start || null, due_date: c.due || null, created_at: created, updated_at: c.dateLastActivity || null,
      last_progress_update: progress, discord_thread_id: threadId,
      discord_url: /https:\/\/discord\.com\/channels\/\d+\/\d+/.exec(c.desc || '')?.[0] || null,
      trello_card_id: c.id, trello_url: cardUrl(c.shortUrl), priority: null,
      needs_help: labels.includes('需要協助'), review_status: stage === 'review' ? 'pending' : null,
      announcement_status: stage === 'announcement' ? 'pending' : null,
      completed_at: stage === 'done' ? completed : null, active, deadline_phase: deadlinePhase, warnings,
    };
  });
  return {
    fetched_at: snapshot.fetched_at, tasks,
    doing: tasks.filter(t => t.stage === 'doing'), overdue: tasks.filter(t => t.warnings.includes('已逾期')),
    dueSoon: tasks.filter(t => ['24h','1h'].includes(t.deadline_phase)),
    noOwner: tasks.filter(t => t.active && !t.owner.length),
    decision: tasks.filter(t => t.stage === 'decision'), review: tasks.filter(t => t.stage === 'review'),
    announcement: tasks.filter(t => t.stage === 'announcement'),
    newProposals: tasks.filter(t => t.discord_thread_id && time(t.created_at) >= now - DAY),
    weeklyDone: tasks.filter(t => time(t.completed_at) >= now - 7 * DAY),
    unknownProgress: tasks.filter(t => t.stage === 'doing' && !t.last_progress_update),
    unknownStage: tasks.filter(t => t.stage === 'unknown'),
  };
}

export function renderReport(report, mode = 'daily') {
  if (!['daily','weekly','alerts'].includes(mode)) throw new Error('pm_invalid_mode');
  const header = mode === 'weekly' ? 'CMSFTC Mentor 專案週報' : 'Project Manager';
  const date = new Intl.DateTimeFormat('zh-TW', { timeZone:'Asia/Taipei', dateStyle:'short', timeStyle:'short' }).format(new Date(report.fetched_at));
  const lines = [`【${header}】`, `資料截至 ${date}（Asia/Taipei）`];
  const item = t => `- ${clean(t.title).slice(0,100)}`;
  function section(title, tasks) {
    lines.push('', `${title}：${tasks.length}`);
    lines.push(...tasks.slice(0,15).map(item));
    if (tasks.length > 15) lines.push(`另有 ${tasks.length - 15} 項未列出。`);
  }
  if (mode !== 'alerts') {
    lines.push(`進行中：${report.doing.length}｜即將到期：${report.dueSoon.length}｜已逾期：${report.overdue.length}`);
    lines.push(`待決策：${report.decision.length}｜待審核：${report.review.length}｜待公告：${report.announcement.length}`);
    if (mode === 'weekly') { section('最近 7 天完成',report.weeklyDone); section('目前進行中',report.doing); }
    section('未指定負責人的正式工作',report.noOwner);
    if (mode === 'daily') section('最近 24 小時新增提案',report.newProposals);
    section('等待 Mentor 決策',report.decision);
    section('待審核',report.review); section('待公告',report.announcement);
  }
  const warnings = report.tasks.filter(t => t.warnings.length);
  section('需要注意',warnings);
  for (const t of warnings.slice(0,15)) lines.push(`  ${clean(t.title).slice(0,100)}：${t.warnings.join('、')}`);
  if (mode !== 'alerts') {
    lines.push('', `未設定清單分類：${report.unknownStage.length}`);
    if (mode === 'weekly') {
      section('建議下次 Mentor 會議討論', [...new Map([...report.decision,...warnings,...report.noOwner,...report.review,...report.announcement].map(t=>[t.task_id,t])).values()]);
      lines.push('以上是建議議程；分配、期限、優先級、決策及公告由 Mentor 明確決定。');
    }
  }
  return lines.join('\n');
}

export function messageChunks(text) {
  const chunks = [];
  let chunk = '';
  for (const line of text.split('\n')) {
    if (line.length > 1800) throw new Error('pm_report_line_too_long');
    if ((chunk + '\n' + line).length > 1800) { chunks.push(chunk); chunk = ''; }
    chunk += (chunk ? '\n' : '') + line;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
