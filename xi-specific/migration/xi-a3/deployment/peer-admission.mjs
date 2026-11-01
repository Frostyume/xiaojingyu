/** Preserve the existing finite peer-AI conversation window. It never changes
 * human @ admission, friends or group membership and does not discard memories.
 */
export function createOwnedPeerAdmission({peerBotIds, maxTurns = 6, windowMinutes = 10, quietHours = {start:'00:00',end:'07:00'}, clock = () => Date.now()} = {}) {
  if (!Array.isArray(peerBotIds) || !peerBotIds.every(id => /^\d{5,15}$/.test(String(id))) || !Number.isSafeInteger(maxTurns) || maxTurns < 1 || !Number.isFinite(windowMinutes) || windowMinutes <= 0) throw new Error('Explicit peer identities and finite window required');
  const peers = new Set(peerBotIds.map(String)), windows = new Map();
  const time = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const minutes = value => { if (!/^\d\d:\d\d$/.test(value)) throw new Error('Invalid quiet interval'); const [h,m]=value.split(':').map(Number); if(h>23||m>59)throw new Error('Invalid quiet interval'); return h*60+m; };
  const start = minutes(quietHours.start), end = minutes(quietHours.end);
  return Object.freeze({evaluate(event) {
    const kind = event?.message_type, sender = String(event?.user_id ?? '');
    if (!['group','private'].includes(kind) || !/^\d{5,15}$/.test(sender)) throw new Error('Trusted QQ sender metadata required');
    const key = kind + ':' + String(kind === 'group' ? event.group_id : sender);
    const now = clock(), allowance = () => ({left:maxTurns,until:now+windowMinutes*60000});
    if (!peers.has(sender)) {
      if (kind === 'group') windows.set(key,allowance());
      return {allowWake:true,reason:'human-admission-unchanged'};
    }
    const current = minutes(time.format(new Date(now)));
    const resting = start < end ? current >= start && current < end : start !== end && (current >= start || current < end);
    if (resting) return {allowWake:false,reason:'peer-bot-resting'};
    if (kind === 'private' && !windows.has(key)) windows.set(key,allowance());
    const window = windows.get(key);
    if (!window || window.left <= 0 || now >= window.until) return {allowWake:false,reason:'peer-bot-conversation-limit'};
    window.left--;
    return {allowWake:true,reason:'bounded-peer-conversation',remaining:window.left,until:window.until};
  }});
}
