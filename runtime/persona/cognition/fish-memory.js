// “鱼的记忆”会话内彩蛋：只生成一句可选提示词，不读写记忆、心情或持久化状态。
//
// 触发条件（全部满足才会返回提示）：
//   · 开关打开；
//   · 非必回消息（@ / 引用自己 / 叫名字 / 私聊视为必回）；
//   · 当前这段会话已持续 3–7 分钟，且最近 2 分钟仍有人说话；
//   · 最近几条消息没有冲突/安慰语义；
//   · 距上一次提示 ≥30 分钟，且同一段会话最多一次；
//   · 低概率（默认 8%）。
//
// 提示只要求“把上一轮一个无关紧要的小细节说成记不太清”，
// 明确保留对方刚说的重点，避免模型真的否认已存事实。

export const FISH_MEMORY_HINT = '【小小走神】这一轮可以带一点刚回过神的感觉：把上一轮一个无关紧要的小细节说成记不太清，再用一句轻轻带过。对方刚说的重点照常有回应，仍以对方说的为准；别编新细节，也别拿这个当借口。';

export const FISH_MEMORY_DEFAULTS = Object.freeze({
  minSessionMs: 3 * 60 * 1000,
  maxSessionMs: 7 * 60 * 1000,
  idleGapMs: 5 * 60 * 1000,
  activeWindowMs: 2 * 60 * 1000,
  minMessages: 3,
  cooldownMs: 30 * 60 * 1000,
  probability: 0.08
});

// 保守匹配：宁可少触发一次，也不在吵架/安慰现场卖萌。
const CONFLICT_RE = /(滚|闭嘴|烦死|别烦|讨厌你|恨你|吵架|吵死|有病|傻[逼比]|去死|凶什么|别说话|少来|恶心|气死|生气|骂你)/;
const COMFORT_RE = /(别难过|不难过|抱抱|安慰|心疼|辛苦你|别怕|没事的|我在呢|陪着你|别哭|乖乖|摸摸头|抱一下|别伤心|会好的)/;

function messageTime(message) {
  const at = Number(message?.time);
  return Number.isFinite(at) && at > 0 ? at : null;
}

function recentMessages(messages, now) {
  return (Array.isArray(messages) ? messages : [])
    .map((m) => ({ message: m, at: messageTime(m) }))
    .filter((item) => item.at != null && item.at <= now + 60 * 1000)
    .sort((a, b) => a.at - b.at);
}

function limitsOf(overrides) {
  return { ...FISH_MEMORY_DEFAULTS, ...(overrides && typeof overrides === 'object' ? overrides : {}) };
}

/**
 * 当前这段会话的起点：最后一个 ≥idleGapMs 的沉默之后的第一条消息。
 * 返回 null 表示没有可用时间戳。
 */
export function conversationAnchor(messages, now = Date.now(), { idleGapMs = FISH_MEMORY_DEFAULTS.idleGapMs } = {}) {
  const list = recentMessages(messages, now);
  if (!list.length) return null;
  let anchor = list[0].at;
  for (let i = 1; i < list.length; i += 1) {
    if (list[i].at - list[i - 1].at >= idleGapMs) anchor = list[i].at;
  }
  return anchor;
}

export function isConflictOrComfort(messages, now = Date.now(), { sessionStartedAt = null, idleGapMs = FISH_MEMORY_DEFAULTS.idleGapMs } = {}) {
  const explicit = Number(sessionStartedAt);
  const anchor = sessionStartedAt != null && Number.isFinite(explicit) && explicit > 0
    ? explicit
    : conversationAnchor(messages, now, { idleGapMs });
  const incoming = recentMessages(messages, now)
    .filter((item) => item.at >= (anchor ?? 0) && !item.message?.isSelf)
    .slice(-4);
  return incoming.some(({ message }) => {
    const text = String(message?.plain ?? message?.text ?? '');
    return CONFLICT_RE.test(text) || COMFORT_RE.test(text);
  });
}

/**
 * 纯函数：返回本轮要注入的提示，或 null。
 *
 * @param {{
 *   key?: string,
 *   now?: number,
 *   messages?: Array<{time?: number, isSelf?: boolean, text?: string, plain?: string}>,
 *   mood?: object|null,
 *   limits?: object,
 *   flags?: {
 *     enabled?: boolean,
 *     mustReply?: boolean,
 *     conflictOrComfort?: boolean,
 *     sessionStartedAt?: number|null,
 *     lastHintAt?: number,
 *     lastSessionAnchor?: number|null,
 *     hintCount?: number,
 *     random?: number|(() => number)
 *   }
 * }} input
 * @returns {string|null}
 */
export function hintForTurn({ key = '', now = Date.now(), messages = [], mood = null, limits = null, flags = {} } = {}) {
  if (flags.enabled !== true) return null;
  if (flags.mustReply === true) return null;
  const L = limitsOf(limits);
  // 心情明显低落或精力耗尽时不卖萌。
  if (mood && Number(mood.valence) <= -0.2) return null;
  if (mood && Number(mood.energy) <= 0.15) return null;

  const lastHintAt = Number(flags.lastHintAt) || 0;
  if (lastHintAt > 0 && now - lastHintAt < L.cooldownMs) return null;

  const explicitAnchor = Number(flags.sessionStartedAt);
  const anchor = flags.sessionStartedAt != null && Number.isFinite(explicitAnchor) && explicitAnchor > 0
    ? explicitAnchor
    : conversationAnchor(messages, now, { idleGapMs: L.idleGapMs });
  if (!Number.isFinite(Number(anchor)) || Number(anchor) <= 0) return null;

  const hintCount = Number(flags.hintCount) || 0;
  const lastAnchor = flags.lastSessionAnchor == null ? null : Number(flags.lastSessionAnchor);
  if (hintCount > 0 && (lastAnchor == null || lastAnchor === Number(anchor))) return null;

  const list = recentMessages(messages, now);
  const inSession = list.filter((item) => item.at >= Number(anchor));
  if (inSession.length < L.minMessages) return null;
  const lastAt = inSession[inSession.length - 1].at;
  if (now - lastAt > L.activeWindowMs) return null;

  const span = now - Number(anchor);
  if (span < L.minSessionMs || span > L.maxSessionMs) return null;

  if (flags.conflictOrComfort === true) return null;
  if (isConflictOrComfort(messages, now, { sessionStartedAt: anchor, idleGapMs: L.idleGapMs })) return null;

  const random = typeof flags.random === 'function' ? Number(flags.random()) : Number(flags.random);
  const roll = Number.isFinite(random) ? random : Math.random();
  if (roll >= L.probability) return null;

  return FISH_MEMORY_HINT;
}