// 北京时间感知：给分享/说说/聊天提示词提供一致的时间锚点和矛盾检查。
//
// 只做纯函数，不读文件、不发消息；调用方负责决定重写还是跳过。

export function beijingParts(ts = Date.now()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(Number(ts) || Date.now()));
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: map.weekday || '',
    hour: Number(map.hour) % 24,
    minute: Number(map.minute) || 0,
    dateKey: `${map.year}-${map.month}-${map.day}`
  };
}

export function timeOfDayLabel(hour) {
  const h = Number(hour) || 0;
  if (h < 5) return '凌晨';
  if (h < 9) return '早上';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 20) return '傍晚';
  if (h < 23) return '晚上';
  return '深夜';
}

export function timeStampCN(ts, now = Date.now()) {
  const p = beijingParts(ts);
  const n = beijingParts(now);
  const hm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  if (p.dateKey === n.dateKey) return hm;
  if (p.year === n.year) return `${p.month}月${p.day}日 ${hm}`;
  return `${p.year}年${p.month}月${p.day}日 ${hm}`;
}

export function currentTimeBlock(now = Date.now()) {
  const p = beijingParts(now);
  const label = timeOfDayLabel(p.hour);
  return [
    `【现在】${p.year}年${p.month}月${p.day}日 ${p.weekday} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}（北京时间，${label}）`,
    '- “现在/刚刚/这会儿/此刻”只能指这个时间，不能把几小时前说成刚刚。',
    '- 提到凌晨/早上/上午/中午/下午/傍晚/晚上/深夜或具体钟点时，必须和真实时间或素材里的时间戳一致；拿不准就写“今天/刚才/前几天”，不要凭感觉编时段。',
    '- 最近群聊、最近说说里的时间词属于当时，不要搬到这条新内容里。'
  ].join('\n');
}

// 只抓“现在/刚刚 + 时段”这种直接自相矛盾的写法；“今天早上发生的事”这类过去时留给提示词判断。
export function timeConflict(text, now = Date.now()) {
  const raw = String(text ?? '');
  const m = raw.match(/(现在|刚刚|刚|这会儿|此刻)[^。！？\n]{0,12}(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|深夜|半夜)/)
    || raw.match(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|深夜|半夜)[^。！？\n]{0,10}(现在|刚刚|这会儿|此刻)/);
  if (!m) return '';
  const said = /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|深夜|半夜)/.exec(m[0])?.[1] || '';
  const nowLabel = timeOfDayLabel(beijingParts(now).hour);
  if (!said || said === nowLabel) return '';
  if (nowLabel === '深夜' && said === '晚上') return '';
  return `写着“${m[0]}”，但现在是${nowLabel}`;
}
