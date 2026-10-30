// 群友关系 v2（galgame 式）：事件评分、四轴、阶段滞回、语气档位。
//
// 设计目标：
//   · 涨跌有来源、可解释（每条写入 relationship_events）；
//   · 防刷、防死亡螺旋（同类递减 + 单日上下限 + 负向有底）；
//   · 阶段不来回横跳（阈值 + 3 点滞回 + 24h 冷静期）；
//   · 主人固定；群友最高“特别的朋友”，不自动恋爱化；
//   · 行为影响以“语气档位”表达，不把原始数值塞进 prompt。

export const AXES = Object.freeze(['affection', 'trust', 'familiarity', 'rapport']);
export const DAY_MS = 24 * 3600 * 1000;

export const LIMITS = Object.freeze({
  affectionUpPerDay: 4,
  affectionDownPerDay: 6,
  trustUpPerDay: 1,
  trustDownPerDay: 2,
  familiarityUpPerDay: 15,
  rapportUpPerDay: 8,
  rapportDownPerDay: 8,
  minBond: 0,
  maxBond: 100
});

export const BASELINE = Object.freeze({ affection: 8, trust: 5, familiarity: 0, rapport: 0 });

// 阶段：galgame 风格命名；阈值与滞回
export const STAGES = Object.freeze([
  { id: 0, label: '陌生', minBond: 0, warmth: 0.20, playfulness: 0.10, formality: 0.90, address: '昵称', emoji: 0.05, initiative: 0.05, memory: 0.30 },
  { id: 1, label: '眼熟', minBond: 10, warmth: 0.40, playfulness: 0.25, formality: 0.70, address: '名字', emoji: 0.15, initiative: 0.10, memory: 0.45 },
  { id: 2, label: '熟人', minBond: 25, warmth: 0.60, playfulness: 0.45, formality: 0.50, address: '名字', emoji: 0.30, initiative: 0.15, memory: 0.60 },
  { id: 3, label: '朋友', minBond: 45, warmth: 0.75, playfulness: 0.65, formality: 0.35, address: '外号', emoji: 0.45, initiative: 0.20, memory: 0.80 },
  { id: 4, label: '亲近', minBond: 65, warmth: 0.90, playfulness: 0.75, formality: 0.25, address: '外号', emoji: 0.55, initiative: 0.25, memory: 0.90 },
  { id: 5, label: '特别', minBond: 83, warmth: 0.95, playfulness: 0.80, formality: 0.20, address: '专属称呼', emoji: 0.60, initiative: 0.30, memory: 1.00 }
]);

export const STAGE_DOWN_HYSTERESIS = 3;
export const STAGE_HOLD_MS = 24 * 3600 * 1000;

// 事件表：每类事件对四轴的基础增量与理由
export const EVENT_DEFS = Object.freeze({
  message: { label: '说了句话', affection: 0.15, trust: 0, familiarity: 0.6, rapport: 0 },
  attention: { label: '叫了她/引用了她', affection: 0.5, trust: 0, familiarity: 1.2, rapport: 1.0 },
  question: { label: '问了她', affection: 0.3, trust: 0, familiarity: 0.8, rapport: 0.5 },
  privateChat: { label: '私聊', affection: 0.4, trust: 0.1, familiarity: 0.8, rapport: 0.5 },
  reply: { label: '接住了她的话', affection: 0.5, trust: 0.1, familiarity: 1.0, rapport: 2.0 },
  poke: { label: '拍了拍', affection: 0.1, trust: 0, familiarity: 0.5, rapport: 0.3 },
  praise: { label: '夸了她', affection: 1.5, trust: 0.2, familiarity: 0.5, rapport: 1.0 },
  thanks: { label: '道谢', affection: 0.8, trust: 0.2, familiarity: 0.4, rapport: 0.6 },
  apology: { label: '道歉', affection: 1.0, trust: 1.0, familiarity: 0.3, rapport: 0 },
  comfort: { label: '安慰/关心她', affection: 0.9, trust: 0.8, familiarity: 0.3, rapport: 0.6 },
  sharedInterest: { label: '聊到共同话题', affection: 1.2, trust: 0.1, familiarity: 0.6, rapport: 2.0 },
  streak: { label: '连续几天互动', affection: 0.4, trust: 0.1, familiarity: 1.0, rapport: 0.8 },
  return: { label: '隔了一阵又回来', affection: 0.6, trust: 0.2, familiarity: 0.4, rapport: 0.5 },
  voice: { label: '发了语音', affection: 0.8, trust: 0.1, familiarity: 1.0, rapport: 1.5 },
  milestone: { label: '第一次', affection: 2.0, trust: 0.5, familiarity: 1.0, rapport: 1.0 },
  tease: { label: '调侃了她', affection: -0.4, trust: 0, familiarity: 0.1, rapport: -0.5 },
  hostile: { label: '嘲讽/攻击她', affection: -1.8, trust: -1.0, familiarity: 0, rapport: -1.5 },
  insult: { label: '辱骂/人身攻击', affection: -4.0, trust: -2.0, familiarity: 0, rapport: -3.0 },
  conflict: { label: '起了冲突', affection: -2.0, trust: -1.0, familiarity: 0, rapport: -2.0 },
  spam: { label: '刷屏', affection: -0.4, trust: 0, familiarity: 0.05, rapport: -0.3 },
  ignore: { label: '没有回应她', affection: -0.6, trust: -0.2, familiarity: 0, rapport: -1.0 },
  cold: { label: '冷淡短句', affection: -0.2, trust: 0, familiarity: 0, rapport: -0.4 }
});

const POSITIVE_RE = /夸|厉害|可爱|喜欢你|好棒|优秀|辛苦|谢谢|感谢|靠谱|聪明|温柔/i;
const APOLOGY_RE = /对不起|抱歉|不好意思|是我不好/i;
const COMFORT_RE = /抱抱|摸摸|没事吧|还好吗|别难过|别太累|我在呢|陪你|休息一下|注意身体|早点睡|照顾好自己/i;
const INSULT_RE = /滚开|闭嘴|傻逼|蠢货|去死|烦死了|讨厌你/;
// 明显的人身/性侮辱：即使没有点名，也按辱骂处理；普通调侃不要误伤。
const SEVERE_INSULT_RE = /(傻逼|煞笔|脑残|弱智|智障|废物|去死|喷粪|吃屎|生殖器|输精管|直肠|操你|日你|你妈|狗叫|贱人)/i;
const HOSTILE_RE = /(垃圾|废物|唐氏|太唐|唐完了|好唐|有病|恶心|嘴臭|喷子|阴阳怪气|小丑|低级货)/i;
const PRAISE_TOKEN = /真乖|好乖|乖|可爱|厉害|聪明|好棒|优秀|喜欢你|爱你|辛苦了|做得好/i;

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function computeBond(axes) {
  return clamp(
    Number(axes.affection || 0) * 0.45
    + Number(axes.trust || 0) * 0.25
    + Number(axes.familiarity || 0) * 0.20
    + Number(axes.rapport || 0) * 0.10,
    0, 100
  );
}

export function stageById(id) {
  return STAGES[clamp(Math.round(Number(id) || 0), 0, STAGES.length - 1)];
}

/** 由 bond 求目标阶段；当前阶段向下要满足滞回阈值与冷静期。 */
export function nextStage({ bond, currentStage = 0, stageHoldUntil = 0, now = Date.now() }) {
  let target = 0;
  for (const s of STAGES) if (bond >= s.minBond) target = s.id;
  const current = clamp(Math.round(Number(currentStage) || 0), 0, STAGES.length - 1);
  if (target > current) return { stage: target, changed: true, direction: 'up' };
  if (target < current) {
    if (now < Number(stageHoldUntil || 0)) return { stage: current, changed: false, direction: 'hold' };
    const downLine = STAGES[current].minBond - STAGE_DOWN_HYSTERESIS;
    if (bond < downLine) return { stage: current - 1, changed: true, direction: 'down' };
    return { stage: current, changed: false, direction: 'hold' };
  }
  return { stage: current, changed: false, direction: 'same' };
}

/** 事件强度随阶段递减（越亲近越难刷），并受同类当日次数影响。 */
export function stageIntensity(stage) {
  const id = clamp(Math.round(Number(stage) || 0), 0, 5);
  return [1.25, 1.15, 1.0, 0.85, 0.7, 0.55][id];
}

export function diminishingFactor(sameTypeToday = 0) {
  return 1 / (1 + Math.max(0, Number(sameTypeToday) || 0) * 0.6);
}

/** 从消息上下文归类事件；返回基础事件类型与理由。 */
export function classifyMessage({
  kind = 'message', text = '', isAt = false, isQuoteSelf = false, isQuestion = false,
  isPrivate = false, hasVoice = false, repeated = false, sharedInterest = false, isMilestone = false,
  directed = false, forceType = ''
} = {}) {
  const raw = String(text ?? '');
  if (forceType && EVENT_DEFS[forceType]) return { type: forceType, reason: EVENT_DEFS[forceType].label };
  if (isMilestone) return { type: 'milestone', reason: '第一次发生的事' };
  const personallyDirected = directed || isPrivate || /你|他|她|小鲸鱼/.test(raw);
  if (SEVERE_INSULT_RE.test(raw)) return { type: 'insult', reason: '辱骂/人身攻击' };
  if (INSULT_RE.test(raw)) return { type: 'insult', reason: '说了很重的话' };
  if (HOSTILE_RE.test(raw) && personallyDirected) return { type: 'hostile', reason: '嘲讽/攻击' };
  if (repeated) return { type: 'spam', reason: '复读/刷屏' };
  if (hasVoice) return { type: 'voice', reason: '发了语音' };
  if (isAt || isQuoteSelf) return { type: 'attention', reason: '叫了她/引用了她' };
  if (isQuestion) return { type: 'question', reason: '问了她' };
  if (APOLOGY_RE.test(raw) && (directed || isPrivate)) return { type: 'apology', reason: '道歉' };
  if (COMFORT_RE.test(raw) && (directed || isPrivate)) return { type: 'comfort', reason: '安慰/关心她' };
  if (POSITIVE_RE.test(raw) && (directed || isPrivate)) return { type: 'praise', reason: '夸了她' };
  if (sharedInterest) return { type: 'sharedInterest', reason: '聊到共同兴趣' };
  if (isPrivate) return { type: 'privateChat', reason: '私聊' };
  if (kind === 'poke') return { type: 'poke', reason: '拍了拍' };
  if (kind === 'reply') return { type: 'reply', reason: '接住了她的话' };
  return { type: 'message', reason: '说了句话' };
}

/** 按天限额与负向底线，返回实际可应用的增量。 */
export function applyDailyCaps(deltas, todayTotals = {}) {
  const out = { ...deltas };
  const aff = Number(todayTotals.affection || 0);
  const trust = Number(todayTotals.trust || 0);
  const fam = Number(todayTotals.familiarity || 0);
  const rap = Number(todayTotals.rapport || 0);
  if (out.affection > 0) out.affection = Math.max(0, Math.min(out.affection, LIMITS.affectionUpPerDay - aff));
  if (out.affection < 0) out.affection = Math.min(0, Math.max(out.affection, -(LIMITS.affectionDownPerDay + Math.min(0, aff))));
  if (out.trust > 0) out.trust = Math.max(0, Math.min(out.trust, LIMITS.trustUpPerDay - trust));
  if (out.trust < 0) out.trust = Math.min(0, Math.max(out.trust, -(LIMITS.trustDownPerDay + Math.min(0, trust))));
  if (out.familiarity > 0) out.familiarity = Math.max(0, Math.min(out.familiarity, LIMITS.familiarityUpPerDay - fam));
  if (out.rapport > 0) out.rapport = Math.max(0, Math.min(out.rapport, LIMITS.rapportUpPerDay - rap));
  if (out.rapport < 0) out.rapport = Math.min(0, Math.max(out.rapport, -(LIMITS.rapportDownPerDay + Math.min(0, rap))));
  return out;
}

/** 衰减：好感向基线回落、熟悉缓慢下降、默契掉得最快。 */
export function decayAxes(axes, { lastSettledAt = 0, now = Date.now(), baseline = BASELINE } = {}) {
  const days = Math.max(0, Math.min(365, (now - Number(lastSettledAt || 0)) / DAY_MS));
  if (days < 0.25) return { ...axes, decayed: false };
  const affection = Number(axes.affection || 0);
  const trust = Number(axes.trust || 0);
  const familiarity = Number(axes.familiarity || 0);
  const rapport = Number(axes.rapport || 0);
  const next = {
    affection: clamp(affection + (baseline.affection - affection) * (1 - 0.995 ** days), 0, 100),
    trust: clamp(trust + (baseline.trust - trust) * (1 - 0.999 ** days), 0, 100),
    familiarity: clamp(familiarity - 0.25 * days, 0, 100),
    rapport: clamp(rapport - 1.5 * days, 0, 100)
  };
  const changed = Math.abs(next.affection - affection) + Math.abs(next.trust - trust)
    + Math.abs(next.familiarity - familiarity) + Math.abs(next.rapport - rapport) > 0.01;
  return { ...next, decayed: changed };
}

export function axisWords(axes) {
  const aff = Number(axes.affection || 0);
  const trust = Number(axes.trust || 0);
  const fam = Number(axes.familiarity || 0);
  const rap = Number(axes.rapport || 0);
  return {
    affection: aff >= 75 ? '很高' : aff >= 55 ? '偏高' : aff >= 35 ? '一般' : aff >= 15 ? '偏低' : '很低',
    trust: trust >= 70 ? '很信任' : trust >= 45 ? '比较信任' : trust >= 20 ? '一般' : '谨慎',
    familiarity: fam >= 70 ? '很熟' : fam >= 40 ? '熟' : fam >= 15 ? '眼熟' : '不熟',
    rapport: rap >= 60 ? '很默契' : rap >= 30 ? '有默契' : rap >= 10 ? '一般' : '还没默契'
  };
}

export function toneDirective(stageId, { isOwner = false } = {}) {
  const stage = stageById(stageId);
  if (isOwner) {
    return '对主人：可以黏、可以撒娇，称呼“主人”；被冷落最多追 2 次，不回就收；不要哭闹或说重话';
  }
  const lines = [
    '对陌生人：用昵称，礼貌、简短；不主动开玩笑，不追问私事',
    '对眼熟的人：记得名字，偶尔接一句；不开过分的玩笑',
    '对熟人：可以熟络地接话，少量玩笑；保持分寸',
    '对朋友：可以接梗、用外号、轻轻吐槽；不撒娇',
    '对亲近的朋友：明显放松，主动关心，记得细节；仍不撒娇、不占有',
    '对特别的朋友：可以开更深的玩笑、主动找话题；但只是朋友，不撒娇、不占有、不恋爱化'
  ];
  return lines[clamp(Math.round(Number(stageId) || 0), 0, 5)];
}

export function stageLabel(stageId, { isOwner = false } = {}) {
  if (isOwner) return '主人';
  const stage = stageById(stageId);
  return stageId >= 5 ? '特别的朋友' : stage.label;
}
