// 自动情绪事件：只把「明确冲着机器人说」的少数几类消息映射成心情事件。
// 复用关系模型的 classifyMessage，避免另起一套关键词；普通闲聊一律返回 null。
import { classifyMessage } from './relationship-model.js';

export const AUTO_EVENT_META = Object.freeze({
  praise: { valence: 'positive', arousal: 'up', what: '被夸了一句', cause: '被夸' },
  comfort: { valence: 'positive', arousal: 'down', what: '被安慰/关心', cause: '被安慰' },
  tease: { valence: 'negative', arousal: 'up', what: '被调侃了一句', cause: '被调侃' },
  insult: { valence: 'negative', arousal: 'up', what: '被说了重话', cause: '被凶' },
  conflict: { valence: 'negative', arousal: 'up', what: '起了冲突', cause: '起冲突' },
  neglect: { valence: 'negative', arousal: 'down', what: '被冷落', cause: '被冷落' }
});

const TYPE_MAP = Object.freeze({
  praise: 'praise',
  comfort: 'comfort',
  apology: 'comfort',
  insult: 'insult',
  hostile: 'conflict',
  tease: 'tease',
  ignore: 'neglect',
  cold: 'neglect'
});

// classifyMessage 目前没有 tease 分支；只在明确对着她时做保守补充，避免误伤正常调侃。
const TEASE_RE = /(小?笨蛋|傻乎乎|笨死|好笨|真菜|太菜|摸鱼|偷懒|嫌弃你|嫌弃死)/;
const PRAISE_HINT_RE = /夸|厉害|可爱|好棒|优秀|喜欢|爱你|辛苦/;

export function classifyMoodEvent({
  text = '',
  isAt = false,
  isQuoteSelf = false,
  isPrivate = false,
  namedSelf = false,
  directed = false,
  kind = 'message',
  sourceMessageId = null,
  receivedAt = 0
} = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  const direct = isAt || isQuoteSelf || isPrivate || namedSelf || directed;
  if (!direct) return null;
  // 不把 @/引用传给分类器：attention 会先于 praise/comfort 命中，这里只看正文内容。
  const classified = classifyMessage({
    kind,
    text: raw,
    isAt: false,
    isQuoteSelf: false,
    isPrivate,
    directed: true
  });
  let type = TYPE_MAP[classified.type] || '';
  if (!type && TEASE_RE.test(raw) && !PRAISE_HINT_RE.test(raw)) type = 'tease';
  if (!type) return null;
  const meta = AUTO_EVENT_META[type];
  if (!meta) return null;
  return {
    type,
    what: meta.what,
    cause: meta.cause,
    valence: meta.valence,
    arousal: meta.arousal,
    intensity: 3,
    auto: true,
    sourceMessageId,
    receivedAt: Number(receivedAt) || 0
  };
}

/**
 * 从某个会话的最近消息里收集自动心情事件。
 * 只读 messageId/seq 做去重，不把原文写进状态或历史。
 */
export function collectAutoMoodEvents(messages, { key = '', since = 0, limit = 6 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const isPrivate = String(key || '').startsWith('private:');
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (!m || m.isSelf) continue;
    const at = Number(m.time) || 0;
    if (since && at <= since) continue;
    // QQ messageId 直接作为去重键，才能和模型手动 qq_mood_nudge 传的 id 对上。
    const msgId = m.messageId != null
      ? String(m.messageId)
      : (m.seq != null ? `${key}:seq:${m.seq}` : `${key}:${at}`);
    if (seen.has(msgId)) continue;
    seen.add(msgId);
    const event = classifyMoodEvent({
      text: m.plain ?? m.text ?? '',
      isAt: m.atSelf === true,
      isQuoteSelf: m.quoteSelf === true || m.quoteTargetIsSelf === true,
      isPrivate,
      namedSelf: m.namedSelf === true,
      directed: m.directed === true || m.addressedTo === 'self',
      kind: 'message',
      sourceMessageId: msgId,
      receivedAt: at
    });
    if (event) out.push(event);
  }
  out.sort((a, b) => a.receivedAt - b.receivedAt);
  return out.slice(0, Math.max(1, Number(limit) || 6));
}
