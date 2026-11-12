// 心情语音节奏：纯函数闸门，保证「不是每天只一条、也不是天天一堆」。
// 只检查不记账；调用方真正发出后把时间戳 push 进 times。
// 与 app/whale.js 的 voiceBudgetCheck（分钟/小时防刷）叠加使用。
import { shanghaiDayKey } from '../../runtime/kernel/budget.js';

export const MOOD_VOICE_DEFAULTS = Object.freeze({
  enabled: true,
  maxPerDay: 3,
  minGapMs: 5 * 3600 * 1000,
  skipChance: 0.4
});

/**
 * @param {object} o
 * @param {number[]} o.times 已发送时间戳
 * @param {number} o.now
 * @param {number} o.maxPerDay 上海自然日内上限
 * @param {number} o.minGapMs 两条之间最小间隔
 * @returns {{ok:true}|{ok:false,reason:'gap'|'daily'}}
 */
export function moodVoiceCadenceOk({
  times = [],
  now = Date.now(),
  maxPerDay = MOOD_VOICE_DEFAULTS.maxPerDay,
  minGapMs = MOOD_VOICE_DEFAULTS.minGapMs
} = {}) {
  const list = (Array.isArray(times) ? times : []).filter((t) => Number.isFinite(Number(t)));
  const last = list.length ? Math.max(...list) : 0;
  if (last && now - last < minGapMs) return { ok: false, reason: 'gap' };
  const day = shanghaiDayKey(now);
  const today = list.filter((t) => shanghaiDayKey(t) === day).length;
  if (today >= maxPerDay) return { ok: false, reason: 'daily' };
  return { ok: true };
}