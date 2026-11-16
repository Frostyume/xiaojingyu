// 心情语音节奏：纯函数闸门，保证「不是每天只一条、也不是天天一堆」。
// 只检查不记账；调用方真正发出后把时间戳 push 进 times。
// 与 voiceBudgetCheck（分钟/小时防刷）叠加使用。
import { shanghaiDayKey } from '../../runtime/kernel/budget.js';

export const MOOD_VOICE_DEFAULTS = Object.freeze({
  enabled: true,
  maxPerDay: 3,
  minGapMs: 5 * 3600 * 1000,
  skipChance: 0.4,
  llm: true,
  // 发完语音后补一句短文字的命中概率；0=永不补，1=每次都补。
  tailChance: 0.6
});

// 一句心情语音最多这么长：短到像随口搭一句，但留得下「由头」。
export const MOOD_VOICE_MAX_CHARS = 24;
// 语音后面那半句续话：只比「嗯」「对啊」多一点点，太长了就不像接话。
export const MOOD_VOICE_TAIL_MAX_CHARS = 20;
// 落盘保留最近多少条文本，供 LLM 与模板共同去重。
export const MOOD_VOICE_RECENT_LIMIT = 20;

// 模板兜底池：每种心情多备几句，挑的时候避开最近说过的，绝不连续重复。
// 每句都先挂一个由头（刚忙完/刚睡醒/熬晚了）或轻社交搭话，绝不裸报心情；
// 心情只影响 TTS 的语气，不决定「说什么」。句子都控制在 MOOD_VOICE_MAX_CHARS 以内。
export const MOOD_VOICE_LINES = Object.freeze({
  happy: Object.freeze([
    '刚忙完手头的事，浮上来跟你们说两句',
    '今天有件小事挺顺，来跟你们唠两句',
    '刚游完一圈回来，正好跟你们聊会儿',
    '嘿，冒个泡，把刚才的好消息说给你们',
    '睡醒伸了个懒腰，来跟你们冒个泡',
    '忙完了，来看看你们在聊什么'
  ]),
  sleepy: Object.freeze([
    '熬到这么晚，脑子还没醒，来跟你们说两句',
    '刚忙完一大摊，有点撑不住，来跟你们说声',
    '今天事有点多，困归困，还是想跟你们说说话',
    '刚从水里爬出来，眼皮打架，来唠两句',
    '哈欠一个接一个，先说两句就去缩着',
    '人有点飘，忙完这阵，来跟你们冒个泡'
  ]),
  pout: Object.freeze([
    '刚才有点小委屈，现在缓过来了，想跟你们说说',
    '刚被人怼了一句，气还没顺，来跟你们吐槽下',
    '本来有点闷，翻完那篇就散了，来唠两句',
    '刚想不理你们，想了想，还是来冒个泡',
    '有点小情绪，忙完这点事来跟你们说说话',
    '哼，刚被晾了一会儿，现在来找你们说话'
  ]),
  idle: Object.freeze([
    '在水里游了一圈，回来看看你们在聊什么',
    '刚翻完那篇讲鲸歌的，正好来跟你们说说',
    '闲下来了，来跟你们冒个泡，别嫌我烦',
    '刚睡醒，脑子还在回神，来唠两句',
    '这会儿没事，想和你们说说话，随便聊聊',
    '游到一半想起你们，上来打个招呼'
  ])
});

// 比较用的归一化：去空白、去末尾标点，避免「…」和「～」换一下就当成新句。
function voiceTextKey(value) {
  return String(value ?? '').replace(/\s+/g, '').replace(/[。．.！!？?~～…]+$/u, '');
}

/**
 * 清洗模型输出：只留第一行，去引号/列表符/emoji，超长或为空直接判不合格。
 * 不截断——截断容易造病句，交给调用方重试或退回模板。
 */
export function cleanMoodVoiceText(raw, maxChars = MOOD_VOICE_MAX_CHARS) {
  const limit = Math.max(4, Math.min(60, Number(maxChars) || MOOD_VOICE_MAX_CHARS));
  const firstLine = String(raw ?? '').replace(/\r/g, '').split('\n').map((t) => t.trim()).find(Boolean) || '';
  const text = firstLine
    .replace(/^【?语音】?[:：]\s*/, '')
    .replace(/^[-*•]\s*/, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, '')
    .trim();
  if (!text || text.length > limit) return '';
  return text;
}

/**
 * 续句清洗：只留第一行、去引号/标签/emoji；超长直接判不合格（不截断，免得留半句话）。
 * 空字符串表示「这句续不上」，调用方只发语音、不报错。
 */
export function cleanMoodVoiceTail(raw, maxChars = MOOD_VOICE_TAIL_MAX_CHARS) {
  const limit = Math.max(4, Math.min(40, Number(maxChars) || MOOD_VOICE_TAIL_MAX_CHARS));
  const firstLine = String(raw ?? '').replace(/\r/g, '').split('\n').map((t) => t.trim()).find(Boolean) || '';
  const text = firstLine
    .replace(/^【?语音】?[:：]\s*/, '')
    .replace(/^[-*•]\s*/, '')
    .replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, '')
    .trim();
  if (!text || text.length > limit) return '';
  return text;
}

/**
 * 群轮换：只接受 group:数字（私聊键一律丢掉），去重后保持传入顺序。
 * 传入的是「当前可用群」的权威列表（allow.groups 过滤后的 group key）。
 */
export function normalizeMoodVoiceGroups(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const id = String(item ?? '').trim().replace(/^group:/, '');
    if (!/^\d+$/.test(id)) continue;
    const key = `group:${id}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * 按游标挑下一个群；越界自动折回，轮完一圈回到第一个。
 * 没有可用群时返回 null，调用方安全跳过（不生成、不发送）。
 */
export function pickMoodVoiceGroup({ groups = [], cursor = 0 } = {}) {
  const list = normalizeMoodVoiceGroups(groups);
  if (!list.length) return null;
  const size = list.length;
  const raw = Number.isFinite(Number(cursor)) ? Math.trunc(Number(cursor)) : 0;
  const index = ((raw % size) + size) % size;
  return { key: list[index], index, nextCursor: (index + 1) % size };
}

/** 这一条语音后面要不要补一句：只按概率判定，不关心内容。 */
export function moodVoiceTailDue({ tailChance = MOOD_VOICE_DEFAULTS.tailChance, rng = Math.random } = {}) {
  const chance = Math.max(0, Math.min(1, Number(tailChance) || 0));
  if (chance <= 0) return false;
  return Number(rng()) < chance;
}

/**
 * 把落盘的 recent 归一成 [{text, at}]，兼容旧版字符串数组；只保留最后 limit 条。
 */
export function normalizeMoodVoiceRecent(raw, limit = MOOD_VOICE_RECENT_LIMIT) {
  const size = Math.max(1, Math.trunc(Number(limit)) || MOOD_VOICE_RECENT_LIMIT);
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const text = cleanMoodVoiceText(typeof item === 'string' ? item : item?.text, 60);
    if (!text) continue;
    const at = Number(typeof item === 'object' && item ? item.at : 0) || 0;
    out.push({ text, at });
  }
  return out.slice(-size);
}

/** 追加一条已发出的语音文本，保留最近 limit 条。 */
export function mergeMoodVoiceRecent(recent, text, at = Date.now(), limit = MOOD_VOICE_RECENT_LIMIT) {
  const clean = cleanMoodVoiceText(text, 60);
  const list = Array.isArray(recent) ? recent : [];
  if (!clean) return normalizeMoodVoiceRecent(list, limit);
  return normalizeMoodVoiceRecent([...list, { text: clean, at: Number(at) || Date.now() }], limit);
}

/**
 * 从模板池挑一句：优先避开最近用过的；全用过时退回最久没用的那句，
 * 保证跟刚刚那条不相同（池子只有一句时无从避开，原样返回）。
 */
export function pickMoodVoiceLine({ mood = '', recent = [], rng = Math.random } = {}) {
  const pool = MOOD_VOICE_LINES[mood] || MOOD_VOICE_LINES.idle;
  const entries = normalizeMoodVoiceRecent(recent, 50);
  const recentKeys = entries.map((entry) => voiceTextKey(entry.text));
  const lastKey = recentKeys[recentKeys.length - 1] || '';
  const draw = (list) => list[Math.min(list.length - 1, Math.max(0, Math.floor(Number(rng()) * list.length)))];
  const fresh = pool.filter((line) => !recentKeys.includes(voiceTextKey(line)));
  if (fresh.length) return draw(fresh);
  const lastSeen = new Map();
  recentKeys.forEach((key, index) => lastSeen.set(key, index));
  const ranked = pool
    .map((line, index) => ({ line, index, seen: lastSeen.has(voiceTextKey(line)) ? lastSeen.get(voiceTextKey(line)) : -1 }))
    .filter((item) => pool.length === 1 || voiceTextKey(item.line) !== lastKey)
    .sort((a, b) => (a.seen - b.seen) || (a.index - b.index));
  if (ranked.length) return ranked[0].line;
  return draw(pool);
}

/**
 * 决定这一条心情语音说什么：LLM 按真实状态现写，校验（非空、长度、近期去重），
 * 不合格带 hint 重试一次；失败、不可用或 llmEnabled=false 时退回模板池。
 * 返回 { text, source: 'llm'|'template' }；generate 由调用方注入，测试里可传假生成器。
 */
export async function resolveMoodVoiceLine({
  mood = '',
  valence = 0,
  energy = 0.6,
  cause = '',
  recent = [],
  llmEnabled = true,
  maxChars = MOOD_VOICE_MAX_CHARS,
  generate = null,
  roleName = '',
  targetKey = '',
  rng = Math.random,
  log = () => {}
} = {}) {
  const entries = normalizeMoodVoiceRecent(recent, MOOD_VOICE_RECENT_LIMIT);
  const recentTexts = entries.map((entry) => entry.text);
  const recentKeys = new Set(recentTexts.map(voiceTextKey));
  if (llmEnabled && typeof generate === 'function') {
    let hint = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await generate({ moodLabel: mood, valence, energy, cause, avoidTexts: recentTexts, hint, roleName, maxChars, targetKey });
        const text = cleanMoodVoiceText(raw, maxChars);
        if (text && !recentKeys.has(voiceTextKey(text))) return { text, source: 'llm' };
        hint = text
          ? '上一版和最近说过的语音太像，换一件此刻真实的小事或换个说法'
          : '上一版为空、太长或含敏感内容，重新写一句更短的';
      } catch (error) {
        log(`LLM 生成失败，退回模板：${error?.message ?? error}`);
        break;
      }
    }
  }
  return { text: pickMoodVoiceLine({ mood, recent: entries, rng }), source: 'template' };
}

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