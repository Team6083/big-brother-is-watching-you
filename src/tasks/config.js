import {teamChannelAccessEnabled} from './scope.js';

export function taskConfig(env=process.env) {
  const mode=env.TASK_MANAGEMENT_MODE || '';
  const roleIds=(env.TASK_MANAGER_ROLE_IDS || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (!['','forum','roles'].includes(mode) || roleIds.some(id=>!/^\d{17,20}$/.test(id)) || (mode==='roles' && !roleIds.length)) throw new Error('task_invalid_management_policy');
  return {enabled:env.TASK_CONTROLS_ENABLED==='true',mode,roleIds,teamChannelAccess:teamChannelAccessEnabled(env)};
}
