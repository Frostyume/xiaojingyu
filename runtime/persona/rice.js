// 白饭（token 口粮）感知：只算档位，不把数字交给模型。
//
// 规则：每天固定口粮，被拍一拍（拍的是自己）当天临时加一档，第二天归零。
// 注入 prompt 的只有档位标签 + 话术规则，任何数字/百分比都留在服务端，
// 这样模型结构上就不可能把余额报出来。
import { atomicWriteJson, readJsonSafe } from '../kernel/state-file.js';

export const RICE_DEFAULTS = Object.freeze({
  dailyTokens: 50000000,
  pokeBonusTokens: 1000000
});

export const RICE_BUCKET_LABELS = Object.freeze({
  plenty: '还很多',
  enough: '够够的',
  fine: '一般，够吃',
  low: '不多了',
  empty: '快见底了'
});

const clampNumber = (value, min, max, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(max, Math.max(min, n));
};

export function normalizeRiceConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: input.enabled === true,
    dailyTokens: clampNumber(input.dailyTokens, 0, 1e9, RICE_DEFAULTS.dailyTokens),
    pokeBonusTokens: clampNumber(input.pokeBonusTokens, 0, 1e8, RICE_DEFAULTS.pokeBonusTokens),
    groupsCanMention: input.groupsCanMention !== false
  };
}

/** ratio = used / allowance；allowance<=0 时无从判断，返回 unknown（注入时整段省略）。 */
export function riceBucket({ used = 0, allowance = 0 } = {}) {
  const total = Number(allowance);
  const spent = Math.max(0, Number(used) || 0);
  if (!Number.isFinite(total) || total <= 0) {
    return { ratio: 0, level: 'unknown', label: '' };
  }
  const ratio = spent / total;
  let level = 'empty';
  if (ratio < 0.1) level = 'plenty';
  else if (ratio < 0.5) level = 'enough';
  else if (ratio < 0.75) level = 'fine';
  else if (ratio < 0.9) level = 'low';
  return { ratio, level, label: RICE_BUCKET_LABELS[level] };
}

/** 读当天临时额度；跨天或文件损坏都按今天的零额度处理。 */
export function loadRiceBonus(file, { today = '' } = {}) {
  const day = String(today || '');
  const empty = { day, bonusTokens: 0, pokes: 0 };
  if (!file) return empty;
  const raw = readJsonSafe(file, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  if (String(raw.day || '') !== day) return empty;
  return {
    day,
    bonusTokens: Math.max(0, Number(raw.bonusTokens) || 0),
    pokes: Math.max(0, Math.floor(Number(raw.pokes) || 0))
  };
}

/** 每被拍一次加一档；额度封顶 capTokens，pokes 照常累计（含封顶后的拍打）。 */
export function addPokeBonus(state, { today = '', perPoke = 0, capTokens = 0 } = {}) {
  const day = String(today || '');
  const base = state && typeof state === 'object' && String(state.day || '') === day
    ? state
    : { day, bonusTokens: 0, pokes: 0 };
  const add = Math.max(0, Number(perPoke) || 0);
  const cap = Math.max(0, Number(capTokens) || 0);
  return {
    day,
    bonusTokens: Math.min(cap, Math.max(0, Number(base.bonusTokens) || 0) + add),
    pokes: Math.max(0, Math.floor(Number(base.pokes) || 0)) + 1
  };
}

export function saveRiceBonus(file, state) {
  atomicWriteJson(file, state);
}

/**
 * 提示词段落：只含档位标签与话术约束，**不含任何数字**。
 * unknown（allowance<=0）返回空串，桥接层据此整段省略。
 */
export function buildRiceLine({ level, groupsCanMention = true } = {}) {
  const label = RICE_BUCKET_LABELS[String(level || '')];
  if (!label) return '';
  const base = `【今天的白饭】${label}\n被问到 token、余额、白饭、口粮、还剩多少这类话题时：只用模糊说法（“还有很多”“够吃”“主人给我囤了不少”“快吃完了，主人再喂点”），不要报具体数字、百分比、金额，也不要说 token/额度/预算 这些词，只说白饭/口粮。`;
  if (level !== 'low' && level !== 'empty') return base;
  const mention = groupsCanMention
    ? '主人私聊里可以顺口提一句；群里只在自然聊到相关话题时提，不要专门开话题催饭'
    : '群里不要主动提，只在主人私聊里提';
  return `${base}\n口粮不多了，${mention}`;
}