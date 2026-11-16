// 对话级收件人归因（L1）：在“这条消息 @ 了谁”之上，结合最近几轮谁在跟谁说话，
// 判断“这句话到底在对谁说”。纯函数，不读配置、不调网络、不写状态。
//
// 归因结果 addressee：
//   self | user:<QQ> | all | group | unknown
// 打分（高者优先）：
//   @她 / 引用她 / 称呼她        1.00
//   回答她刚提的问题             0.85
//   @别人 / 引用别人             1.00 / 0.95
//   两人旁支（无第三人插入）      0.70
//   「你/您」按上一句收件人消解   0.62~0.65
//   纯提问但没点名               0.40
//   其余（群广播/没有明确对象）   0.20

import { matchSelfCallName } from './addressedness.js';

const HISTORY_LIMIT = 40;
const PARTICIPANT_LIMIT = 30;
const ALIAS_LIMIT = 8;
const SIDE_THREAD_WINDOW_MS = 10 * 60 * 1000;
const SELF_QUESTION_WINDOW_MS = 15 * 60 * 1000;

const QUESTION_RE = /[?？]|(吗|呢|么|咋|怎么|为什么|为啥|哪|几|多少|是不是|要不要|能不能|可不可以)\s*$/;
const YOU_RE = /(你|您)/;
const PRIVATE_KEY_RE = /^private:\d+$/;

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function lower(value) {
  return String(value ?? '').trim().toLowerCase();
}

function isPrivateKey(key) {
  return PRIVATE_KEY_RE.test(String(key ?? ''));
}

function normalizeUserId(value) {
  const id = String(value ?? '').trim();
  return /^\d{1,12}$/.test(id) ? id : '';
}

function emptyThread(key = '') {
  return {
    key: String(key ?? ''),
    participants: [],
    history: [],
    alias: {},
    lastAddressee: '',
    lastSpeakerId: '',
    lastSpeakerName: '',
    lastIncomingAt: 0,
    lastSelfAt: 0,
    openQuestion: null,
    lastSelfAsk: null,
    sideThread: null,
    selfAddressForms: {},
    updatedAt: 0
  };
}

function boundedList(value, limit) {
  return Array.isArray(value) ? value.slice(-limit) : [];
}

/** 从持久化状态恢复；坏数据一律降级为空结构，不抛错。 */
export function normalizeThread(raw, key = '') {
  const base = emptyThread(key || raw?.key || '');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const thread = {
    ...base,
    key: String(raw.key || key || ''),
    participants: boundedList(raw.participants, PARTICIPANT_LIMIT)
      .filter((p) => p && typeof p === 'object' && normalizeUserId(p.userId))
      .map((p) => ({
        userId: normalizeUserId(p.userId),
        name: clean(p.name, 40),
        lastAt: Number(p.lastAt) || 0,
        count: Math.max(0, Number(p.count) || 0)
      })),
    history: boundedList(raw.history, HISTORY_LIMIT)
      .filter((h) => h && typeof h === 'object')
      .map((h) => ({
        seq: Number.isSafeInteger(Number(h.seq)) ? Number(h.seq) : null,
        userId: h.isSelf === true ? 'self' : normalizeUserId(h.userId),
        sender: clean(h.sender, 40),
        isSelf: h.isSelf === true,
        addressee: typeof h.addressee === 'string' ? h.addressee.slice(0, 24) : '',
        confidence: Math.max(0, Math.min(1, Number(h.confidence) || 0)),
        evidence: Array.isArray(h.evidence) ? h.evidence.slice(0, 6).map((e) => clean(e, 60)) : [],
        textTail: clean(h.textTail, 80),
        at: Number(h.at) || 0
      })),
    alias: {},
    lastAddressee: typeof raw.lastAddressee === 'string' ? raw.lastAddressee.slice(0, 24) : '',
    lastSpeakerId: String(raw.lastSpeakerId ?? '').slice(0, 24),
    lastSpeakerName: clean(raw.lastSpeakerName, 40),
    lastIncomingAt: Number(raw.lastIncomingAt) || 0,
    lastSelfAt: Number(raw.lastSelfAt) || 0,
    openQuestion: raw.openQuestion && typeof raw.openQuestion === 'object'
      ? {
        seq: Number.isSafeInteger(Number(raw.openQuestion.seq)) ? Number(raw.openQuestion.seq) : null,
        at: Number(raw.openQuestion.at) || 0,
        text: clean(raw.openQuestion.text, 120)
      }
      : null,
    lastSelfAsk: raw.lastSelfAsk && typeof raw.lastSelfAsk === 'object'
      ? {
        seq: Number.isSafeInteger(Number(raw.lastSelfAsk.seq)) ? Number(raw.lastSelfAsk.seq) : null,
        at: Number(raw.lastSelfAsk.at) || 0,
        text: clean(raw.lastSelfAsk.text, 120)
      }
      : null,
    sideThread: raw.sideThread && typeof raw.sideThread === 'object'
      && normalizeUserId(raw.sideThread.a) && normalizeUserId(raw.sideThread.b)
      ? {
        a: normalizeUserId(raw.sideThread.a),
        b: normalizeUserId(raw.sideThread.b),
        lastSeq: Number.isSafeInteger(Number(raw.sideThread.lastSeq)) ? Number(raw.sideThread.lastSeq) : null,
        lastAt: Number(raw.sideThread.lastAt) || 0
      }
      : null,
    selfAddressForms: {},
    updatedAt: Number(raw.updatedAt) || 0
  };
  if (raw.alias && typeof raw.alias === 'object' && !Array.isArray(raw.alias)) {
    for (const [id, names] of Object.entries(raw.alias).slice(-PARTICIPANT_LIMIT)) {
      const uid = normalizeUserId(id);
      if (!uid || !Array.isArray(names)) continue;
      const list = names.map((n) => clean(n, 40)).filter(Boolean).slice(-ALIAS_LIMIT);
      if (list.length) thread.alias[uid] = [...new Set(list)];
    }
  }
  if (raw.selfAddressForms && typeof raw.selfAddressForms === 'object' && !Array.isArray(raw.selfAddressForms)) {
    for (const [id, entry] of Object.entries(raw.selfAddressForms).slice(-PARTICIPANT_LIMIT)) {
      const uid = normalizeUserId(id);
      const form = clean(entry?.form, 40);
      if (!uid || !form) continue;
      thread.selfAddressForms[uid] = {
        form,
        count: Math.max(1, Number(entry?.count) || 1),
        lastAt: Number(entry?.lastAt) || 0
      };
    }
  }
  return thread;
}

export function createThread(key = '') {
  return emptyThread(key);
}

/** 本会话里 QQ → 可读名字（最近一次出现优先）。 */
export function aliasNameFor(thread, userId) {
  const uid = normalizeUserId(userId);
  if (!uid || !thread) return '';
  const fromAlias = Array.isArray(thread.alias?.[uid]) ? thread.alias[uid][thread.alias[uid].length - 1] : '';
  if (fromAlias) return fromAlias;
  const hit = [...(thread.history || [])].reverse().find((h) => !h.isSelf && h.userId === uid && h.sender);
  return hit?.sender || '';
}

function matchedSelfName(text, names) {
  const lowerText = lower(text);
  if (!lowerText) return '';
  let best = '';
  for (const name of Array.isArray(names) ? names : []) {
    const token = lower(name);
    if (!token) continue;
    if (lowerText.includes(token) && token.length > best.length) best = String(name).trim();
  }
  return best;
}

function lastMessage(thread) {
  return Array.isArray(thread?.history) && thread.history.length
    ? thread.history[thread.history.length - 1]
    : null;
}

function sideThreadActive(thread, now) {
  const side = thread?.sideThread;
  if (!side) return null;
  if (now - (Number(side.lastAt) || 0) > SIDE_THREAD_WINDOW_MS) return null;
  return side;
}

function makeResult(seq, addressee, confidence, evidence, extra = {}) {
  return {
    seq: Number.isSafeInteger(Number(seq)) ? Number(seq) : null,
    addressee,
    confidence: Number(confidence.toFixed(2)),
    evidence,
    targetUserId: String(addressee).startsWith('user:') ? String(addressee).slice(5) : null,
    ...extra
  };
}

/**
 * 给一条入站消息做归因，并返回更新后的 thread（不修改入参）。
 * @param {object} thread normalizeThread 产物
 * @param {object} message 存储层消息（seq/userId/sender/atSelf/atOthers/atAll/quoteSelf/quoteOther/namedSelf/plain/text/quoted）
 * @param {object} ctx { selfId, selfNames, selfCallNames, statedQuestion, now, isPrivate }
 */
export function attributeMessage(thread, message, ctx = {}) {
  const state = normalizeThread(thread);
  const now = Number(ctx.now) || Date.now();
  const msg = message && typeof message === 'object' ? message : {};
  const seq = Number.isSafeInteger(Number(msg.seq)) ? Number(msg.seq) : null;
  const userId = normalizeUserId(msg.userId);
  const text = String(msg.plain ?? msg.text ?? '');
  const prev = lastMessage(state);
  const evidence = [];
  let result = null;
  let matchedCallForm = '';

  if (ctx.isPrivate === true || isPrivateKey(state.key)) {
    result = makeResult(seq, 'self', 1, ['私聊']);
  } else if (msg.atSelf === true) {
    result = makeResult(seq, 'self', 1, ['@你']);
  } else if (msg.quoteSelf === true || (msg.quoted && msg.quoted.isSelf === true)) {
    const qid = msg.quoted?.seq ?? msg.quoted?.messageId ?? state.lastSelfAsk?.seq;
    result = makeResult(seq, 'self', 1, [qid != null ? `引用你（#${qid}）` : '引用你']);
  } else if ((matchedCallForm = matchedSelfName(text, ctx.selfNames))) {
    result = makeResult(seq, 'self', 1, [`称呼「${matchedCallForm}」`]);
  } else if (Array.isArray(msg.atOthers) && msg.atOthers.length) {
    const first = normalizeUserId(msg.atOthers[0]);
    if (first) {
      const names = msg.atOthers.slice(0, 3).map((id) => aliasNameFor(state, id) || `QQ ${id}`);
      evidence.push(...names.map((n) => `@${n}`));
      result = makeResult(seq, `user:${first}`, 1, evidence);
    }
  } else if (msg.quoteOther === true) {
    const quotedId = normalizeUserId(msg.quoted?.userId)
      || normalizeUserId(msg.quoted?.senderUserId)
      || normalizeUserId(msg.quoted?.senderId);
    if (quotedId) {
      const name = aliasNameFor(state, quotedId) || (msg.quoted?.sender ? clean(msg.quoted.sender, 40) : `QQ ${quotedId}`);
      const qid = msg.quoted?.seq ?? msg.quoted?.messageId;
      result = makeResult(seq, `user:${quotedId}`, 0.95, [qid != null ? `引用#${qid} ${name}` : `引用 ${name}`]);
    } else {
      result = makeResult(seq, 'unknown', 0.7, ['引用了别人但取不到对方 QQ']);
    }
  } else if (msg.atAll === true) {
    result = makeResult(seq, 'all', 0.9, ['@全体成员']);
  } else if ((matchedCallForm = matchSelfCallName(text, ctx.selfCallNames))) {
    result = makeResult(seq, 'self', 1, [`称呼「${matchedCallForm}」`]);
  }

  if (!result && state.openQuestion
    && prev && prev.isSelf === true
    && now - (Number(state.openQuestion.at) || 0) <= SELF_QUESTION_WINDOW_MS) {
    result = makeResult(seq, 'self', 0.85, [`回答你 #${state.openQuestion.seq ?? '刚才'} 的问题`]);
  }

  if (!result && prev && !prev.isSelf && prev.userId && prev.userId !== 'self'
    && prev.userId !== userId && prev.addressee === `user:${userId}`) {
    result = makeResult(seq, `user:${prev.userId}`, 0.78, [`回答 ${prev.sender || `QQ ${prev.userId}`} @ 你的话`]);
  }

  if (!result) {
    const side = sideThreadActive(state, now);
    if (side && userId && (userId === side.a || userId === side.b)) {
      const other = userId === side.a ? side.b : side.a;
      result = makeResult(seq, `user:${other}`, 0.7, [`接${aliasNameFor(state, other) || `QQ ${other}`}的话（两人旁支）`]);
    }
  }

  if (!result && YOU_RE.test(text) && prev) {
    if (prev.isSelf === true) {
      result = makeResult(seq, 'self', 0.62, ['「你」指上一条的你（我）']);
    } else if (prev.userId && prev.userId !== 'self' && prev.userId !== userId) {
      result = makeResult(seq, `user:${prev.userId}`, 0.65, [`「你」指上一条的${prev.sender || `QQ ${prev.userId}`}`]);
    } else if (prev.addressee) {
      const addressee = prev.addressee;
      result = makeResult(seq, addressee, 0.55, ['沿用上一条的收件人']);
    }
  }

  if (!result) {
    const isQuestion = ctx.statedQuestion === true || QUESTION_RE.test(text.trim());
    result = isQuestion
      ? makeResult(seq, 'unknown', 0.4, ['提问但没点名'])
      : makeResult(seq, 'group', 0.2, ['没有明确对象']);
  }

  // 记录对话线索：谁在说话、上一条是谁、两人旁支是否持续。
  const nextHistory = [
    ...state.history,
    {
      seq,
      userId: userId || '',
      sender: clean(msg.sender, 40),
      isSelf: false,
      addressee: result.addressee,
      confidence: result.confidence,
      evidence: result.evidence,
      textTail: clean(text, 80),
      at: now
    }
  ].slice(-HISTORY_LIMIT);
  state.history = nextHistory;
  state.lastAddressee = result.addressee;
  state.lastSpeakerId = userId;
  state.lastSpeakerName = clean(msg.sender, 40);
  state.lastIncomingAt = now;
  state.updatedAt = now;

  if (userId) {
    const alias = state.alias[userId] || [];
    const sender = clean(msg.sender, 40);
    if (sender && !alias.includes(sender)) alias.push(sender);
    state.alias[userId] = alias.slice(-ALIAS_LIMIT);
    const p = state.participants.find((item) => item.userId === userId);
    if (p) {
      p.lastAt = now;
      p.count += 1;
      if (sender) p.name = sender;
    } else {
      state.participants.push({ userId, name: sender, lastAt: now, count: 1 });
      state.participants = state.participants.slice(-PARTICIPANT_LIMIT);
    }
  }

  if (matchedCallForm && userId) {
    const prevForm = state.selfAddressForms[userId];
    state.selfAddressForms[userId] = {
      form: matchedCallForm,
      count: (Number(prevForm?.count) || 0) + 1,
      lastAt: now
    };
  }

  if (result.addressee === 'self' && state.openQuestion) state.openQuestion = null;

  const currentImplicit = result.addressee === 'group' || result.addressee === 'unknown';
  const prevImplicit = prev && (prev.addressee === 'group' || prev.addressee === 'unknown');
  const explicitReply = prev && prev.userId && result.addressee === `user:${prev.userId}`;
  const prevAddressedMe = prev && userId && prev.addressee === `user:${userId}`;
  if (!prev || prev.isSelf === true || (!prevImplicit && !prevAddressedMe)) {
    state.sideThread = null;
  } else if (userId && prev.userId && prev.userId !== 'self' && prev.userId !== userId && (currentImplicit || explicitReply)) {
    const existing = sideThreadActive(state, now);
    const samePair = existing && ((existing.a === prev.userId && existing.b === userId)
      || (existing.a === userId && existing.b === prev.userId));
    state.sideThread = samePair
      ? { ...existing, lastSeq: seq, lastAt: now }
      : { a: prev.userId, b: userId, lastSeq: seq, lastAt: now };
  } else if (userId && prev.userId === userId && currentImplicit) {
    const existing = sideThreadActive(state, now);
    state.sideThread = existing ? { ...existing, lastSeq: seq, lastAt: now } : null;
  } else {
    state.sideThread = null;
  }

  return { result, thread: state };
}

/** 机器人自己发话：更新历史与“刚才是不是提了问题”。 */
export function recordSelfMessage(thread, { texts = [], seq = null, at = null } = {}) {
  const state = normalizeThread(thread);
  const now = Number(at) || Date.now();
  const text = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '')).join(' ').trim();
  if (text) {
    state.history.push({
      seq: Number.isSafeInteger(Number(seq)) ? Number(seq) : null,
      userId: 'self',
      sender: 'self',
      isSelf: true,
      addressee: '',
      confidence: 1,
      evidence: [],
      textTail: clean(text, 80),
      at: now
    });
    state.history = state.history.slice(-HISTORY_LIMIT);
    const asks = QUESTION_RE.test(text.trim());
    if (asks) {
      const entry = { seq: Number.isSafeInteger(Number(seq)) ? Number(seq) : null, at: now, text: clean(text, 120) };
      state.openQuestion = entry;
      state.lastSelfAsk = entry;
    }
  }
  state.lastSelfAt = now;
  state.lastSpeakerId = 'self';
  state.lastSpeakerName = 'self';
  state.sideThread = null;
  state.updatedAt = now;
  return state;
}

/** 三档投递闸门。globalActivity: active | diving | deep。 */
export function deliveryTier({ result, thread, activity = 'diving', topicRelevant = false, isPrivate = false } = {}) {
  if (isPrivate || result?.addressee === 'self') {
    if (isPrivate || (result?.confidence ?? 0) >= 0.8) return 'must_reply';
  }
  const side = sideThreadActive(thread, Date.now());
  const addressee = String(result?.addressee || '');
  if (addressee === 'self') return 'may_join';
  if (addressee === 'all') {
    return activity === 'active' && !side ? 'may_join' : 'observe';
  }
  if (addressee.startsWith('user:')) return 'observe';
  if (addressee === 'unknown') {
    return activity === 'active' && !side ? 'may_join' : 'observe';
  }
  // group：只有全局活跃 + 话题相关 + 没有明确旁支时才允许“可加入”。
  return activity === 'active' && topicRelevant && !side ? 'may_join' : 'observe';
}

/** 是否会拦住“泛监听/概率”以外的候选唤醒；供桥接层组装最终 reason。 */
export function gateAllowsAmbient(tier) {
  return tier === 'must_reply' || tier === 'may_join';
}

export function displayNameFor(userId, sender, messages = []) {
  const uid = normalizeUserId(userId);
  const name = clean(sender, 40) || (uid ? `QQ ${uid}` : '未知');
  if (!uid) return name;
  const idsByName = new Map();
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || msg.isSelf) continue;
    const id = normalizeUserId(msg.userId);
    const senderName = clean(msg.sender, 40);
    if (!id || !senderName) continue;
    if (!idsByName.has(senderName)) idsByName.set(senderName, new Set());
    idsByName.get(senderName).add(id);
  }
  const sameName = idsByName.get(name);
  return sameName && sameName.size > 1 ? `${name}(${uid})` : name;
}

function addresseeLabel(addressee, { selfLabel, thread, messages }) {
  const value = String(addressee || '');
  if (value === 'self') return selfLabel;
  if (value.startsWith('user:')) {
    const uid = value.slice(5);
    const name = aliasNameFor(thread, uid);
    return displayNameFor(uid, name || `QQ ${uid}`, messages);
  }
  if (value === 'all') return '群里全体';
  if (value === 'group') return '群里';
  return '不明确';
}

/** 一条消息的“谁 → 谁（依据）”标签；off 时返回空串由调用方跳过。 */
export function describeMessage(message, { selfLabel = '我', thread = null, messages = [] } = {}) {
  if (!message || typeof message !== 'object') return '';
  const seq = Number.isSafeInteger(Number(message.seq)) ? `#${message.seq}` : '#?';
  const address = message.addressing;
  const from = message.isSelf
    ? selfLabel
    : displayNameFor(message.userId, message.sender, messages);
  if (message.isSelf) {
    const to = message.replyToSender || thread?.lastIncomingSenderName || '群里';
    return `${seq} ${from} → ${to}: ${clean(message.plain ?? message.text, 120)}`;
  }
  if (!address) return `${seq} ${from}: ${clean(message.plain ?? message.text, 120)}`;
  const to = addresseeLabel(address.addressee, { selfLabel, thread, messages });
  const tags = Array.isArray(address.evidence) && address.evidence.length
    ? `（${address.evidence.slice(0, 2).join('，')}）`
    : '';
  return `${seq} ${from} → ${to}${tags}: ${clean(message.plain ?? message.text, 120)}`;
}

/**
 * 唤醒提示里的结构化对话块：逐条标出“谁 → 谁”，并明确本轮该回哪些。
 * 返回 '' 表示没有可展示内容（调用方保持旧 prompt 逐字不变）。
 */
export function renderAddressingBlock({
  messages = [],
  thread = null,
  selfLabel = '我',
  selfUserId = '',
  triggerSeq = null,
  targetSeqs = null,
  maxLines = 8
} = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && typeof m === 'object');
  if (!list.length) return '';
  const visible = list.slice(-Math.max(1, Math.min(20, Number(maxLines) || 8)));
  const lines = visible.map((m) => describeMessage(m, { selfLabel, thread, messages: list })).filter(Boolean);
  if (!lines.length) return '';
  const allowed = Array.isArray(targetSeqs) ? new Set(targetSeqs.map((seq) => Number(seq))) : null;
  const targets = list.filter((m) => !m.isSelf && m.addressing
    && (m.addressing.addressee === 'self' || m.addressing.tier === 'must_reply')
    && (!allowed || allowed.has(Number(m.seq))));
  const others = list.filter((m) => !m.isSelf && m.addressing
    && m.addressing.addressee !== 'self' && m.addressing.tier !== 'must_reply'
    && Number.isSafeInteger(Number(m.seq)));
  let targetLine = '';
  if (targets.length) {
    const parts = targets.slice(-6).map((m) => `#${m.seq} ${displayNameFor(m.userId, m.sender, list)}`);
    targetLine = `本轮只该回 ${parts.join('、')}`;
    if (others.length) {
      targetLine += `；${others.slice(-4).map((m) => `#${m.seq}`).join('/')} 不是对你说的，别接`;
    }
    targetLine += '。多人时先列 target 计划（每条消息 → 一个人），再用 qq_reply 分别回，每条只回一个目标。';
  } else {
    targetLine = '本轮没有明确对你说的消息；可潜水，不要为了活跃硬接别人的话。';
  }
  const triggerNote = Number.isSafeInteger(Number(triggerSeq))
    ? `（本轮唤醒绑定 #${Number(triggerSeq)}；它才是你该回的那条）`
    : '';
  return `【谁在对谁说】\n${lines.join('\n')}\n${targetLine}${triggerNote ? `\n${triggerNote}` : ''}\n\n`;
}

/** 发送侧：判断本轮 targets；返回 { targets:[seq], messageIds:[], observeSeqs:[] }。 */
export function buildTurnPlan(messages = []) {
  const targets = [];
  const messageIds = [];
  const observeSeqs = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || msg.isSelf) continue;
    const seq = Number(msg.seq);
    if (!Number.isSafeInteger(seq) || seq <= 0) continue;
    const address = msg.addressing;
    if (!address) continue;
    if (address.tier === 'observe') { observeSeqs.push(seq); continue; }
    targets.push(seq);
    if (msg.messageId) messageIds.push(String(msg.messageId));
  }
  return { targets, messageIds, observeSeqs };
}

/** L5：从文本里找出这句话用哪个称呼叫了机器人（最长匹配）。 */
export function selfAddressForm(text, selfNames = []) {
  return matchedSelfName(text, selfNames);
}

export const ADDRESSING_LIMITS = Object.freeze({
  HISTORY_LIMIT,
  PARTICIPANT_LIMIT,
  SIDE_THREAD_WINDOW_MS,
  SELF_QUESTION_WINDOW_MS
});
