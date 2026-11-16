// 注意力 / 发言权模型：纯函数，不读配置、不调网络、不依赖 bridge。
//
// 输入是最近消息（复用 1.0.x 已落库的 addressedTo / atSelf / atOthers / quoteSelf /
// quoteOther / namedSelf）和会话状态，输出：
//   · 当前线程与参与者
//   · 发言权在谁手里
//   · 是否存在旁支对话
//   · 她是否该回复，以及分别回哪几条（messageId/seq/发送者）
//
// 规则顺序：明确点名她 → 回；别人之间的对话 → 默认不回；纯提问但归属 unknown →
// 潜水默认不回；全局活跃时才允许按相关度参与；不打断两人对话。

export const ATTENTION_DEFAULTS = Object.freeze({
  recentWindowMs: 15 * 60 * 1000,
  maxMessages: 30,
  maxTargets: 3,
  participateRelevance: 0.35,
  replyRelevance: 0.25,
  promptChars: 320,
  topicChars: 24
});

const ADDRESS_KINDS = Object.freeze(['self', 'other', 'all', 'unknown']);

function cleanText(value, max = 80) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeTopicList(topics) {
  const list = Array.isArray(topics) ? topics : (topics ? [topics] : []);
  return list
    .map((item) => cleanText(typeof item === 'string' ? item : (item?.text ?? item?.topic), 40))
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeAddress(raw, isPrivate) {
  if (isPrivate) return 'self';
  if (ADDRESS_KINDS.includes(raw?.addressedTo)) return raw.addressedTo;
  if (raw?.atSelf || raw?.quoteSelf || raw?.namedSelf) return 'self';
  if (raw?.atAll) return 'all';
  if ((Array.isArray(raw?.atOthers) && raw.atOthers.length > 0) || raw?.quoteOther) return 'other';
  return 'unknown';
}

export function normalizeAttentionMessage(raw, index = 0, { isPrivate = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const userId = raw.userId !== null && raw.userId !== undefined ? String(raw.userId) : '';
  const sender = cleanText(raw.sender, 40) || userId;
  const seq = raw.seq !== null && raw.seq !== undefined && Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : null;
  const messageId = raw.messageId !== null && raw.messageId !== undefined
    ? String(raw.messageId)
    : (seq !== null ? `seq:${seq}` : `idx:${index}`);
  return {
    index,
    seq,
    messageId,
    userId,
    sender,
    text: String(raw.plain ?? raw.text ?? '').slice(0, 300),
    time: Number(raw.time) || 0,
    isSelf: raw.isSelf === true,
    addressedTo: normalizeAddress(raw, isPrivate),
    atSelf: raw.atSelf === true,
    atOthers: Array.isArray(raw.atOthers) ? raw.atOthers.map(String).filter(Boolean).slice(0, 10) : [],
    atAll: raw.atAll === true,
    quoteSelf: raw.quoteSelf === true,
    quoteOther: raw.quoteOther === true,
    namedSelf: raw.namedSelf === true,
    quoted: raw.quoted && typeof raw.quoted === 'object'
      ? { isSelf: raw.quoted.isSelf === true, userId: String(raw.quoted.userId ?? ''), sender: cleanText(raw.quoted.sender, 40) }
      : null
  };
}

export function isQuestionText(text) {
  const raw = cleanText(text, 300);
  if (!raw) return false;
  if (/[?？]\s*$/.test(raw)) return true;
  if (/(吗|呢|嘛)\s*[。.!！~～]*$/.test(raw)) return true;
  return /(什么|怎么|为什么|为啥|哪儿|哪里|哪个|谁|多少|几点|几个|如何|能不能|可不可以|是不是|有没有|对不对|要不要|行不行)/.test(raw);
}

function normalizeForGrams(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function gramSet(text) {
  const raw = normalizeForGrams(text);
  const set = new Set();
  for (let i = 0; i < raw.length - 1; i += 1) set.add(raw.slice(i, i + 2));
  return set;
}

/** 话题相关度 0~1：与进行中话题的 2-gram 重合。只在内部用，不写进 prompt。 */
export function attentionRelevance(text, topics = []) {
  const grams = gramSet(text);
  if (!grams.size) return 0;
  const topicGrams = new Set();
  for (const topic of normalizeTopicList(topics)) {
    for (const gram of gramSet(topic)) topicGrams.add(gram);
  }
  if (!topicGrams.size) return 0;
  let shared = 0;
  for (const gram of grams) if (topicGrams.has(gram)) shared += 1;
  return Math.min(1, shared / Math.max(3, Math.min(10, grams.size)));
}

function userKey(message) {
  return message.userId || `name:${message.sender}`;
}

function uniqueByUser(messages) {
  const out = [];
  const seen = new Set();
  for (const message of messages) {
    const key = userKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(message);
  }
  return out;
}

/** 最后一段“别人 vs 别人”的两人对话；第三人插话后不再算旁支。 */
function detectSideConversation(timeline) {
  let lastSelf = -1;
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    if (timeline[i].isSelf) { lastSelf = i; break; }
  }
  const after = timeline.slice(lastSelf + 1).filter((m) => !m.isSelf);
  if (after.length < 2) return { active: false, participants: [] };
  const tail = after.slice(-6);
  const users = [...new Set(tail.map(userKey))];
  if (users.length !== 2) return { active: false, participants: [] };
  const hasInterpersonal = tail.some((m) => m.addressedTo === 'other'
    || (m.quoted && !m.quoted.isSelf && m.quoted.userId)
    || (m.atOthers && m.atOthers.length > 0));
  if (!hasInterpersonal) return { active: false, participants: [] };
  return {
    active: true,
    participants: uniqueByUser(tail).map((m) => ({ userId: m.userId, name: m.sender }))
  };
}

function buildThread(windowMessages, incoming, topics) {
  const participants = uniqueByUser(incoming).map((m) => ({
    userId: m.userId,
    name: m.sender,
    lastSeq: m.seq
  }));
  const first = windowMessages[0];
  const last = windowMessages[windowMessages.length - 1];
  return {
    topic: normalizeTopicList(topics)[0] || '',
    startSeq: first?.seq ?? null,
    lastSeq: last?.seq ?? null,
    participants
  };
}

function floorHolderOf(timeline) {
  const last = [...timeline].reverse().find(Boolean);
  if (!last) return null;
  if (last.isSelf) return { kind: 'self', name: '你' };
  return { kind: 'person', userId: last.userId, name: last.sender };
}

function pickTargets(directMessages, maxTargets) {
  // 同一个人连发多条时只回最后一条；不同人分别回，保证一人一个 messageId。
  const byUser = new Map();
  for (const message of directMessages) {
    byUser.set(userKey(message), message);
  }
  return [...byUser.values()]
    .slice(-Math.max(1, Number(maxTargets) || 3))
    .map((message) => ({
      messageId: message.messageId,
      seq: message.seq,
      sender: message.sender,
      userId: message.userId,
      addressedTo: message.addressedTo,
      reason: 'addressed-self'
    }));
}

function silent(reason, base) {
  return {
    ...base,
    decision: 'silent',
    shouldReply: false,
    mustReply: false,
    targets: [],
    reason
  };
}

function reply(reason, targets, base) {
  return {
    ...base,
    decision: 'reply',
    shouldReply: true,
    mustReply: true,
    targets,
    reason
  };
}

function maybe(reason, target, base) {
  return {
    ...base,
    decision: 'maybe',
    shouldReply: true,
    mustReply: false,
    targets: target ? [{
      messageId: target.messageId,
      seq: target.seq,
      sender: target.sender,
      userId: target.userId,
      addressedTo: target.addressedTo,
      reason
    }] : [],
    reason
  };
}

/**
 * @param {object} input
 * @param {Array} input.messages 最近消息（旧→新）
 * @param {object} [input.session]
 * @param {string} [input.session.key] group:xxx / private:xxx
 * @param {boolean} [input.session.isPrivate]
 * @param {'active'|'diving'} [input.session.mode]
 * @param {'active'|'diving'} [input.session.globalActivity]
 * @param {Array} [input.session.activeTopics]
 * @param {number} [input.now]
 * @param {object} [input.config]
 */
export function decideAttention({ messages = [], session = {}, now = Date.now(), config = {} } = {}) {
  const cfg = { ...ATTENTION_DEFAULTS, ...(config ?? {}) };
  const key = String(session.key ?? session.chatKey ?? '');
  const isPrivate = session.isPrivate === true || key.startsWith('private:');
  const groupActive = session.globalActivity !== undefined
    ? session.globalActivity === 'active'
    : session.mode === 'active';
  const topics = normalizeTopicList(session.activeTopics);

  const normalized = (Array.isArray(messages) ? messages : [])
    .map((message, index) => normalizeAttentionMessage(message, index, { isPrivate }))
    .filter(Boolean);
  const inWindow = (message) => !message.time
    || Number(now) - message.time <= Math.max(60 * 1000, Number(cfg.recentWindowMs) || ATTENTION_DEFAULTS.recentWindowMs);
  const timeline = normalized.filter(inWindow).slice(-Math.max(4, Number(cfg.maxMessages) || 30));
  const incoming = timeline.filter((message) => !message.isSelf);

  const thread = buildThread(timeline, incoming, topics);
  const side = detectSideConversation(timeline);
  const base = {
    thread,
    participants: thread.participants,
    floorHolder: floorHolderOf(timeline),
    hasSideConversation: side.active,
    isPrivate,
    addressed: incoming.length ? incoming[incoming.length - 1].addressedTo : 'unknown'
  };

  if (!incoming.length) return silent('no-incoming', base);
  const last = incoming[incoming.length - 1];

  // 她已经在最后一条来信之后发过言：不重复回同一条。
  let lastSelfPos = -1;
  let lastIncomingPos = -1;
  for (let i = 0; i < timeline.length; i += 1) {
    if (timeline[i].isSelf) lastSelfPos = i;
    else lastIncomingPos = i;
  }
  if (lastSelfPos > lastIncomingPos) return silent('already-replied', base);

  // 私聊：对方就是在跟她说话，按最后一条回。
  if (isPrivate) {
    return reply('private', [{
      messageId: last.messageId,
      seq: last.seq,
      sender: last.sender,
      userId: last.userId,
      addressedTo: 'self',
      reason: 'private'
    }], base);
  }

  // 明确点名她：无论是否旁支对话都回；多人分别回。
  const afterSelf = lastSelfPos >= 0 ? timeline.slice(lastSelfPos + 1) : timeline;
  const direct = afterSelf.filter((message) => !message.isSelf
    && (message.addressedTo === 'self' || message.atSelf || message.quoteSelf || message.namedSelf));
  if (direct.length) {
    return reply('addressed-self', pickTargets(direct, cfg.maxTargets), base);
  }

  const relevance = attentionRelevance(last.text, topics);
  const enriched = { ...base, relevance: Number(relevance.toFixed(3)) };

  if (last.addressedTo === 'other') {
    if (side.active) return silent('side-conversation', enriched);
    if (groupActive && relevance >= Number(cfg.participateRelevance)) return maybe('relevant-to-others', last, enriched);
    return silent('others-talking', enriched);
  }

  if (side.active) return silent('side-conversation', enriched);

  if (last.addressedTo === 'all') {
    if (!groupActive) return silent('broadcast-diving', enriched);
    if (relevance >= Number(cfg.participateRelevance)) return maybe('broadcast-relevant', last, enriched);
    return silent('broadcast-low-relevance', enriched);
  }

  if (isQuestionText(last.text)) {
    if (!groupActive) return silent('question-unowned-diving', enriched);
    if (relevance >= Number(cfg.participateRelevance)) return maybe('question-relevant', last, enriched);
    return silent('question-low-relevance', enriched);
  }

  if (!groupActive) return silent('unknown-diving', enriched);
  if (relevance >= Number(cfg.replyRelevance)) return maybe('relevant-chat', last, enriched);
  return silent('low-relevance', enriched);
}

/**
 * 拼给模型看的短片段。只给线程、谁在跟谁说话、是否对她说、建议回不回；
 * 不输出相关度分数、序号或内部字段。
 */
export function attentionPromptFragment(decision, { maxChars = ATTENTION_DEFAULTS.promptChars } = {}) {
  if (!decision || typeof decision !== 'object') return '';
  const participants = (decision.participants || []).map((p) => p.name).filter(Boolean);
  const topic = cleanText(decision.thread?.topic, ATTENTION_DEFAULTS.topicChars);
  const threadLabel = participants.length
    ? `${participants.join('、')}在聊${topic ? `「${topic}」` : ''}`
    : '暂时没有别人说话';

  const targets = decision.targets || [];
  let who = '没有新的消息';
  if (decision.isPrivate && targets.length) {
    who = `${targets[targets.length - 1].sender} 在私聊你`;
  } else if (targets.length) {
    who = `${targets.map((t) => t.sender).join('、')} 在叫你`;
  } else if (decision.addressed === 'other') {
    who = '别人在跟别人说话';
  } else if (decision.addressed === 'all') {
    who = '有人在 @全体';
  } else if (decision.addressed === 'unknown') {
    who = '有人在群里说话，没明确对谁';
  }

  const toYou = decision.addressed === 'self'
    ? '是'
    : (decision.addressed === 'other' ? '否' : '不确定');
  const advice = decision.decision === 'reply'
    ? '回'
    : (decision.decision === 'maybe'
      ? '可以接一句，也可以先看'
      : ({
          'side-conversation': '别插话，他们在聊自己的',
          'others-talking': '先不回，这条不是对你说的',
          'no-incoming': '不用回',
          'question-unowned-diving': '默认不回，继续潜水',
          'unknown-diving': '默认不回，继续潜水',
          'broadcast-diving': '默认不回，继续潜水'
        }[decision.reason] || '先不回，继续潜水'));

  const lines = [
    `【当前线程】${threadLabel}`,
    `【谁在跟谁说话】${who}`,
    `【对你说】${toYou}`,
    `【建议】${advice}`
  ];
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
  return text;
}
